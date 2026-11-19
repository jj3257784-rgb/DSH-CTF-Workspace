import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { modelFromEnvironment } from '../../src/solver/model.js';
import { solveChallenge } from '../../src/solver/solve.js';
import { inspectTask } from '../../src/index.js';
import { fixture, closeAndProbe, flag, listen } from '../../fixtures/web/server.js';

test('Solver preserves an evidence read error after closing its workspace', async t => {
  const root = mkdtempSync('data/solver-');
  t.after(() => rmSync(root, { recursive: true }));
  const { model } = await endpoint(t, n => {
    if (n === 1) return { category: 'misc', query: '' };
    const id = readdirSync(root).find(name => name.startsWith('ctf-'));
    writeFileSync(join(root, id, 'evidence.jsonl'), '{broken}\n');
    return { action: 'clarify', question: 'Need fixture details' };
  });
  await assert.rejects(solveChallenge({ challenge: 'Local fixture', authorized_scope: 'local-only',
    model, dataRoot: root }), SyntaxError);
});

test('Solver returns the persisted closed status when its model budget is exhausted', async t => {
  const root = mkdtempSync('data/solver-');
  t.after(() => rmSync(root, { recursive: true }));
  const { model } = await endpoint(t, () => ({ category: 'misc', query: '' }));
  const result = await solveChallenge({ challenge: 'Local Base64 fixture', authorized_scope: 'local-only',
    model, dataRoot: root, budget: { model_calls: 1 } });
  const stored = inspectTask(root, result.task.task_id);
  assert.equal(result.status, stored.status);
  assert.equal(result.task.status, stored.status);
  assert.equal(result.task.recorded_status, stored.recorded_status);
  assert.equal(result.task.evidence.at(-1).evidence_id, stored.evidence.at(-1).evidence_id);
});

for (const outcome of ['clarify', 'format-only']) {
  test('Solver final snapshot agrees with history after ' + outcome, async t => {
    const root = mkdtempSync('data/solver-');
    t.after(() => rmSync(root, { recursive: true }));
    const actions = [{ category: 'crypto', query: '' },
      ...(outcome === 'clarify' ? [{ action: 'clarify', question: 'Need fixture details' }] : [
        { action: 'tool', tool: 'crypto-local', operation: 'xor',
          arguments: { ciphertext: Buffer.from('flag{unverified}').toString('hex'), key: 0 } },
        { action: 'finish', operation_id: 'op-1', candidate: 'flag{unverified}' }
      ])];
    const { model } = await endpoint(t, n => actions[n - 1]);
    const result = await solveChallenge({ challenge: 'Local XOR fixture', authorized_scope: 'local-only',
      model, dataRoot: root, budget: { input_tokens: 60000 } });
    const stored = inspectTask(root, result.task.task_id);
    assert.equal(result.status, outcome === 'clarify' ? 'INTERRUPTED' : 'FORMAT_VALID');
    assert.equal(result.task.status, 'INTERRUPTED');
    assert.deepEqual(result.task, stored);
  });
}

async function endpoint(t, respond) {
  const bodies = [];
  const server = await listen(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push({path:req.url, body});
    const action = respond(bodies.length);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(action)}}],
      usage:{prompt_tokens:300,completion_tokens:25}}));
  });
  t.after(() => closeAndProbe(server));
  return { bodies, model:modelFromEnvironment({
    CTF_MODEL_NAME:'local-protocol-fixture',
    CTF_MODEL_BASE_URL:'http://127.0.0.1:'+server.address().port+'/v1'
  }) };
}

for (const category of ['web','crypto','misc','pwn','reverse']) {
  test('Solver offline five-category execution: '+category, async t => {
    const root = mkdtempSync('data/solver-');
    t.after(() => rmSync(root,{recursive:true}));
    let web;
    if (category === 'web') {
      web = await fixture(new Map());
      t.after(() => closeAndProbe(web.server));
    }
    const expected = web ? flag : category === 'misc' ? 'flag{phase1b_misc}' : 'flag{offline_'+category+'}';
    if (category === 'misc') copyFileSync('fixtures/misc/sample.b64',join(root,'sample.b64'));
    if (['reverse','pwn'].includes(category)) {
      const bytes = Buffer.alloc(64);
      Buffer.from([0x7f,0x45,0x4c,0x46,2,1]).copy(bytes);
      bytes.writeUInt16LE(62,18);
      bytes.write(expected,32);
      writeFileSync(join(root,'sample.elf'),bytes);
    }
    const tool = {
      web:{tool:'curl-local',operation:'http-get',arguments:{url:web?.origin+'/sample'}},
      crypto:{tool:'crypto-local',operation:'xor',arguments:{ciphertext:Buffer.from(expected).map(x=>x^42).toString('hex'),key:42}},
      misc:{tool:'misc-local',operation:'base64-decode',arguments:{file:'sample.b64'}},
      pwn:{tool:'strings-local',operation:'extract-strings',arguments:{file:'sample.elf'}},
      reverse:{tool:'strings-local',operation:'extract-strings',arguments:{file:'sample.elf'}}
    }[category];
    const actions = [{category,query:''}];
    if (category === 'pwn' || category === 'reverse') {
      actions.push({action:'tool',tool:'static-local',operation:'inspect-header',arguments:{file:'sample.elf'}});
    }
    if (category === 'misc') actions.push({action:'skill',category:'crypto'},{action:'search',query:'哈希'});
    actions.push({action:'tool',...tool},{action:'finish',operation_id:category==='pwn'||category==='reverse'?'op-2':'op-1',
      candidate:expected,summary:'Fixture workflow through audited tools'});
    const {bodies,model} = await endpoint(t,n=>actions[n-1]);
    const result = await solveChallenge({challenge:'Synthetic '+category+' fixture sample.elf or sample.b64',
      authorized_scope:web?.origin??'local-only',expected_flag:expected,model,dataRoot:root,fixtureRoot:root,
      budget:{input_tokens:60000}});
    assert.equal(result.status,'LOCALLY_VERIFIED',JSON.stringify({status:result.status,reason:result.reason,trace:result.trace}));
    assert.equal(result.task.selected_skill_id,'ctf-'+category);
    assert.equal(result.applied_status,'UNVERIFIED');
    assert.ok(result.task.evidence.some(x=>x.type==='knowledge_retrieval'&&x.result_status==='RETRIEVED'));
    assert.ok(result.task.evidence.some(x=>x.type==='tool_result'&&x.tool===tool.tool));
    assert.ok(result.task.evidence.some(x=>x.type==='flag_verification'&&x.result_status==='LOCALLY_VERIFIED'));
    assert.equal(result.model_usage.length,bodies.length);
    assert.ok(bodies.every(x=>x.path==='/v1/chat/completions'&&x.body.max_tokens<=512));
    assert.ok(!JSON.stringify(bodies[0]).includes(expected));
    const firstAction = JSON.parse(bodies[1].body.messages[1].content);
    assert.ok(firstAction.skills[0].body.includes('## 分析流程'));
    assert.ok(firstAction.knowledge.some(x=>x.source===`methods/${category}-method-card.md`));
    assert.ok(firstAction.knowledge.every(x=>/^sha256:[a-f0-9]{64}$/.test(x.hash)));
    assert.ok(!JSON.stringify(firstAction).includes(expected));
    if (category==='misc') {
      const combined=JSON.parse(bodies.at(-1).body.messages[1].content);
      assert.deepEqual(combined.skills.map(x=>x.id),['ctf-misc','ctf-crypto']);
      assert.ok(!combined.tools.some(x=>x.id==='python-local'));
      assert.equal(new Set(combined.knowledge.map(x=>x.hash)).size,combined.knowledge.length);
    }
    if(web) assert.deepEqual(web.requests,['/sample']);
    t.diagnostic(JSON.stringify(result));
  });
}

test('Solver budget, repeated invalid tool, and clarification stop without dispatch', async t => {
  const root = mkdtempSync('data/solver-');
  t.after(() => rmSync(root,{recursive:true}));
  const {model,bodies} = await endpoint(t,n=>n===1?{category:'pwn',query:''}:
    {action:'tool',tool:'gdb',operation:'run',arguments:{}});
  const result=await solveChallenge({challenge:'Synthetic ELF',authorized_scope:'local-only',
    model,dataRoot:root,budget:{model_calls:3}});
  assert.equal(result.status,'INTERRUPTED');
  assert.equal(result.reason,'MODEL_BUDGET_EXHAUSTED');
  assert.equal(bodies.length,3);
  assert.equal(result.task.evidence.filter(x=>x.type==='dispatch_rejected').length,1);
  assert.ok(!result.task.evidence.some(x=>x.type==='dispatch'));
  const clarify=await endpoint(t,()=>({clarify:'Which fixture?' }));
  const uncertain=await solveChallenge({challenge:'Missing input',authorized_scope:'local-only',
    model:clarify.model,dataRoot:root});
  assert.equal(uncertain.status,'CLARIFICATION_REQUIRED');
  assert.equal(uncertain.question,'Which fixture?');
});

test('Model rejects a null JSON envelope with a stable protocol error', async t => {
  const server = await listen(async (req, res) => {
    for await (const chunk of req) { /* consume the request before replying */ }
    res.end('null');
  });
  t.after(() => closeAndProbe(server));
  const model = modelFromEnvironment({ CTF_MODEL_NAME: 'local-fixture',
    CTF_MODEL_BASE_URL: 'http://127.0.0.1:' + server.address().port });
  await assert.rejects(model.complete([], 32), /^Error: MODEL_INVALID_RESPONSE$/);
});

test('Solver requests clarification for a loopback scope with an invalid port', async t => {
  const { model } = await endpoint(t, () => ({ category: 'web' }));
  const result = await solveChallenge({ challenge: 'Local test fixture',
    authorized_scope: 'http://127.0.0.1:65536', model });
  assert.equal(result.status, 'CLARIFICATION_REQUIRED');
});

test('Solver keeps large tool feedback valid JSON and includes the actual output', async t => {
  const root = mkdtempSync('data/solver-feedback-');
  t.after(() => rmSync(root, { recursive: true }));
  const actions = [{ category: 'crypto' },
    { action: 'tool', tool: 'crypto-local', operation: 'xor',
      arguments: { ciphertext: '41'.repeat(2000), key: 0 } },
    { action: 'clarify', question: 'Fixture finished' }];
  const { model, bodies } = await endpoint(t, n => actions[n - 1]);
  await solveChallenge({ challenge: 'Local XOR fixture', authorized_scope: 'local-only',
    model, dataRoot: root, budget: { input_tokens: 60000 } });
  const context = JSON.parse(bodies[2].body.messages[1].content);
  const feedback = JSON.parse(context.previous);
  assert.equal(feedback.value, 'A'.repeat(1800));
  assert.equal(feedback.operation_id, 'op-1');
  assert.equal(feedback.value_truncated, true);
  assert.ok(feedback.evidence_id);
});

test('Model reports interrupted response bodies as transport failures', async t => {
  const server = await listen(async (req, res) => {
    for await (const chunk of req) { /* consume the request before replying */ }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1024' });
    res.write('{');
    res.end();
    res.socket?.destroy();
  });
  t.after(() => closeAndProbe(server));
  const model = modelFromEnvironment({ CTF_MODEL_NAME: 'local-fixture',
    CTF_MODEL_BASE_URL: 'http://127.0.0.1:' + server.address().port });
  await assert.rejects(model.complete([], 32), /^Error: MODEL_TRANSPORT_FAILED$/);
});
