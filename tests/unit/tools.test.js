import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspace, listTools, readEvidence } from '../../src/index.js';
import { fixture, closeAndProbe, flag, listen } from '../../fixtures/web/server.js';

function setup(t, fixtureRoot) {
  const root = mkdtempSync('data/tools-');
  const core = createWorkspace(root, fixtureRoot ?? root);
  t.after(() => { core.close(); rmSync(root, {recursive:true}); });
  return {root, core};
}

function run(core, task, operation_id, tool_id, operation, args) {
  return core.executeTool(task, {task_id:task.task_id, operation_id, tool_id, operation,
    arguments:args, authorized_scope:task.authorized_scope});
}

test('Tool inventory records versions, real paths and GDB restriction', () => {
  const tools = listTools();
  assert.equal(new Set(tools.map(x=>x.tool_id)).size, tools.length);
  for (const tool of tools) {
    assert.equal(tool.available_status, 'VERIFIED_AVAILABLE');
    if (tool.execution_enabled) {
      assert.equal(createHash('sha256').update(readFileSync(tool.executable_path)).digest('hex'),tool.executable_sha256);
    }
    assert.ok(tool.version);
    assert.ok(tool.evidence_requirements.includes('evidence_id'));
  }
  assert.equal(tools.find(x=>x.tool_id==='gdb').execution_enabled,false);
});

test('Tool Web curl authenticates scope before request and records hashes', async t => {
  const {core,root} = setup(t);
  const web = await fixture(new Map([['/redirect', '/sample']]));
  try {
    const task=core.createTask({challenge_type:'web',authorized_scope:web.origin,requested_tools:['curl-local']});
    await assert.rejects(run(core,task,'outside','curl-local','http-get',{url:'http://127.0.0.2/sample'}),/scope/);
    assert.deepEqual(web.requests,[]);
    await assert.rejects(run(core,task,'extra','curl-local','http-get',{url:web.origin+'/sample',args:['--location']}),/input/);
    assert.deepEqual(web.requests,[]);
    const result=await run(core,task,'get','curl-local','http-get',{url:web.origin+'/sample'});
    assert.equal(result.value,flag);
    assert.equal(result.execution_status,'SUCCESS');
    assert.equal(result.tool_version,'8.14.1');
    assert.equal(await core.finish(task,'get',flag,flag),'LOCALLY_VERIFIED');
    assert.deepEqual(web.requests,['/sample']);
    const redirect=core.createTask({challenge_type:'web',authorized_scope:web.origin,requested_tools:['curl-local']});
    await assert.rejects(run(core,redirect,'redirect','curl-local','http-get',{url:web.origin+'/redirect'}),/HTTP_STATUS/);
    assert.deepEqual(web.requests,['/sample','/redirect']);
    const evidence=readEvidence(root,task.task_id);
    assert.equal(evidence.find(x=>x.evidence_id===result.evidence_id).output_hash,result.output_hash);
    t.diagnostic(JSON.stringify(evidence.filter(x=>['dispatch','tool_result','dispatch_rejected'].includes(x.type))));
  } finally { await closeAndProbe(web.server); }
});

test('Tool Crypto Python fixed script round trip, pause, replay and isolation', async t => {
  const {core,root} = setup(t);
  const task=core.createTask({challenge_type:'crypto',authorized_scope:'local-only',requested_tools:['python-local']});
  const expected='flag{python}';
  const args={ciphertext:Buffer.from(expected).map(byte=>byte^42).toString('hex'),key:42};
  if (!listTools().find(tool => tool.tool_id === 'python-local').execution_enabled) {
    assert.equal(task.preflight_status, 'REJECTED');
    await assert.rejects(run(core, task, 'xor', 'python-local', 'xor', args), /permit/);
    assert.ok(!readEvidence(root, task.task_id).some(row => row.type === 'dispatch'));
    t.diagnostic('Python executable unavailable or fingerprint mismatch; verified pre-dispatch rejection.');
    return;
  }
  const first=run(core,task,'xor','python-local','xor',args);
  await core.pause(task);
  await assert.rejects(run(core,task,'other','python-local','xor',args),/not runnable/);
  core.resume(task);
  const result=await first;
  assert.deepEqual(await run(core,task,'xor','python-local','xor',args),result);
  await assert.rejects(run(core,task,'xor','python-local','xor',{...args,key:43}),/changed/);
  assert.equal(result.round_trip,true);
  assert.equal(result.value,expected);
  await core.recordCandidate(task,'xor',expected);
  assert.equal(await core.finish(task,'xor',expected,expected),'LOCALLY_VERIFIED');
  const denied=core.createTask({challenge_type:'crypto',requested_tools:['python-local']});
  await assert.rejects(run(core,denied,'xor','python-local','xor',args),/permit/);
  const chain=readEvidence(root,task.task_id);
  assert.equal(chain.filter(x=>x.type==='dispatch').length,1);
  assert.ok(chain.every(x=>x.task_id===task.task_id));
  assert.equal(chain.find(x=>x.evidence_id===result.evidence_id).details.round_trip,true);
  t.diagnostic(JSON.stringify(chain.filter(x=>x.type==='tool_result')));
});

test('Tool Misc file classification, Base64 and pinned archive list', async t => {
  const {core,root}=setup(t,'fixtures/misc');
  const task=core.createTask({challenge_type:'misc',authorized_scope:'local-only',requested_tools:['static-local','archive-local']});
  const info=await run(core,task,'inspect','static-local','inspect-header',{file:'phase2b.zip'});
  assert.equal(info.format,'ZIP');
  assert.match(info.source_hash,/^sha256:/);
  const result=await run(core,task,'list','archive-local','list-fixture',{file:'phase2b.zip'});
  assert.match(result.value,/sample\.txt/);
  assert.equal(result.artifact_paths.length,0);
  assert.equal(result.exit_code,0);
  const decoded=await run(core,task,'decode','misc-local','base64-decode',{file:'sample.b64'});
  const artifact=readFileSync(join(root,task.task_id,decoded.artifact_paths[0]));
  assert.equal('sha256:'+createHash('sha256').update(artifact).digest('hex'),decoded.output_hash);
  assert.equal(await core.finish(task,'decode',decoded.value,'flag{phase1b_misc}'),'LOCALLY_VERIFIED');
  t.diagnostic(JSON.stringify(readEvidence(root,task.task_id).filter(x=>x.type==='tool_result')));
});

for(const category of ['pwn','reverse']) {
  test('Tool static ' + category + ': bytes, strings, and dynamic denial', async t => {
    const {core,root}=setup(t);
    const sample=Buffer.alloc(64);
    Buffer.from([0x7f,0x45,0x4c,0x46,2,1]).copy(sample);
    sample.writeUInt16LE(62,18);
    sample.write('synthetic-marker',32);
    writeFileSync(join(root,'sample.elf'),sample);
    const task=core.createTask({challenge_type:category,authorized_scope:'local-only',requested_tools:['static-local','strings-local']});
    const denied=core.createTask({challenge_type:category,authorized_scope:'local-only',requested_tools:['gdb']});
    assert.equal(denied.preflight_status,'REJECTED');
    await assert.rejects(run(core,task,'dynamic','gdb','run',{}),/allowlist/);
    await assert.rejects(run(core,task,'outside','static-local','inspect-header',{file:'../sample.elf'}),/input/);
    const result=await run(core,task,'header','static-local','inspect-header',{file:'sample.elf'});
    assert.equal(result.format,'ELF');
    assert.equal(result.machine,62);
    assert.equal(result.dynamic_facts,'UNVERIFIED');
    const strings=await run(core,task,'strings','strings-local','extract-strings',{file:'sample.elf'});
    assert.match(strings.value,/synthetic-marker/);
    assert.equal(strings.execution_status,'SUCCESS');
    assert.ok(readEvidence(root,task.task_id).some(x=>x.evidence_id===result.evidence_id));
  });
}

test('Tool curl timeout and output cap persist failure and release listeners', async t => {
  const {core,root}=setup(t);
  const server=await listen((req,res)=>{
    if(req.url==='/large') res.end(Buffer.alloc(1024*1024+64,65));
  });
  try {
    const scope='http://127.0.0.1:'+server.address().port;
    const task=()=>core.createTask({challenge_type:'web',authorized_scope:scope,requested_tools:['curl-local'],
      budget_limit:{max_tool_calls:2,max_runtime_seconds:1}});
    const large=task();
    await assert.rejects(run(core,large,'large','curl-local','http-get',{url:scope+'/large'}),/OUTPUT_LIMIT/);
    const slow=task();
    await assert.rejects(run(core,slow,'slow','curl-local','http-get',{url:scope+'/slow'}),/TIMEOUT/);
    assert.equal(core.status(slow),'FAILED');
    await assert.rejects(run(core,slow,'slow','curl-local','http-get',{url:scope+'/slow'}),/not runnable/);
    assert.equal(readEvidence(root,slow.task_id).find(x=>x.type==='tool_result').result_status,'TIMEOUT');
    assert.equal(readEvidence(root,large.task_id).find(x=>x.type==='tool_result').error_category,'OUTPUT_LIMIT');
  } finally { await closeAndProbe(server); }
});

test('Tool rejects altered archive and mismatched scope before dispatch', async t => {
  const {core,root}=setup(t);
  writeFileSync(join(root,'phase2b.zip'),Buffer.from('PK synthetic changed archive'));
  const task=core.createTask({challenge_type:'misc',authorized_scope:'local-only',requested_tools:['archive-local']});
  await assert.rejects(core.executeTool(task,{task_id:task.task_id,authorized_scope:'wrong'}),/scope/);
  await assert.rejects(run(core,task,'bad-op','archive-local','extract',{file:'phase2b.zip'}),/Operation outside/);
  await assert.rejects(run(core,task,'bad-zip','archive-local','list-fixture',{file:'phase2b.zip'}),/Invalid input/);
  assert.ok(!readEvidence(root,task.task_id).some(x=>x.type==='dispatch'));
});

test('Strings candidates accept an exact output line and reject invented or partial lines', async t => {
  const { core, root } = setup(t);
  writeFileSync(join(root, 'candidate.bin'), 'prefix\0flag{strings_candidate}\0suffix\0');
  const task = core.createTask({ challenge_type: 'reverse', authorized_scope: 'local-only',
    requested_tools: ['strings-local'] });
  const result = await run(core, task, 'strings', 'strings-local', 'extract-strings', { file: 'candidate.bin' });
  await assert.rejects(core.recordCandidate(task, 'strings', 'flag{invented}'), /does not match/);
  await assert.rejects(core.recordCandidate(task, 'strings', 'flag{strings}'), /does not match/);
  const candidate = await core.recordCandidate(task, 'strings', 'flag{strings_candidate}');
  assert.equal(candidate.source_evidence_id, result.evidence_id);
  assert.equal(await core.finish(task, 'strings', 'flag{strings_candidate}', 'flag{strings_candidate}'), 'LOCALLY_VERIFIED');
});
