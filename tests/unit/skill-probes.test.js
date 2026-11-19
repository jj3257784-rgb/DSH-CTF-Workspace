import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkspace, readEvidence } from '../../src/index.js';
import { fixture, closeAndProbe, flag } from '../../fixtures/web/server.js';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

function probe(t, type, scope = 'local-only') {
  const root = mkdtempSync('data/probe-');
  const core = createWorkspace(root);
  t.after(() => { core.close(); rmSync(root, { recursive: true }); });
  const task = core.createTask({ challenge_type: type, authorized_scope: scope });
  assert.equal(task.skill_load_status, 'LOADED');
  return { root, core, task, chain: () => readEvidence(root, task.task_id) };
}

test('Skill probe Web: authorize before request and stop outside scope', async t => {
  const web = await fixture(new Map());
  try {
    const { core, task, chain } = probe(t, 'web', web.origin);
    await assert.rejects(core.execute(task, 'denied', 'web-local', { url: 'https://127.0.0.1/sample' }), /scope/);
    assert.deepEqual(web.requests, []);
    assert.equal(chain().some(x => x.type === 'dispatch'), false);
    const result = await core.execute(task, 'sample', 'web-local', { url: web.origin + '/sample' });
    assert.deepEqual(web.requests, ['/sample']);
    assert.equal(await core.finish(task, 'sample', result.value, flag), 'LOCALLY_VERIFIED');
    const evidence = chain();
    const preflight = evidence.findIndex(x => x.type === 'preflight' && x.authorized_scope === web.origin);
    const dispatch = evidence.findIndex(x => x.type === 'dispatch');
    assert.ok(preflight >= 0 && dispatch > preflight);
    assert.equal(evidence.find(x => x.evidence_id === result.evidence_id).result_hash, sha(flag));
    t.diagnostic(JSON.stringify({ requests: web.requests, evidence }));
  } finally {
    await closeAndProbe(web.server);
  }
});

test('Skill probe Crypto: malformed input, intermediate digest and reverse check', async t => {
  const { core, task, chain } = probe(t, 'crypto');
  await assert.rejects(core.execute(task, 'bad', 'crypto-local', { ciphertext: 'xyz', key: 42 }), /Invalid input/);
  const { expected, ...input } = JSON.parse(readFileSync('fixtures/crypto/vector.json', 'utf8'));
  const result = await core.execute(task, 'decode', 'crypto-local', input);
  assert.equal(result.value, expected);
  assert.equal(result.reencoded, input.ciphertext);
  const evidence = chain().find(x => x.evidence_id === result.evidence_id);
  assert.equal(evidence.details.intermediate_hash, sha(Buffer.from(expected).toString('hex')));
  assert.equal(evidence.details.round_trip, true);
  assert.equal(await core.finish(task, 'decode', expected), 'FORMAT_VALID');
  assert.equal(await core.finish(task, 'decode', expected, 'flag{wrong}'), 'REJECTED');
  t.diagnostic(JSON.stringify(chain()));
});

test('Skill probe Misc: source hash, artifact hash, replay and path stop', async t => {
  const { root, core, task, chain } = probe(t, 'misc');
  await assert.rejects(core.execute(task, 'outside', 'misc-local', { file: '../sample.b64' }), /Invalid input/);
  const source = readFileSync('fixtures/misc/sample.b64');
  for (const operation of ['convert', 'replay']) {
    const result = await core.execute(task, operation, 'misc-local', { file: 'sample.b64' });
    const artifact = readFileSync(join(root, task.task_id, result.artifact_path));
    assert.deepEqual(artifact, Buffer.from('flag{phase1b_misc}'));
    const record = chain().find(x => x.evidence_id === result.evidence_id);
    assert.deepEqual(record.details, { encoding: 'base64', source_hash: sha(source), artifact_hash: sha(artifact) });
  }
  assert.deepEqual(readFileSync('fixtures/misc/sample.b64'), source);
  t.diagnostic(JSON.stringify(chain()));
});

test('Skill probe Pwn: static ELF header facts and dynamic stop', async t => {
  const { core, task, chain } = probe(t, 'pwn');
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(header);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(62, 18);
  const facts = { hash: sha(header), magic: header.subarray(0, 4).toString('hex'),
    class: header[4], type: header.readUInt16LE(16), machine: header.readUInt16LE(18) };
  assert.deepEqual([facts.magic, facts.class, facts.type, facts.machine], ['7f454c46', 2, 3, 62]);
  const inference = { pie: 'UNVERIFIED', nx: 'UNVERIFIED', reason: 'Synthetic header has no segment evidence' };
  await assert.rejects(core.execute(task, 'dynamic', 'gdb', {}), /allowlist/);
  const evidence = chain();
  assert.ok(evidence.some(x => x.type === 'dispatch_rejected'));
  assert.ok(!evidence.some(x => x.type === 'dispatch'));
  t.diagnostic(JSON.stringify({ task_id: task.task_id, facts, inference, rejection: evidence.at(-1).evidence_id }));
});

test('Skill probe Reverse: static bytes, explicit hypothesis and execution refusal', async t => {
  const { core, task, chain } = probe(t, 'reverse');
  const bytes = Buffer.from([0x83, 0xf0, 0x2a, 0xc3]);
  const facts = { hash: sha(bytes), offset: 0, bytes: bytes.toString('hex') };
  const hypothesis = { kind: 'static-inference', architecture: 'x86', operation: 'xor eax, 42; ret' };
  assert.equal(facts.bytes, '83f02ac3');
  assert.equal(0x41 ^ bytes[2], 0x6b);
  await assert.rejects(core.execute(task, 'dynamic', 'execute-binary', { file: 'unknown.bin' }), /allowlist/);
  const evidence = chain();
  assert.ok(evidence.some(x => x.type === 'dispatch_rejected'));
  assert.ok(!evidence.some(x => x.type === 'dispatch'));
  t.diagnostic(JSON.stringify({ task_id: task.task_id, facts, hypothesis, dynamic_facts: 'UNVERIFIED',
    rejection: evidence.at(-1).evidence_id }));
});
