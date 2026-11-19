import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createWorkspace, readEvidence } from '../../src/index.js';
import { loadSkill } from '../../src/skills/loader.js';
import { registerWorkspaceTool } from '../../src/dsh/plugin.js';

const types = ['web', 'pwn', 'reverse', 'crypto', 'misc'];
const expectedTools = { web: ['web-local'], pwn: [], reverse: [], crypto: ['crypto-local'], misc: ['misc-local'] };

function setup(t) {
  const root = fs.mkdtempSync('data/skills-');
  const core = createWorkspace(root);
  t.after(() => { core.close(); fs.rmSync(root, { recursive: true }); });
  return { root, core };
}

function observeReads(t, handler) {
  const read = fs.readFileSync;
  const spy = t.mock.method(fs, 'readFileSync', (path, ...args) => handler(String(path), () => read(path, ...args)));
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
}

test('Server plugin can retry start after a transient Skill read failure', async t => {
  const root = fs.realpathSync(fs.mkdtempSync('data/skills-'));
  let tool;
  let dispose;
  t.after(() => { dispose?.(); fs.rmSync(root, { recursive: true }); });
  let unavailable = true;
  observeReads(t, (path, next) => {
    if (unavailable && path.endsWith('/ctf-misc/SKILL.md')) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return next();
  });
  registerWorkspaceTool({ tools: { register(value) { tool = value; } }, on(_, fn) { dispose = fn; } },
    { sessionId: 'retry', authorizedScope: 'local-only' }, root);
  const start = callId => tool.execute({ action: 'start', category: 'misc', title: 'Skill retry' },
    { callId, agent: { session: { id: 'retry', header: { cwd: root } } } });
  await assert.rejects(start('first'), /SKILL_NOT_FOUND/);
  unavailable = false;
  assert.equal((await start('retry')).skill.metadata.id, 'ctf-misc');
  await assert.rejects(start('duplicate'), /already initialized/);
});

for (const type of types) {
  test('Skill structure and schema: ' + type, () => {
    const { metadata, body } = loadSkill(type, expectedTools[type]);
    assert.equal(metadata.id, 'ctf-' + type);
    assert.equal(metadata.version, '1.0.0');
    for (const heading of ['适用范围与排除', '输入与前置检查', '分析流程', '工具与中间证据', '误判、验证与停止条件']) {
      assert.ok(body.includes('## ' + heading));
    }
  });
}

test('Skill routing reads only selected packages and isolates audit', t => {
  const { root, core } = setup(t);
  const reads = [];
  observeReads(t, (path, next) => { if (/\/skills\/ctf-/.test(path)) reads.push(path); return next(); });
  for (const type of types) {
    reads.length = 0;
    const scope = type === 'web' ? 'http://127.0.0.1:12345' : 'local-only';
    const task = core.createTask({ challenge_type: type, authorized_scope: scope });
    assert.deepEqual(task.tool_allowlist, expectedTools[type]);
    assert.equal(task.selected_skill_id, 'ctf-' + type);
    assert.equal(task.selected_skill_version, '1.0.0');
    assert.equal(task.skill_load_status, 'LOADED');
    assert.equal(reads.length, 2);
    assert.ok(reads.every(path => path.includes('/ctf-' + type + '/')));
    const chain = readEvidence(root, task.task_id);
    const [invoked, loaded] = chain.filter(entry => entry.type === 'skill_load');
    assert.equal(invoked.result_status, 'INVOKED');
    assert.equal(loaded.result_status, 'LOADED');
    assert.equal(loaded.operation_id, invoked.operation_id);
    assert.equal(loaded.previous_evidence_id, invoked.evidence_id);
    assert.equal(loaded.skill_version, task.selected_skill_version);
    assert.ok(chain.every(entry => entry.task_id === task.task_id));
    assert.equal(core.taskDetail(task.task_id).selected_skill_version, '1.0.0');
  }
  const before = reads.length;
  assert.equal(core.createTask({challenge_type:'crypto'}).preflight_status, 'REJECTED');
  assert.equal(reads.length, before);
});

for (const [mode, code] of [['missing', 'SKILL_NOT_FOUND'], ['body', 'SKILL_INVALID_BODY'], ['metadata', 'SKILL_INVALID_METADATA']]) {
  test('Skill fail closed: ' + mode, async t => {
    const { root, core } = setup(t);
    observeReads(t, (path, next) => {
      if (path.endsWith('/ctf-crypto/skill.json') && mode === 'metadata') return '{"id":"ctf-web"}';
      if (path.endsWith('/ctf-crypto/SKILL.md')) {
        if (mode === 'missing') throw Object.assign(new Error('missing'), { code:'ENOENT' });
        if (mode === 'body') return '';
      }
      return next();
    });
    const task = core.createTask({ challenge_type: 'crypto', authorized_scope: 'local-only' });
    assert.equal(task.preflight_status, 'REJECTED');
    assert.equal(task.skill_load_status, 'LOAD_FAILED');
    assert.equal(task.rejection_reason, code);
    await assert.rejects(core.execute(task, 'attempt', 'crypto-local', {}), /permit/);
    const chain = readEvidence(root, task.task_id);
    assert.deepEqual(chain.filter(x => x.type === 'skill_load').map(x => x.result_status), ['INVOKED', 'LOAD_FAILED']);
    assert.equal(chain.find(x => x.result_status === 'LOAD_FAILED').error_category, code);
    assert.ok(!chain.some(x => x.type === 'dispatch' || x.type === 'tool_result'));
  });
}

