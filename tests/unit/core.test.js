import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createWorkspace, searchKnowledge, verifyFlag, readEvidence } from '../../src/index.js';
import { validate } from '../../src/executor/allowlist.js';

test('Web scope accepts explicit default port without widening the origin', () => {
  for (const tool of ['web-local', 'curl-local']) {
    assert.deepEqual(validate(tool, 'http://127.0.0.1:80', { url: 'http://127.0.0.1:80/sample' }),
      { url: 'http://127.0.0.1/sample' });
    assert.throws(() => validate(tool, 'http://127.0.0.1:80', { url: 'http://127.0.0.1:81/sample' }));
  }
});

function workspace(t) {
  const path = mkdtempSync('data/test-');
  const core = createWorkspace(path);
  t.after(() => { core.close(); rmSync(path, { recursive: true }); });
  return { core, path };
}

test('evidence reader preserves complete trailing records and ignores interrupted writes', t => {
  const { core, path } = workspace(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  const evidence = path + '/' + task.task_id + '/evidence.jsonl';
  const original = readFileSync(evidence, 'utf8');
  const records = readEvidence(path, task.task_id);
  try {
    writeFileSync(evidence, original.trimEnd());
    assert.deepEqual(readEvidence(path, task.task_id), records);
    writeFileSync(evidence, original + '{"type":');
    assert.deepEqual(readEvidence(path, task.task_id), records);
  } finally {
    writeFileSync(evidence, original);
  }
});

test('expired tasks reject replay and final verification', async t => {
  const { core, path } = workspace(t);
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  const input = { file: 'sample.b64' };
  const result = await core.execute(task, 'decode', 'misc-local', input);
  const expired = performance.now() + 360_000;
  const clock = t.mock.method(performance, 'now', () => expired);
  try {
    await assert.rejects(core.execute(task, 'decode', 'misc-local', input), /Budget exhausted/);
    await assert.rejects(core.finish(task, 'decode', result.value, result.value), /deadline expired/);
    await assert.rejects(core.recordCandidate(task, 'decode', result.value), /deadline expired/);
  } finally {
    clock.mock.restore();
  }
  const evidence = readEvidence(path, task.task_id);
  assert.equal(evidence.filter(row => row.type === 'dispatch').length, 1);
  assert.ok(!evidence.some(row => row.type === 'flag_verification'));
});

test('missing scope rejects before execution and persists audit', async t => {
  const { core, path } = workspace(t);
  const decision = core.createTask({ challenge_type: 'crypto' });
  assert.equal(decision.preflight_status, 'REJECTED');
  await assert.rejects(core.execute(decision, 'one', 'crypto-local', {}));
  assert.deepEqual(readEvidence(path, decision.task_id).filter(x => x.type !== 'state').map(x => x.type), ['preflight']);
});

test('Gateway permits only the selected adapter', async t => {
  const { core } = workspace(t);
  const task = core.createTask({ challenge_type: 'pwn', authorized_scope: 'local-only' });
  assert.deepEqual(task.tool_allowlist, []);
  await assert.rejects(core.execute(task, 'one', 'crypto-local', {}), /allowlist/);
  await assert.rejects(core.execute({ ...task }, 'two', 'crypto-local', {}), /permit/);
});

test('pause drains work and resume reuses identical successful operation', async t => {
  const { core, path } = workspace(t);
  const task = core.createTask({ challenge_type: 'crypto', authorized_scope: 'local-only' });
  const input = { ciphertext: '353e', key: 90 };
  const work = core.execute(task, 'decode', 'crypto-local', input);
  await core.pause(task);
  assert.equal(core.status(task), 'PAUSED');
  const first = await work;
  assert.equal(first.value, 'od');
  core.resume(task);
  assert.deepEqual(await core.execute(task, 'decode', 'crypto-local', { key: 90, ciphertext: '353e' }), first);
  await assert.rejects(core.execute(task, 'decode', 'crypto-local', { ...input, key: 91 }), /input/);
  const chain = readEvidence(path, task.task_id);
  assert.equal(chain.filter(x => x.type === 'tool_result').length, 1);
  assert.ok(chain.every((item, i) => item.previous_evidence_id === (chain[i-1]?.evidence_id ?? null)));
});

test('five cards are available and flag formatting is not proof', () => {
  for (const type of ['web', 'pwn', 'reverse', 'crypto', 'misc']) {
    assert.equal(searchKnowledge({ type }).length, 1);
  }
  assert.equal(verifyFlag('flag{sample}'), 'FORMAT_VALID');
  assert.equal(verifyFlag('flag{sample}', 'flag{other}'), 'REJECTED');
  assert.equal(verifyFlag('flag{sample}', 'flag{sample}'), 'LOCALLY_VERIFIED');
});


test('failed adapter persists failure and cannot be reused as success', async t => {
  const { path } = workspace(t);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path + '/bad.b64', 'invalid!');
  const core = createWorkspace(path, path);
  t.after(() => core.close());
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  await assert.rejects(core.execute(task, 'decode', 'misc-local', { file: 'bad.b64' }), /INVALID_BASE64/);
  await assert.rejects(core.execute(task, 'decode', 'misc-local', { file: 'bad.b64' }), /not runnable/);
  assert.equal(core.status(task), 'FAILED');
  const [result] = readEvidence(path, task.task_id).filter(record => record.type === 'tool_result');
  assert.equal(result.result_status, 'FAILED');
  assert.equal(result.error_category, 'INVALID_BASE64');
  assert.equal(result.exit_code, 1);
  assert.match(result.input_hash, /^sha256:[a-f0-9]{64}$/);
});

test('a clean process exit persists INTERRUPTED and evidence is readable in parent', async t => {
  const { spawnSync } = await import('node:child_process');
  const { historicalStatus } = await import('../../src/index.js');
  const { path } = workspace(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createWorkspace } from './src/index.js';
    const workspace = createWorkspace(process.argv[1]);
    const task = workspace.createTask({ challenge_type: 'crypto', authorized_scope: 'local-only' });
    await workspace.execute(task, 'decode', 'crypto-local', { ciphertext: '66', key: 0 });
    console.log(task.task_id);
  `, path], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const id = child.stdout.trim();
  assert.equal(historicalStatus(path, id), 'INTERRUPTED');
  assert.ok(readEvidence(path, id).some(x => x.type === 'tool_result' && x.result_status === 'SUCCESS'));
});

test('unfinished journal requires manual recovery and is never a live permit', async t => {
  const { historicalStatus } = await import('../../src/index.js');
  const { core, path } = workspace(t);
  const task = core.createTask({ challenge_type: 'crypto', authorized_scope: 'local-only' });
  assert.equal(historicalStatus(path, task.task_id), 'RECOVERY_REQUIRED');
  const second = createWorkspace(path);
  t.after(() => second.close());
  await assert.rejects(second.execute(task, 'one', 'crypto-local', {}), /permit/);
});

test('only adapter-linked fixed answers complete the task', async t => {
  const { core, path } = workspace(t);
  const task = core.createTask({ challenge_type: 'crypto', authorized_scope: 'local-only' });
  const flag = 'flag{unit}';
  const input = { ciphertext: Buffer.from(flag).map(byte => byte ^ 42).toString('hex'), key: 42 };
  const result = await core.execute(task, 'decode', 'crypto-local', input);
  assert.equal(result.round_trip, true);
  assert.equal(await core.finish(task, 'decode', flag), 'FORMAT_VALID');
  assert.equal(await core.finish(task, 'decode', 'flag{wrong}', 'flag{wrong}'), 'REJECTED');
  assert.equal(await core.finish(task, 'decode', flag, flag), 'LOCALLY_VERIFIED');
  assert.equal(core.status(task), 'COMPLETED');
  const evidence = readEvidence(path, task.task_id);
  assert.equal(evidence.find(x => x.type === 'tool_result').details.round_trip, true);
  assert.equal(evidence.findLast(x => x.type === 'flag_verification').source_evidence_id, result.evidence_id);
});

test('Web rejects out-of-scope URLs before any dispatch', async t => {
  const { core, path } = workspace(t);
  const task = core.createTask({ challenge_type: 'web', authorized_scope: 'http://127.0.0.1:12345' });
  await assert.rejects(core.execute(task, 'fetch', 'web-local', { url: 'http://127.0.0.1:12346/sample' }), /outside scope/);
  assert.ok(!readEvidence(path, task.task_id).some(x => x.type === 'dispatch'));
});

test('Misc rejects high-bit bytes instead of silently decoding their ASCII aliases', async t => {
  const path = mkdtempSync('data/high-bit-');
  writeFileSync(path + '/high-bit.b64', Buffer.from([0xda, 0xed, 0xec, 0xb4]));
  writeFileSync(path + '/non-ascii-space.b64', Buffer.from('\u00a0Zg==\u00a0', 'latin1'));
  const core = createWorkspace(path, path);
  t.after(() => { core.close(); rmSync(path, { recursive: true }); });
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only',
    requested_tools: ['static-local', 'misc-local'] });
  const inspected = await core.execute(task, 'inspect', 'static-local', { file: 'non-ascii-space.b64' });
  assert.equal(inspected.format, 'UNKNOWN');
  await assert.rejects(core.execute(task, 'decode-spaces', 'misc-local', { file: 'non-ascii-space.b64' }), /INVALID_BASE64/);
  const aliases = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  await assert.rejects(core.execute(aliases, 'decode', 'misc-local', { file: 'high-bit.b64' }), /INVALID_BASE64/);
  assert.equal(core.status(task), 'FAILED');
  assert.ok(!readEvidence(path, task.task_id).some(row => row.artifact_path));
  assert.equal(core.status(aliases), 'FAILED');
  assert.ok(!readEvidence(path, aliases.task_id).some(row => row.artifact_path));
});
