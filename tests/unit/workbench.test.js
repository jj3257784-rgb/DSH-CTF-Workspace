import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspace, inspectTask, listTasks, taskReport, historicalStatus } from '../../src/index.js';

import { createEvidenceStore } from '../../src/state/evidence-store.js';

test('Historical status never trusts a broken evidence chain as completed', t => {
  const { root, core } = setup(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  core.closeTask(task);
  const path = join(root, task.task_id, 'evidence.jsonl');
  const invalid = [null, { task_id: task.task_id, evidence_id: 'forged',
    previous_evidence_id: 'missing', timestamp: new Date().toISOString(),
    type: 'state', result_status: 'COMPLETED' }];
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

function setup(t) {
  const root = mkdtempSync('data/workbench-');
  const core = createWorkspace(root);
  t.after(() => { core.close(); rmSync(root, { recursive: true }); });
  return { root, core };
}

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
