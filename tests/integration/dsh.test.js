import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvidence } from '../../src/index.js';
import { apply, registerWorkspaceTool } from '../../src/dsh/plugin.js';

test('Desktop plugin advertises tools only to active workspace members', () => {
  const events = new Map();
  const project = new URL('../../', import.meta.url);
  const root = realpathSync(project);
  const workspace = { id: 'trusted', path: root, sessionIds: ['existing'] };
  const registry = { get: () => workspace, archivedSessionIds: [] };
  const makeAgent = (id, parentSession) => {
    const tools = new Map();
    return {
      id, session: { id, header: { id, cwd: root, parentSession } }, tools,
      ctx: { tools: { register(tool) {
        assert.equal(tools.has(tool.name), false);
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      } } }
    };
  };
  const existing = makeAgent('existing');
  const fresh = makeAgent('fresh');
  const ordinary = makeAgent('ordinary');
  const child = makeAgent('child', existing.id);
  const agents = new Map([existing, ordinary, child].map(agent => [agent.id, agent]));
  const ctx = {
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    workspaceRegistry: registry,
    tools: { register() { assert.fail('Desktop tool must never be registered globally'); } },
    on(event, handler) { events.set(event, handler); },
    effect(register) { events.set('dispose', register()); }
  };
  const visible = agent => agent.tools.has('ctf_workspace');
  const changed = fields => events.get('domain/changed')({ domain: 'workspace', operation: 'put', ...fields });
  apply(ctx, { workspaceId: workspace.id });
  assert.equal(visible(existing), true);
  assert.equal(visible(ordinary), false);
  agents.set(fresh.id, fresh);
  events.get('agent/created')({ agent: fresh });
  assert.equal(visible(fresh), false);
  changed({ table: 'workspaces', key: workspace.id, value: { ...workspace, sessionIds: ['fresh', 'child'] } });
  assert.equal(visible(existing), false);
  assert.equal(visible(fresh), true);
  assert.equal(visible(child), false);
  workspace.sessionIds = ['fresh', 'child'];
  changed({ table: '', value: { archivedSessionIds: ['fresh'] } });
  assert.equal(visible(fresh), false);
  changed({ table: '', value: { archivedSessionIds: [] } });
  assert.equal(visible(fresh), true);
  events.get('agent/disposed')({ agent: fresh });
  assert.equal(visible(fresh), false);
  changed({ table: 'workspaces', key: workspace.id, value: { ...workspace, sessionIds: ['existing'] } });
  assert.equal(visible(existing), true);
  events.get('dispose')();
  assert.equal(visible(existing), false);
});

for (const failed of [false, true]) {
test('Plugin disposal drains an active execution and pause before closing evidence: ' + (failed ? 'failure' : 'success'), async t => {
  const { listen, closeAndProbe } = await import('../../fixtures/web/server.js');
  const root = mkdtempSync('data/dispose-');
  let tool, dispose, respond, arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  const server = await listen((_req, res) => { respond = res; arrived(); });
  t.after(async () => {
    await dispose?.();
    await closeAndProbe(server);
    rmSync(root, { recursive: true });
  });
  registerWorkspaceTool({ tools: { register(value) { tool = value; } }, on(_, fn) { dispose = fn; } },
    { sessionId: 'dispose', authorizedScope: 'http://127.0.0.1:' + server.address().port }, root);
  let sequence = 0;
  const call = args => tool.execute(args, { callId: String(++sequence),
    agent: { session: { id: 'dispose', header: { cwd: root } } } });
  const task = await call({ action: 'start', category: 'web', title: 'Disposal boundary' });
  const work = call({ action: 'execute', tool_id: 'web-local', operation: 'http-get',
    arguments: { url: 'http://127.0.0.1:' + server.address().port + '/sample' } });
  await received;
  const pause = call({ action: 'pause' }).then(value => value.status, error => error.message);
  const disposal = Promise.resolve().then(dispose).then(() => null, error => error);
  if (failed) respond.writeHead(503);
  respond.end('flag{disposal}');
  assert.equal((await work).execution_status, failed ? 'FAILED' : 'SUCCESS');
  assert.equal(await pause, failed ? 'HTTP_STATUS' : 'PAUSED');
  assert.equal(await disposal, null);
  const evidence = readEvidence(join(root, 'data'), task.task_id);
  assert.equal(evidence.at(-1).result_status, failed ? 'FAILED' : 'INTERRUPTED');
  assert.ok(evidence.some(row => row.type === 'tool_result' && row.result_status === (failed ? 'FAILED' : 'SUCCESS')));
  await assert.rejects(call({ action: 'evidence' }), /disposed|closed|permit/i);
});
}

test('Blank initial query leaves four distinct follow-up searches available', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctf-query-budget-'));
  let tool, dispose;
  t.after(() => { dispose?.(); rmSync(root, { recursive: true }); });
  registerWorkspaceTool({ tools: { register(value) { tool = value; } }, on(_, fn) { dispose = fn; } },
    { sessionId: 'budget', authorizedScope: 'local-only' }, root);
  let calls = 0;
  const call = args => tool.execute(args, { callId: String(++calls),
    agent: { session: { id: 'budget', header: { cwd: root } } } });
  await call({ action: 'start', category: 'misc', title: 'Fixture', query: '　' });
  assert.ok((await call({ action: 'retrieve', query: 'alpha beta' })).knowledge);
  assert.equal((await call({ action: 'retrieve', query: ' ALPHA  BETA ' })).status, 'SKIPPED');
  for (const query of ['two', 'three', 'four']) {
    assert.ok((await call({ action: 'retrieve', query })).knowledge);
  }
  assert.equal((await call({ action: 'retrieve', query: 'five' })).status, 'SKIPPED');
});

test('native tool contract stub returns real Misc evidence to the originating session', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctf-dsh-'));
  let tool;
  let dispose;
  t.after(() => {
    dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'fixtures/misc'), { recursive: true });
  copyFileSync(new URL('../../fixtures/misc/sample.b64', import.meta.url), join(root, 'fixtures/misc/sample.b64'));
  const context = { tools: { register(definition) { tool = definition; } }, on(event, fn) {
    assert.equal(event, 'dispose');
    dispose = fn;
  } };
  assert.throws(() => registerWorkspaceTool(context, {}, root), /trusted session grant/);
  registerWorkspaceTool(context, { sessionId: 'session-a', authorizedScope: 'local-only', expectedFlag: 'flag{phase1b_misc}' }, root);
  assert.equal(tool.name, 'ctf_workspace');
  let sequence = 0;
  const call = (args, id = 'session-a', cwd = root) => tool.execute(args, {
    callId: 'call-' + ++sequence, agent: { session: { id, header: { cwd } } },
    signal: new AbortController().signal
  });
  const request = { action: 'start', category: 'misc', title: 'Decode a fixture', query: 'Base64', tags: ['encoding'] };
  await assert.rejects(call(request, 'session-b'), /not authorized/);
  await assert.rejects(call(request, 'session-a', tmpdir()), /not authorized/);
  const started = await call(request);
  assert.equal(started.skill.metadata.id, 'ctf-misc');
  assert.match(started.skill.body, /SHA-256/);
  assert.equal(started.knowledge.results[0].document_id, 'misc-method-card');
  assert.match(started.knowledge.results[0].snippet, /^# misc 方法卡/);
  assert.ok(!JSON.stringify(started).includes('flag{phase1b_misc}'));
  const repeatedDocument = await call({ action: 'retrieve', query: 'base64', tags: [] });
  assert.equal(repeatedDocument.knowledge.result_status, 'SKIPPED');
  assert.deepEqual(repeatedDocument.knowledge.results, []);
  const operation = { action: 'execute', operation_id: 'decode', tool_id: 'misc-local',
    operation: 'base64-decode', arguments: { file: 'sample.b64' } };
  const denied = await call({ ...operation, tool_id: 'web-local' });
  assert.equal(denied.execution_status, 'REJECTED');
  const decoded = await call(operation);
  assert.equal(decoded.value, 'flag{phase1b_misc}');
  assert.equal(JSON.parse(tool.output.render(operation, decoded)[0].text).evidence_id, decoded.evidence_id);
  copyFileSync(new URL('../../fixtures/misc/phase2b.zip', import.meta.url),
    join(root, 'fixtures/misc/phase2b.zip'));
  const inspect = await call({ action: 'execute', operation_id: 'zip-header', tool_id: 'static-local',
    operation: 'inspect-header', arguments: { file: 'phase2b.zip' } });
  assert.equal(inspect.execution_status, 'SUCCESS');
  assert.equal(inspect.value, null);
  assert.equal(inspect.format, 'ZIP');
  assert.equal(inspect.size, readFileSync(join(root, 'fixtures/misc/phase2b.zip')).length);
  assert.equal(inspect.knowledge.results[0].document_id, 'zip-directory-triage');
  assert.deepEqual(inspect, JSON.parse(JSON.stringify(inspect)));
  const retry = { action: 'execute', operation_id: 'zip-header', tool_id: 'static-local',
    operation: 'inspect-header', arguments: { file: 'phase2b.zip' } };
  const manualRetry = await call({ ...retry, include_method_card: false });
  assert.equal(manualRetry.knowledge, undefined);
  assert.equal(manualRetry.evidence_id, inspect.evidence_id);
  const automaticRetry = await call(retry);
  assert.deepEqual(automaticRetry.knowledge, inspect.knowledge);
  const redundant = await call({ action: 'retrieve', query: 'ZIP', tags: ['zip'] });
  assert.equal(redundant.knowledge.result_status, 'SKIPPED');
  assert.deepEqual(redundant.knowledge.results, []);
  const outside = await call({ action: 'execute', operation_id: 'outside-header', tool_id: 'static-local',
    operation: 'inspect-header', arguments: { file: '../phase2b.zip' } });
  assert.equal(outside.execution_status, 'REJECTED');
  assert.equal(outside.knowledge, undefined);
  const list = { action: 'execute', operation_id: 'zip-list', tool_id: 'archive-local',
    operation: 'list-fixture', arguments: { file: 'phase2b.zip' } };
  const listing = await call(list);
  assert.equal(listing.execution_status, 'SUCCESS');
  assert.equal(listing.archive_action, 'list');
  assert.deepEqual(listing, JSON.parse(JSON.stringify(listing)));
  const unsupported = await call({ ...list, operation_id: 'zip-unsupported',
    arguments: { file: 'file (1).zip' } });
  assert.equal(unsupported.execution_status, 'REJECTED');
  writeFileSync(join(root, 'fixtures/misc/large.b64'), Buffer.from('A'.repeat(10000)).toString('base64'));
  const large = await call({ ...operation, operation_id: 'large-decode', arguments: { file: 'large.b64' } });
  assert.equal(large.execution_status, 'SUCCESS');
  for (const [file, header, format, card] of [
    ['signature.png', '89504e470d0a1a0a', 'PNG', 'png-structure-triage'],
    ['signature.wav', '524946460400000057415645', 'WAVE', 'wave-chunk-triage']
  ]) {
    writeFileSync(join(root, 'fixtures/misc', file), Buffer.from(header, 'hex'));
    const probe = await call({ action: 'execute', tool_id: 'static-local',
      operation: 'inspect-header', arguments: { file } });
    assert.equal(probe.execution_status, 'SUCCESS');
    assert.equal(probe.format, format);
    assert.equal(probe.size, header.length / 2);
    assert.deepEqual(probe.knowledge.results.map(item => item.document_id), [card]);
    if (format === 'WAVE') {
      assert.match(probe.knowledge.results[0].snippet, /文件短于该偏移时记录截断/);
      assert.match(probe.knowledge.results[0].snippet, /奇数负载所需的 1 字节填充/);
    }
  }
  assert.equal(large.value.length, 8192);
  assert.equal(large.value_truncated, true);
  assert.equal(decoded.value_truncated, false);
  const verify = { action: 'verify', operation_id: 'decode' };
  assert.notEqual((await call({ ...verify, candidate: 'flag{wrong}' })).status, 'LOCALLY_VERIFIED');
  assert.equal((await call({ ...verify, candidate: decoded.value })).status, 'LOCALLY_VERIFIED');
  const evidence = readEvidence(join(root, 'data'), started.task_id);
  assert.equal(evidence.filter(record => record.type === 'knowledge_retrieval'
    && record.document_id === 'zip-directory-triage'
    && record.query_id === inspect.knowledge.query_id).length, 1);
  assert.equal(evidence.filter(record => record.type === 'dispatch').length, 6);
  assert.ok(evidence.some(record => record.type === 'host_tool_proposal'
    && record.session_id === 'session-a' && record.call_id === 'call-6' && record.operation_id === 'decode'));
  assert.ok(evidence.some(record => record.type === 'dispatch_rejected' && record.evidence_id === denied.evidence_id));
  const filtered = await call({ action: 'retrieve', query: 'base64', tags: ['missing-tag'] });
  assert.equal(filtered.knowledge?.result_status, 'REJECTED');
  assert.deepEqual(filtered.knowledge.issues, [{ error_category: 'UNKNOWN_TAGS', tags: ['missing-tag'] }]);
  const repeated = await call({ action: 'retrieve', query: ' Base64 ', tags: ['missing-tag'] });
  assert.equal(repeated.status, 'SKIPPED');
});

test('Misc preflight saves one call when the initial query misses and preserves independent verification', async t => {
  async function run(usePreflightCard) {
    const root = mkdtempSync(join(tmpdir(), 'ctf-dsh-'));
    let tool;
    let dispose;
    t.after(() => {
      dispose?.();
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, 'fixtures/misc'), { recursive: true });
    copyFileSync(new URL('../../fixtures/misc/sample.b64', import.meta.url), join(root, 'fixtures/misc/sample.b64'));
    registerWorkspaceTool({
      tools: { register(definition) { tool = definition; } },
      on(_event, handler) { dispose = handler; }
    }, { sessionId: 'comparison', authorizedScope: 'local-only', expectedFlag: 'flag{phase1b_misc}' }, root);
    let calls = 0;
    const call = args => tool.execute(args, {
      callId: 'comparison-' + ++calls,
      agent: { session: { id: 'comparison', header: { cwd: root } } },
      signal: new AbortController().signal
    });
    const started = await call({ action: 'start', category: 'misc', title: 'Identify an encoded fixture',
      query: 'no matching keywords', tags: ['zip'] });
    assert.ok(!started.knowledge.results.some(card => card.document_id === 'misc-method-card'));
    const observed = await call({ action: 'execute', operation_id: 'preflight', tool_id: 'static-local',
      operation: 'inspect-header', arguments: { file: 'sample.b64' },
      ...(usePreflightCard ? {} : { include_method_card: false }) });
    assert.equal(observed.format, 'BASE64');
    if (!usePreflightCard) assert.equal(observed.knowledge, undefined);
    const knowledge = usePreflightCard ? observed.knowledge
      : (await call({ action: 'retrieve', query: 'Base64', tags: ['encoding'] })).knowledge;
    assert.equal(knowledge.results[0].document_id, 'misc-method-card');
    const decoded = await call({ action: 'execute', operation_id: 'decode', tool_id: 'misc-local',
      operation: 'base64-decode', arguments: { file: 'sample.b64' } });
    const verified = await call({ action: 'verify', operation_id: 'decode', candidate: decoded.value });
    assert.equal(verified.status, 'LOCALLY_VERIFIED');
    return calls;
  }

  assert.equal(await run(false), 5);
  assert.equal(await run(true), 4);
});

test('the same ELF header selects its category-specific desktop method card', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctf-dsh-'));
  const disposers = [];
  t.after(() => {
    disposers.forEach(dispose => dispose());
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'fixtures/misc'), { recursive: true });
  writeFileSync(join(root, 'fixtures/misc/header.elf'), Buffer.from('7f454c46', 'hex'));
  mkdirSync(join(root, 'work'));
  const header = Buffer.alloc(64);
  Buffer.from('7f454c46020101', 'hex').copy(header);
  header.writeUInt16LE(62, 18);
  header.writeBigUInt64LE(0x400a40n, 24);
  writeFileSync(join(root, 'work/challenge'), header);
  for (const category of ['reverse', 'pwn']) {
    let tool;
    registerWorkspaceTool({
      tools: { register(definition) { tool = definition; } },
      on(_event, dispose) { disposers.push(dispose); }
    }, { sessionId: category, authorizedScope: 'local-only' }, root);
    let sequence = 0;
    const call = args => tool.execute(args, {
      callId: 'elf-' + ++sequence,
      agent: { session: { id: category, header: { cwd: root } } },
      signal: new AbortController().signal
    });
    const request = { action: 'start', category, title: 'Identify an ELF header',
      query: 'nomatchingfixturekeyword' };
    await assert.rejects(call({ ...request, attachment_path: '../challenge' }), /workspace-relative/);
    const started = await call({ ...request, attachment_path: 'work/challenge' });
    assert.deepEqual(started.attachment, { path: 'work/challenge', format: 'ELF',
      size: 64, bits: 64, machine: 62, entry: '0x400a40' });
    if (category === 'reverse') {
      assert.equal(started.knowledge.fallback, 'CATEGORY_REFERENCE');
      assert.deepEqual(started.knowledge.results.map(card => card.document_id), ['reverse-method-card']);
    }
    const result = await call({ action: 'execute', tool_id: 'static-local',
      operation: 'inspect-header', arguments: { file: 'header.elf' } });
    assert.equal(result.format, 'ELF');
    assert.equal(result.machine, null);
    assert.equal(result.knowledge.results[0].document_id, category + '-method-card');
  }
});

test('DSH tool contract records local Crypto verification in Gateway evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctf-dsh-crypto-'));
  let tool;
  let dispose;
  t.after(() => {
    dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  const fixture = new URL('../../fixtures/crypto/vector.json', import.meta.url);
  const { expected, ...vector } = JSON.parse(readFileSync(fixture, 'utf8'));
  mkdirSync(join(root, 'fixtures/crypto'), { recursive: true });
  copyFileSync(fixture, join(root, 'fixtures/crypto/vector.json'));
  registerWorkspaceTool({ tools: { register(definition) { tool = definition; } },
    on(event, fn) { assert.equal(event, 'dispose'); dispose = fn; } },
  { sessionId: 'crypto-session', authorizedScope: 'local-only', expectedFlag: expected }, root);
  const call = (callId, args) => tool.execute(args, {
    callId, agent: { session: { id: 'crypto-session', header: { cwd: root } } },
    signal: new AbortController().signal
  });
  const started = await call('start', { action: 'start', category: 'crypto', title: 'Verify a synthetic vector',
    query: 'nomatchingfixturekeyword' });
  assert.equal(started.skill.metadata.id, 'ctf-crypto');
  assert.equal(started.knowledge.fallback, 'CATEGORY_REFERENCE');
  assert.deepEqual(started.knowledge.results.map(card => card.document_id), ['crypto-method-card']);
  const decoded = await call('decode', { action: 'execute', operation_id: 'decode', tool_id: 'crypto-local',
    operation: 'xor', arguments: vector });
  assert.equal(decoded.execution_status, 'SUCCESS');
  assert.equal(decoded.value, expected);
  const verified = await call('verify', { action: 'verify', operation_id: 'decode', candidate: decoded.value });
  assert.equal(verified.status, 'LOCALLY_VERIFIED');
  const evidence = readEvidence(join(root, 'data'), started.task_id);
  assert.deepEqual(evidence.filter(row => row.type === 'knowledge_retrieval')
    .map(row => row.result_status), ['NO_RESULT', 'RETRIEVED']);
  assert.ok(evidence.some(record => record.type === 'tool_result' && record.evidence_id === decoded.evidence_id));
  assert.ok(evidence.some(record => record.type === 'host_tool_proposal' && record.call_id === 'decode'
    && record.session_id === 'crypto-session' && record.operation_id === 'decode'));
  assert.ok(evidence.some(record => record.type === 'flag_verification' && record.result_status === 'LOCALLY_VERIFIED'));
});

test('global Desktop tool gates every action on registered live workspace membership', async t => {
  const { registerDesktopTool } = await import('../../src/dsh/plugin.js');
  const root = mkdtempSync(join(tmpdir(), 'ctf-desktop-gate-'));
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'fixtures/misc'), { recursive: true });
  copyFileSync(new URL('../../fixtures/misc/sample.b64', import.meta.url), join(root, 'fixtures/misc/sample.b64'));
  const agent = id => ({ id, session: { id, header: { id, cwd: root } } });
  const ctf = agent('ctf');
  const second = agent('second');
  const ordinary = agent('ordinary');
  const live = new Map([ctf, second, ordinary].map(owner => [owner.id, owner]));
  const workspace = { id: 'trusted', path: root, sessionIds: ['ctf', 'second'] };
  let registration = workspace;
  let cwd = root;
  let tool;
  const ctx = {
    agents: live,
    workspaceRegistry: { get: () => registration, archivedSessionIds: [] },
    workingDirectory: { get: () => cwd },
    tools: { register(value) { tool = value; } },
    on(_event, dispose) { disposers.push(dispose); }
  };
  registerDesktopTool(ctx, { workspaceId: 'trusted', expectedFlag: 'flag{phase1b_misc}' }, root);
  let calls = 0;
  const call = (owner, args) => tool.execute(args, {
    agent: owner, signal: new AbortController().signal, callId: 'call-' + ++calls
  });
  const start = { action: 'start', category: 'misc', title: 'Synthetic', query: 'base64' };
  const denied = /session or workspace not authorized/;
  await assert.rejects(call(ordinary, start), denied);
  await assert.rejects(call({ ...ctf }, start), denied);
  registration = { ...workspace, id: 'forged' };
  await assert.rejects(call(ctf, start), denied);
  registration = workspace;
  cwd = join(root, '..');
  await assert.rejects(call(ctf, start), denied);
  cwd = root;
  const junction = join(root, 'escape');
  symlinkSync(join(root, '..'), junction, 'junction');
  cwd = junction;
  await assert.rejects(call(ctf, start), denied);
  cwd = root;
  const task = await call(ctf, start);
  assert.equal(task.skill.metadata.id, 'ctf-misc');
  assert.ok(task.knowledge.results.length);
  const offline = { action: 'offline-method-card', material: {
    category: 'web', httpRecord: 'HTTP/1.1 502 Bad Gateway'
  } };
  await assert.rejects(call(ordinary, offline), denied);
  assert.equal((await call(second, offline)).knowledge.results[0].document_id, 'web-method-card');
  for (const field of ['source', 'httpRecord']) {
    assert.deepEqual(tool.parameters.properties.material.properties[field], { type: 'string' });
    await assert.rejects(call(second, { ...offline, material: {
      ...offline.material, [field]: ' '.repeat(16385)
    } }), /Invalid offline material/);
  }
  const crypto = await call(second, { action: 'offline-method-card', material: {
    category: 'crypto', algorithm: 'XOR', ciphertext: '4c46', key: 42
  } });
  assert.equal(crypto.knowledge.results[0].document_id, 'crypto-method-card');
  const execute = { action: 'execute', tool_id: 'misc-local', operation: 'base64-decode',
    arguments: { file: 'sample.b64' } };
  await assert.rejects(call(second, { ...execute, task_id: task.task_id }), /No authorized CTF task/);
  const prefixed = await call(ctf, { ...execute, operation_id: 'decode-prefixed',
    arguments: { file: 'fixtures/misc/sample.b64' } });
  assert.equal(prefixed.execution_status, 'REJECTED');
  assert.match(prefixed.reason, /Invalid input or target outside scope/);
  const result = await call(ctf, execute);
  assert.equal(result.execution_status, 'SUCCESS');
  await assert.rejects(call(ctf, { ...execute, task_id: 'forged' }), /task identity mismatch/);
  for (let i = 2; i <= 6; i++) {
    const accepted = await call(ctf, { ...execute, operation_id: 'decode-' + i });
    assert.equal(accepted.execution_status, 'SUCCESS');
  }
  const overBudget = await call(ctf, { ...execute, operation_id: 'decode-7' });
  assert.equal(overBudget.execution_status, 'REJECTED');
  assert.match(overBudget.reason, /Budget exhausted/);
  const evidence = readEvidence(join(root, 'data'), task.task_id);
  assert.equal(evidence.filter(row => row.type === 'dispatch').length, 6);
  assert.ok(evidence.some(row => row.type === 'dispatch_rejected' && row.operation_id === 'decode-prefixed'));
  const grant = evidence.find(row => row.type === 'host_tool_proposal');
  assert.equal(grant.expiresAt - grant.issuedAt, 90_000);
  const replacement = agent('ctf');
  live.set('ctf', replacement);
  await assert.rejects(call(replacement, start), /cannot survive Agent replacement/);
  live.set('ctf', ctf);
  const originalTool = tool;
  registerDesktopTool(ctx, { workspaceId: 'trusted' }, root);
  await assert.rejects(call(ctf, start), /already issued/);
  const secondTask = await call(second, { ...start, query: 'nomatchingfixturekeyword' });
  assert.notEqual(secondTask.task_id, task.task_id);
  assert.equal(secondTask.knowledge.result_status, 'RETRIEVED');
  const returnedIds = secondTask.knowledge.results.map(item => item.document_id);
  assert.ok(returnedIds.includes('misc-method-card'));
  assert.equal(new Set(returnedIds).size, returnedIds.length);
  const retrievals = readEvidence(join(root, 'data'), secondTask.task_id)
    .filter(row => row.type === 'knowledge_retrieval');
  const queries = Map.groupBy(retrievals, row => row.query_id);
  assert.equal(queries.size, 2);
  const [[initialId, initialRows], [fallbackId, fallbackRows]] = queries;
  assert.ok(initialId);
  assert.ok(fallbackId);
  assert.deepEqual(initialRows.map(row => row.result_status), ['NO_RESULT']);
  assert.ok(fallbackRows.every(row => row.result_status === 'RETRIEVED'));
  assert.deepEqual(fallbackRows.map(row => row.document_id), returnedIds);
  assert.ok(!JSON.stringify([tool.description, tool.parameters, secondTask]).includes('flag{phase1b_misc}'));
  const secondResult = await call(second, execute);
  const verifySecond = { action: 'verify', operation_id: secondResult.operation_id };
  assert.notEqual((await call(second, { ...verifySecond, candidate: 'flag{wrong}' })).status, 'LOCALLY_VERIFIED');
  assert.equal((await call(second, { ...verifySecond, candidate: secondResult.value })).status, 'LOCALLY_VERIFIED');
  tool = originalTool;
  t.mock.method(Date, 'now', () => grant.expiresAt);
  await assert.rejects(call(ctf, execute), /grant expired/);
  const expiredEvidence = await call(ctf, { action: 'evidence' });
  assert.ok(expiredEvidence.evidence.length > 0);
  await assert.rejects(call(ctf, { action: 'verify', operation_id: result.operation_id,
    candidate: result.value }), /grant expired/);
  t.mock.restoreAll();
  const journal = join(root, 'data', task.task_id, 'evidence.jsonl');
  const savedJournal = readFileSync(journal);
  unlinkSync(journal);
  try {
    await assert.rejects(call(ctf, execute), /ENOENT/);
  } finally {
    writeFileSync(journal, savedJournal, { flag: 'wx' });
  }
  workspace.sessionIds = ['second'];
  await assert.rejects(call(ctf, execute), denied);
});

test('Desktop start validates arguments before reserving the session grant', async t => {
  const { registerDesktopTool } = await import('../../src/dsh/plugin.js');
  const root = mkdtempSync(join(tmpdir(), 'ctf-desktop-args-'));
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'fixtures/misc'), { recursive: true });
  copyFileSync(new URL('../../fixtures/misc/sample.b64', import.meta.url), join(root, 'fixtures/misc/sample.b64'));
  const owner = { id: 'args', session: { id: 'args', header: { id: 'args', cwd: root } } };
  const workspace = { id: 'trusted', path: root, sessionIds: ['args'] };
  let tool;
  const context = {
    agents: { get: id => (id === owner.id ? owner : undefined) },
    workspaceRegistry: { get: () => workspace, archivedSessionIds: [] },
    workingDirectory: { get: () => root },
    tools: { register(definition) { tool = definition; } },
    on(_event, dispose) { disposers.push(dispose); }
  };
  registerDesktopTool(context, { workspaceId: 'trusted', expectedFlag: 'flag{phase1b_misc}' }, root);
  // Desktop grants are local-only, so web must never be advertised as usable.
  assert.equal(tool.parameters.properties.category.enum.includes('web'), false);
  let calls = 0;
  const call = args => tool.execute(args, {
    agent: owner, signal: new AbortController().signal, callId: 'args-' + ++calls
  });
  await assert.rejects(call({ action: 'start', category: 'web', title: 'Web task' }), error => {
    assert.match(error.message, /Invalid task category: "web"/);
    assert.match(error.message, /Keep the Web classification and continue with offline review/);
    return true;
  });
  assert.equal(existsSync(join(root, 'data', 'desktop-session-grants')), false);
  await assert.rejects(call({ action: 'start', category: 'misc', title: '   ' }), /Invalid task title/);
  await assert.rejects(call({ action: 'start', category: 'misc', title: 'Invalid query', query: 42 }),
    /Invalid knowledge query/);
  await assert.rejects(call({ action: 'start', category: 'misc', title: 'Invalid tags', tags: [42] }),
    /Invalid knowledge tags/);
  await assert.rejects(call({ action: 'start', category: 'misc', title: 'Missing tag element', tags: Array(1) }),
    /Invalid knowledge tags/);
  // Rejected arguments must not consume the one-shot grant for this session.
  assert.equal(existsSync(join(root, 'data', 'desktop-session-grants')), false);
  const started = await call({
    action: 'start', category: 'misc', title: 'Retry after rejected arguments', query: 'base64', tags: ['missing-tag']
  });
  assert.equal(started.skill.metadata.id, 'ctf-misc');
  assert.equal(started.knowledge.result_status, 'REJECTED');
  assert.deepEqual(started.knowledge.issues, [{ error_category: 'UNKNOWN_TAGS', tags: ['missing-tag'] }]);
  assert.deepEqual(started.knowledge.results, []);
  const retrieved = await call({ action: 'retrieve', query: 'base64', tags: ['encoding'] });
  assert.equal(retrieved.knowledge.results[0].document_id, 'misc-method-card');
  await assert.rejects(call({ action: 'start', category: 'misc', title: 'Second start' }), /already initialized/);
});
