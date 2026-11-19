import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createWorkspace, readEvidence } from '../../src/index.js';
import { closeAndProbe, fixture, flag, listen } from '../../fixtures/web/server.js';

const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');

function setup(t, fixtureRoot) {
  const root = fs.mkdtempSync('data/1b-');
  const core = createWorkspace(root, fixtureRoot);
  t.after(() => {
    core.close();
    fs.rmSync(root, { recursive: true });
  });
  return { root, core };
}

function permit(core, type, tool, scope = 'local-only') {
  const task = core.createTask({ challenge_type: type, authorized_scope: scope });
  assert.equal(task.preflight_status, 'PASSED');
  assert.equal(task.authorized_scope, scope);
  assert.equal(task.selected_method_card, type + '-method-card');
  assert.deepEqual(task.tool_allowlist, [tool]);
  return task;
}

function evidence(t, root, task, metrics = {}) {
  const chain = readEvidence(root, task.task_id);
  assert.ok(chain.length);
  assert.equal(new Set(chain.map(item => item.evidence_id)).size, chain.length);
  for (const [index, item] of chain.entries()) {
    assert.equal(item.task_id, task.task_id);
    assert.equal(item.previous_evidence_id, chain[index - 1]?.evidence_id ?? null);
    assert.ok(Number.isFinite(Date.parse(item.timestamp)));
    if (item.type !== 'tool_result') continue;
    assert.match(item.input_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(item.tool_version, 'node-' + process.versions.node);
    assert.ok(task.tool_allowlist.includes(item.tool));
    assert.equal(item.exit_code, item.result_status === 'SUCCESS' ? 0 : 1);
    assert.ok(item.output_summary);
    assert.ok(Object.hasOwn(item, 'artifact_path'));
    const dispatch = chain.slice(0, index).find(entry => entry.type === 'dispatch'
      && entry.operation_id === item.operation_id && entry.input_hash === item.input_hash);
    assert.ok(dispatch);
    assert.ok(chain.slice(0, chain.indexOf(dispatch)).some(entry => entry.type === 'preflight'
      && entry.result_status === 'PASSED'));
  }
  const calls = chain.filter(item => item.type === 'dispatch').length;
  t.diagnostic(JSON.stringify({ task_id: task.task_id, calls, ...metrics, chain }));
  return chain;
}

test('Web normal response and pre-dispatch scope rejection', async t => {
  const start = performance.now();
  const { core, root } = setup(t);
  const web = await fixture(new Map());
  const attempted = [];
  const outbound = channel('http.client.request.start');
  const observe = ({ request }) => attempted.push(request.path);
  outbound.subscribe(observe);
  let task;
  try {
    task = permit(core, 'web', 'web-local', web.origin);
    const port = web.server.address().port;
    for (const target of [
      'http://127.0.0.2:' + port, 'http://localhost:' + port, 'https://127.0.0.1:' + port,
      'http://127.0.0.1:' + (port === 65535 ? port - 1 : port + 1)
    ]) {
      await assert.rejects(core.execute(task, 'outside', 'web-local', { url: target + '/sample' }), /outside scope/);
    }
    assert.deepEqual(attempted, []);
    assert.deepEqual(web.requests, []);
    const denied = readEvidence(root, task.task_id);
    assert.equal(denied.filter(x => x.type === 'dispatch_rejected' && x.error_category).length, 4);
    assert.equal(denied.filter(x => x.type === 'dispatch').length, 0);
    const url = web.origin + '/sample';
    const result = await core.execute(task, 'sample', 'web-local', { url });
    assert.deepEqual(attempted, ['/sample']);
    assert.deepEqual(web.requests, ['/sample']);
    assert.equal(result.http_status, 200);
    assert.equal(result.value, flag);
    assert.equal(await core.finish(task, 'sample', result.value, flag), 'LOCALLY_VERIFIED');
    const record = readEvidence(root, task.task_id).find(x => x.evidence_id === result.evidence_id);
    assert.equal(record.input_hash, sha(JSON.stringify({ tool: 'web-local', url })));
    assert.equal(record.result_hash, sha(flag));
  } finally {
    outbound.unsubscribe(observe);
    await closeAndProbe(web.server);
  }
  evidence(t, root, task, { elapsed_ms: performance.now() - start, output_bytes: Buffer.byteLength(flag),
    requests: web.requests, rejected: 4, port_released: true });
});

test('Web redirects never trigger a second request', async t => {
  const start = performance.now();
  const { core, root } = setup(t);
  const redirects = new Map();
  const trapRequests = [];
  const trap = await listen((req, res) => { trapRequests.push(req.url); res.end(); });
  const web = await fixture(redirects);
  const port = web.server.address().port;
  redirects.set('/port', 'http://127.0.0.1:' + trap.address().port + '/target');
  redirects.set('/protocol', 'https://127.0.0.1:' + port + '/target');
  redirects.set('/host', 'http://127.0.0.2:' + port + '/target');
  redirects.set('/relative', '/target');
  const outbound = channel('http.client.request.start');
  const attempted = [];
  const observe = ({ request }) => attempted.push(request.path);
  outbound.subscribe(observe);
  const tasks = [];
  try {
    for (const path of redirects.keys()) {
      const task = permit(core, 'web', 'web-local', web.origin);
      tasks.push(task);
      await assert.rejects(core.execute(task, 'redirect', 'web-local', { url: web.origin + path }), /HTTP_STATUS/);
      assert.equal(core.status(task), 'FAILED');
    }
    assert.deepEqual(attempted, [...redirects.keys()]);
    assert.deepEqual(web.requests, attempted);
    assert.deepEqual(trapRequests, []);
  } finally {
    outbound.unsubscribe(observe);
    await Promise.all([closeAndProbe(web.server), closeAndProbe(trap)]);
  }
  for (const task of tasks) evidence(t, root, task, { output_bytes: 0 });
  t.diagnostic(JSON.stringify({ elapsed_ms: performance.now() - start, attempted, trapRequests, ports_released: 2 }));
});

for (const [path, error] of [['/failure', 'HTTP_STATUS'], ['/timeout', 'TIMEOUT']]) {
  test('Web cleanup after ' + error, async t => {
    const start = performance.now();
    const { core, root } = setup(t);
    const web = await fixture(new Map());
    const task = permit(core, 'web', 'web-local', web.origin);
    const input = { url: web.origin + path };
    try {
      await assert.rejects(core.execute(task, 'request', 'web-local', input), new RegExp('^Error: ' + error + '$'));
      assert.equal(core.status(task), 'FAILED');
      await assert.rejects(core.execute(task, 'request', 'web-local', input), /not runnable/);
      assert.throws(() => core.finish(task, 'request', flag, flag), /cannot finish/);
      assert.deepEqual(web.requests, [path]);
      const results = readEvidence(root, task.task_id).filter(x => x.type === 'tool_result');
      assert.deepEqual(results.map(x => x.result_status), [error === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED']);
    } finally {
      await closeAndProbe(web.server);
    }
    evidence(t, root, task, { elapsed_ms: performance.now() - start, output_bytes: 0,
      requests: web.requests, port_released: true });
  });
}

test('Crypto fixed vector, independent intermediate and reverse verification', async t => {
  const start = performance.now();
  const { core, root } = setup(t);
  const { expected, ...input } = JSON.parse(fs.readFileSync('fixtures/crypto/vector.json', 'utf8'));
  const task = permit(core, 'crypto', 'crypto-local');
  const result = await core.execute(task, 'decode', 'crypto-local', input);
  assert.equal(result.value, expected);
  const intermediate = Buffer.from(expected).toString('hex');
  assert.equal(result.intermediate_hex, intermediate);
  assert.equal(result.reencoded, input.ciphertext);
  assert.equal(result.round_trip, true);
  assert.equal(await core.finish(task, 'decode', expected), 'FORMAT_VALID');
  assert.equal(await core.finish(task, 'decode', result.value, expected), 'LOCALLY_VERIFIED');
  const chain = evidence(t, root, task, { elapsed_ms: performance.now() - start,
    output_bytes: Buffer.byteLength(result.value), intermediate_hex: intermediate, reencoded: result.reencoded });
  const record = chain.find(x => x.evidence_id === result.evidence_id);
  assert.equal(record.input_hash, sha(JSON.stringify({ tool: 'crypto-local', ...input })));
  assert.deepEqual(record.details, { round_trip: true, intermediate_hash: sha(intermediate) });
});

test('Misc Base64 replay, source and artifact chain, task isolation', async t => {
  const start = performance.now();
  const { core, root } = setup(t);
  const expected = 'flag{phase1b_misc}';
  const file = 'sample.b64';
  const source = fs.readFileSync(join('fixtures/misc', file));
  const tasks = ['original', 'replay'].map(() => permit(core, 'misc', 'misc-local'));
  assert.notEqual(tasks[0].task_id, tasks[1].task_id);
  const original = await core.execute(tasks[0], 'convert', 'misc-local', { file });
  const foreign = permit(core, 'crypto', 'crypto-local');
  await assert.rejects(core.execute(foreign, 'convert', 'misc-local', { file }), /allowlist/);
  assert.throws(() => core.finish(tasks[1], 'convert', expected, expected), /cannot finish/);
  const replay = await core.execute(tasks[1], 'convert', 'misc-local', { file });
  for (const [index, result] of [original, replay].entries()) {
    const task = tasks[index];
    const artifact = fs.readFileSync(join(root, task.task_id, result.artifact_path));
    assert.deepEqual(artifact, Buffer.from(expected));
    assert.equal(result.source_hash, sha(source));
    assert.equal(result.artifact_hash, sha(artifact));
    assert.equal(result.encoding, 'base64');
    assert.equal(await core.finish(task, 'convert', result.value, expected), 'LOCALLY_VERIFIED');
    const chain = evidence(t, root, task, { output_bytes: artifact.length });
    const record = chain.find(x => x.evidence_id === result.evidence_id);
    assert.equal(record.input_hash, sha(JSON.stringify({ tool: 'misc-local', file, source: sha(source) })));
    assert.deepEqual(record.details, { source_hash: sha(source), artifact_hash: sha(artifact), encoding: 'base64' });
    assert.ok(!chain.some(x => x.evidence_id === [replay, original][index].evidence_id));
  }
  assert.equal(original.artifact_hash, replay.artifact_hash);
  assert.deepEqual(fs.readFileSync(join('fixtures/misc', file)), source);
  assert.ok(!evidence(t, root, foreign, { elapsed_ms: performance.now() - start }).some(x => x.type === 'dispatch'));
});

async function checkPaths(t, linkType) {
  const start = performance.now();
  const parent = fs.mkdtempSync('data/path-');
  t.after(() => fs.rmSync(parent, { recursive: true }));
  const trusted = join(parent, 'trusted');
  fs.mkdirSync(trusted);
  const outside = resolve(parent, 'outside.b64');
  fs.writeFileSync(outside, 'Zml4dHVyZQ==');
  const target = linkType === 'junction' ? resolve(parent, 'external') : outside;
  if (linkType === 'junction') fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, join(trusted, 'escape.b64'), linkType);
  } catch (error) {
    if (process.platform !== 'win32' || linkType !== 'file' || error.code !== 'EPERM') throw error;
    t.skip('Windows denied creation of a file symbolic link (EPERM)');
    return;
  }
  const { core, root } = setup(t, trusted);
  const task = permit(core, 'misc', 'misc-local');
  const opened = [];
  const open = fs.openSync;
  const spy = t.mock.method(fs, 'openSync', (path, ...args) => {
    if (typeof path === 'string' && path.endsWith('.b64')) opened.push(path);
    return open(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    for (const file of ['../outside.b64', '..\\outside.b64', outside,
      'nested/../../outside.b64', 'escape.b64']) {
      await assert.rejects(core.execute(task, 'reject', 'misc-local', { file }), /Invalid input/);
    }
    assert.deepEqual(opened, []);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  const chain = evidence(t, root, task, { elapsed_ms: performance.now() - start, rejected: 5, content_opens: opened.length });
  assert.equal(chain.filter(x => x.type === 'dispatch_rejected').length, 5);
  assert.ok(!chain.some(x => x.type === 'dispatch' || x.type === 'tool_result'));
}

test('Misc traversal, absolute paths and Windows junction escape', t => checkPaths(t, 'junction'));
test('Misc file symbolic link escape', t => checkPaths(t, 'file'));

