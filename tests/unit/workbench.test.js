import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWorkspace, inspectTask, listTasks, taskReport, historicalStatus, readEvidence } from '../../src/index.js';

import { createEvidenceStore } from '../../src/state/evidence-store.js';

test('Task title truncation preserves complete Unicode characters in history', t => {
  const { root, core } = setup(t);
  const prefix = 'a'.repeat(119);
  const task = core.createTask({
    title: ' ' + prefix + '😀 tail ', challenge_type: 'misc', authorized_scope: 'local-only'
  });
  assert.equal(core.taskDetail(task.task_id).title, prefix);
  core.closeTask(task);
  assert.equal(inspectTask(root, task.task_id).title, prefix);
  assert.equal(JSON.parse(taskReport(root, task.task_id)).title, prefix);
});

test('History requires recovery when a completed task has an unresolved dispatch', t => {
  const { root } = setup(t);
  const id = 'ctf-00000000-0000-4000-8000-000000000002';
  const store = createEvidenceStore(root, id);
  store.append('dispatch', { operation_id: 'pending', result_status: 'RUNNING' });
  store.append('state', { result_status: 'COMPLETED' });
  assert.equal(historicalStatus(root, id), 'RECOVERY_REQUIRED');
  const detail = inspectTask(root, id);
  assert.equal(detail.status, 'RECOVERY_REQUIRED');
  assert.equal(detail.recorded_status, 'COMPLETED');
  assert.deepEqual(detail.recovery.unresolved_operations, ['pending']);
  assert.equal(listTasks(root)[0].status, 'RECOVERY_REQUIRED');
});

test('Direct evidence reads reject a redirected task directory', t => {
  const { root } = setup(t);
  const id = 'ctf-00000000-0000-4000-8000-000000000001';
  const otherRoot = join(root, 'separate-root');
  const store = createEvidenceStore(otherRoot, id);
  store.append('state', { result_status: 'COMPLETED' });
  symlinkSync(resolve(otherRoot, id), join(root, id), 'junction');
  assert.throws(() => readEvidence(root, id), /Invalid task evidence chain/);
  assert.equal(historicalStatus(root, id), 'RECOVERY_REQUIRED');
  assert.equal(historicalStatus(otherRoot, id), 'COMPLETED');
});

test('Evidence store refuses to write into a replaced task directory', t => {
  const { root } = setup(t);
  const id = 'ctf-00000000-0000-4000-8000-000000000003';
  const store = createEvidenceStore(root, id);
  const task = join(root, id);
  const moved = join(root, 'moved-task');
  const first = store.append('state', { result_status: 'CREATED' });
  const journal = join(moved, 'evidence.jsonl');
  fs.renameSync(task, moved);
  symlinkSync(resolve(moved), task, 'junction');
  try {
    assert.throws(() => store.append('state', { result_status: 'PREFLIGHT_PENDING' }), /Invalid task evidence chain/);
    assert.throws(() => store.artifact(Buffer.from('fixture')), /Invalid task evidence chain/);
    assert.equal(fs.readFileSync(journal, 'utf8'), JSON.stringify(first) + '\n');
    assert.deepEqual(fs.readdirSync(moved), ['evidence.jsonl']);
  } finally {
    fs.unlinkSync(task);
    fs.renameSync(moved, task);
  }
  assert.equal(store.append('state', { result_status: 'PREFLIGHT_PENDING' }).previous_evidence_id, first.evidence_id);
});

test('Workspace close persists other tasks when an earlier journal cannot be written', t => {
  const { root, core } = setup(t);
  const input = { challenge_type: 'misc', authorized_scope: 'local-only' };
  const damaged = core.createTask(input);
  const healthy = core.createTask(input);
  const journal = join(root, damaged.task_id, 'evidence.jsonl');
  const backup = journal + '.backup';
  fs.renameSync(journal, backup);
  try {
    assert.throws(() => core.close(), { code: 'ENOENT' });
    assert.equal(historicalStatus(root, healthy.task_id), 'INTERRUPTED');
  } finally {
    fs.renameSync(backup, journal);
  }
  core.close();
  assert.equal(historicalStatus(root, damaged.task_id), 'INTERRUPTED');
});

test('History treats blank CRLF lines like blank LF lines', t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(task);
  const journal = join(root, task.task_id, 'evidence.jsonl');
  const records = inspectTask(root, task.task_id).evidence;
  writeFileSync(journal, '\r\n' + records.map(row => JSON.stringify(row)).join('\r\n\r\n') + '\r\n');
  assert.equal(historicalStatus(root, task.task_id), 'INTERRUPTED');
  assert.deepEqual(inspectTask(root, task.task_id).evidence, records);
});

test('Artifact cleanup preserves the original write failure', t => {
  const { root } = setup(t);
  const store = createEvidenceStore(root, 'ctf-00000000-0000-0000-0000-000000000001');
  const writeFailure = new Error('write failed');
  const cleanupFailure = new Error('cleanup failed');
  const write = fs.writeFileSync;
  const writeSpy = t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    write(path, ...args);
    throw writeFailure;
  });
  const unlinkSpy = t.mock.method(fs, 'unlinkSync', () => { throw cleanupFailure; });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.artifact(Buffer.from('fixture')), error =>
      error instanceof AggregateError && error.errors[0] === writeFailure && error.errors[1] === cleanupFailure);
  } finally {
    writeSpy.mock.restore();
    unlinkSpy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Historical status never trusts a broken evidence chain as completed', t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(task);
  const path = join(root, task.task_id, 'evidence.jsonl');
  const invalid = [null, { task_id: task.task_id, evidence_id: 'forged',
    previous_evidence_id: 'missing', timestamp: new Date().toISOString(),
    type: 'state', result_status: 'COMPLETED' }];
  const completed = { ...invalid[1], previous_evidence_id: null };
  const incomplete = { ...completed, previous_evidence_id: completed.evidence_id,
    evidence_id: 'next', type: 'tool_result', result_status: null };
  writeFileSync(path, [completed, incomplete].map(row => JSON.stringify(row)).join('\n'));
  assert.equal(historicalStatus(root, task.task_id), 'RECOVERY_REQUIRED');
  assert.equal(listTasks(root)[0].error_category, 'INVALID_EVIDENCE');
  for (const record of invalid) {
    writeFileSync(path, JSON.stringify(record) + '\n');
    assert.equal(historicalStatus(root, task.task_id), 'RECOVERY_REQUIRED');
  }
  writeFileSync(path, '{broken}\n');
  assert.equal(historicalStatus(root, task.task_id), 'RECOVERY_REQUIRED');
});

test('Malformed evidence timestamps are isolated before task list sorting', t => {
  const { root, core } = setup(t);
  const valid = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  const damaged = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(damaged);
  writeFileSync(join(root, damaged.task_id, 'evidence.jsonl'), JSON.stringify({
    task_id: damaged.task_id, evidence_id: 'bad-time', previous_evidence_id: null,
    type: 'state', result_status: 'COMPLETED', timestamp: 42
  }) + '\n');
  const listed = core.listTasks();
  assert.equal(listed.find(row => row.task_id === valid.task_id).status, 'PREFLIGHT_PASSED');
  assert.equal(listed.find(row => row.task_id === damaged.task_id).error_category, 'INVALID_EVIDENCE');
});

test('Historical status rejects invalid UTF-8 in a complete journal record', t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(task);
  const journal = join(root, task.task_id, 'evidence.jsonl');
  const record = JSON.stringify({
    task_id: task.task_id, evidence_id: 'first', previous_evidence_id: null,
    type: 'state', result_status: 'COMPLETED', timestamp: new Date().toISOString(),
    title: 'INVALID_UTF8'
  });
  const [prefix, suffix] = record.split('INVALID_UTF8');
  writeFileSync(journal, Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix + '\n')]));
  assert.equal(historicalStatus(root, task.task_id), 'RECOVERY_REQUIRED');
  assert.equal(listTasks(root)[0].error_category, 'INVALID_EVIDENCE');
});

function setup(t) {
  const root = mkdtempSync('data/workbench-');
  const core = createWorkspace(root);
  t.after(() => { core.close(); rmSync(root, { recursive: true }); });
  return { root, core };
}

test('Historical status distinguishes an interrupted first write from an unknown task', t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(task);
  const journal = join(root, task.task_id, 'evidence.jsonl');
  for (const content of ['', '{"type":']) {
    writeFileSync(journal, content);
    assert.equal(historicalStatus(root, task.task_id), 'RECOVERY_REQUIRED');
  }
  rmSync(journal);
  assert.equal(historicalStatus(root, task.task_id), 'RECOVERY_REQUIRED');
  assert.equal(historicalStatus(root, 'ctf-00000000-0000-0000-0000-000000000000'), null);
});

test('Historical list preserves a task whose cached journal disappears', t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(task);
  assert.equal(core.listTasks()[0].status, 'INTERRUPTED');
  rmSync(join(root, task.task_id, 'evidence.jsonl'));
  const [row] = core.listTasks();
  assert.equal(row?.task_id, task.task_id);
  assert.equal(row.status, 'RECOVERY_REQUIRED');
  assert.equal(row.recovery.auto_replay, false);
});

test('Historical list evicts missing tasks and invalid journals from its cache', t => {
  const { root, core } = setup(t);
  const ids = Array.from({ length: 3 }, () => {
    const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
    core.closeTask(task);
    return task.task_id;
  });
  const [removed, damaged, retained] = ids;
  const cache = new Map();
  listTasks(root, undefined, cache);
  assert.equal(cache.size, 3);
  rmSync(join(root, removed, 'evidence.jsonl'));
  fs.rmdirSync(join(root, removed));
  writeFileSync(join(root, damaged, 'evidence.jsonl'), '{bad}\n');
  const rows = listTasks(root, undefined, cache);
  assert.equal(rows.find(row => row.task_id === damaged)?.status, 'RECOVERY_REQUIRED');
  assert.equal(rows.some(row => row.task_id === removed), false);
  assert.deepEqual([...cache.keys()], [retained]);
});

test('Historical status reports recovery when the journal is a directory', t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(task);
  const journal = join(root, task.task_id, 'evidence.jsonl');
  rmSync(journal);
  mkdirSync(journal);
  assert.equal(core.listTasks()[0].status, 'RECOVERY_REQUIRED');
  assert.equal(historicalStatus(root, task.task_id), 'RECOVERY_REQUIRED');
});

test('A journal removed during a list read does not hide other tasks', t => {
  const { root, core } = setup(t);
  const removed = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  const retained = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(removed);
  core.closeTask(retained);
  const journal = join(root, removed.task_id, 'evidence.jsonl');
  const read = fs.readFileSync;
  const spy = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (typeof path === 'string' && resolve(path) === resolve(journal)) rmSync(journal);
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const rows = core.listTasks();
    assert.equal(rows.find(row => row.task_id === removed.task_id)?.status, 'RECOVERY_REQUIRED');
    assert.equal(rows.find(row => row.task_id === retained.task_id)?.status, 'INTERRUPTED');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('A damaged historical journal leaves other tasks visible and requires recovery', t => {
  const { root, core } = setup(t);
  const valid = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  const damaged = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(damaged);
  writeFileSync(join(root, damaged.task_id, 'evidence.jsonl'), '{broken}\n');
  const listed = core.listTasks();
  assert.equal(listed.find(item => item.task_id === valid.task_id).status, 'PREFLIGHT_PASSED');
  const recovery = listed.find(item => item.task_id === damaged.task_id);
  assert.equal(recovery.status, 'RECOVERY_REQUIRED');
  assert.equal(recovery.error_category, 'INVALID_EVIDENCE');
  assert.equal(recovery.recovery.auto_replay, false);
  assert.throws(() => core.taskDetail(damaged.task_id), SyntaxError);
  for (const invalid of [null, { task_id: damaged.task_id, previous_evidence_id: null }]) {
    writeFileSync(join(root, damaged.task_id, 'evidence.jsonl'), JSON.stringify(invalid) + '\n');
    assert.equal(core.listTasks().find(item => item.task_id === damaged.task_id).error_category, 'INVALID_EVIDENCE');
    assert.throws(() => core.taskDetail(damaged.task_id), /Invalid task evidence chain/);
  }
});

test('lists accepted and rejected tasks, exposes live status and read-only recovery', async t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'crypto', authorized_scope: 'local-only' });
  const denied = core.createTask({ challenge_type: 'web' });
  assert.deepEqual(listTasks(root).map(item => item.status).sort(), ['RECOVERY_REQUIRED', 'REJECTED']);
  assert.equal(core.taskDetail(task.task_id).status, 'PREFLIGHT_PASSED');
  assert.equal(core.taskDetail(denied.task_id).challenge_type, 'web');
  await core.pause(task);
  assert.equal(core.taskDetail(task.task_id).status, 'PAUSED');
  core.resume(task);
  assert.equal(core.taskDetail(task.task_id).status, 'RUNNING');
  const journal = inspectTask(root, task.task_id);
  assert.equal(journal.recovery.required, true);
  assert.equal(journal.recovery.auto_replay, false);
  await assert.rejects(core.execute(journal, 'forged', 'crypto-local', {}), /permit/);
  core.close();
  assert.equal(inspectTask(root, task.task_id).status, 'INTERRUPTED');
  assert.equal(inspectTask(root, task.task_id).error_category, 'WORKSPACE_CLOSED');
  assert.equal(inspectTask(root, task.task_id).recovery.required, true);
});

test('candidate and verification records remain tied to the successful operation', async t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'crypto', authorized_scope: 'local-only' });
  const other = core.createTask({ challenge_type: 'crypto', authorized_scope: 'local-only' });
  const flag = 'flag{workbench}';
  const input = { ciphertext: Buffer.from(flag).toString('hex'), key: 0 };
  const result = await core.execute(task, 'decode', 'crypto-local', input);
  const candidate = await core.recordCandidate(task, 'decode', flag);
  assert.equal(candidate.result_status, 'FORMAT_VALID');
  assert.equal(candidate.source_evidence_id, result.evidence_id);
  await assert.rejects(core.recordCandidate(other, 'decode', flag), /operation evidence/);
  assert.equal(await core.finish(task, 'decode', flag, 'flag{wrong}'), 'REJECTED');
  const nextFlag = 'flag{next}';
  await core.execute(task, 'next', 'crypto-local', { ciphertext: Buffer.from(nextFlag).toString('hex'), key: 0 });
  await core.recordCandidate(task, 'next', nextFlag);
  assert.equal(inspectTask(root, task.task_id).flag_status, 'FORMAT_VALID');
  assert.equal(await core.finish(task, 'decode', flag, flag), 'LOCALLY_VERIFIED');
  const detail = inspectTask(root, task.task_id);
  assert.equal(detail.status, 'COMPLETED');
  assert.deepEqual(detail.candidates.map(x => x.result_status), ['LOCALLY_VERIFIED', 'FORMAT_VALID']);
  assert.equal(detail.operations[0].result_evidence_id, result.evidence_id);
  assert.equal(detail.operations[0].operation_id, 'decode');
  assert.deepEqual(inspectTask(root, other.task_id).candidates, []);
  assert.ok(!JSON.stringify(detail).includes(flag));
  assert.match(taskReport(root, task.task_id), /LOCALLY_VERIFIED/);
});

test('a legacy journal with an unresolved dispatch reports manual recovery', t => {
  const { root } = setup(t);
  const { append } = createEvidenceStore(root, 'ctf-00000000-0000-0000-0000-000000000001');
  const id = 'ctf-00000000-0000-0000-0000-000000000001';
  append('state', { result_status: 'RUNNING' });
  append('dispatch', { result_status: 'RUNNING', operation_id: 'pending', input_hash: 'sha256:test' });
  const detail = inspectTask(root, id);
  assert.deepEqual(detail.recovery.unresolved_operations, ['pending']);
  assert.equal(detail.status, 'RECOVERY_REQUIRED');
  assert.equal(detail.challenge_type, null);
});
