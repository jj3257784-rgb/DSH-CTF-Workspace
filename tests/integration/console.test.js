import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startConsole } from '../../src/console/server.js';
import { historicalStatus } from '../../src/state/evidence-store.js';

test('Console can retry shutdown after a transient journal failure', async t => {
  const dataRoot = mkdtempSync('data/console-');
  t.after(() => rmSync(dataRoot, { recursive: true }));
  const app = await startConsole({ dataRoot });
  const response = await fetch(app.url + '/api/tasks', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + new URL(app.launchUrl).hash.slice(1),
      'content-type': 'application/json', 'x-workbench-request': '1'
    },
    body: JSON.stringify({ title: 'Shutdown retry', challenge_type: 'misc', authorized_scope: 'local-only' })
  });
  assert.equal(response.status, 201);
  const { task_id: id } = await response.json();
  const journal = join(dataRoot, id, 'evidence.jsonl');
  const backup = journal + '.backup';
  renameSync(journal, backup);
  try {
    const first = app.close();
    assert.equal(app.close(), first);
    await assert.rejects(first, { code: 'ENOENT' });
  } finally {
    renameSync(backup, journal);
  }
  await app.close();
  await app.close();
  assert.equal(historicalStatus(dataRoot, id), 'INTERRUPTED');
});

test('Console loopback routes manage execution, evidence, attachments and history', async t => {
  const dataRoot = mkdtempSync('data/console-');
  let app = await startConsole({ dataRoot });
  t.after(async () => { await app.close(); rmSync(dataRoot,{recursive:true}); });
  const request = async (path, body, headers = {}) => {
    const requestHeaders = { authorization:'Bearer ' + new URL(app.launchUrl).hash.slice(1), 'content-type':'application/json', 'x-workbench-request':'1', ...headers };
    if (requestHeaders.authorization === null) delete requestHeaders.authorization;
    const response = await fetch(app.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {status:response.status, data:await response.json(), headers:response.headers};
  };
  const page = await fetch(app.url);
  assert.equal(page.status,200);
  assert.match(await page.text(),/CTF Workbench/);
  assert.match(page.headers.get('content-security-policy'),/default-src 'self'/);
  const input={title:'Local fixture',challenge_type:'misc',authorized_scope:'local-only'};
  const invalidTitle = Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0xff]),
    Buffer.from('","challenge_type":"misc","authorized_scope":"local-only"}')]);
  const malformed = await fetch(app.url + '/api/tasks', { method:'POST',
    headers:{ authorization:'Bearer ' + new URL(app.launchUrl).hash.slice(1),
      'content-type':'application/json', 'x-workbench-request':'1' }, body:invalidTitle });
  assert.equal(malformed.status,400);
  assert.deepEqual((await request('/api/tasks')).data,[]);
  assert.equal((await fetch(app.url+'/api/tasks')).status,401);
  for (const authorization of ['', 'Bearer wrong']) {
    assert.equal((await request('/api/tasks',input,{authorization})).status,401);
    assert.equal((await request('/api/tasks',undefined,{authorization})).status,401);
  }
  const hostStatus = await new Promise((resolve, reject) => {
    get(app.url + '/api/tasks', {headers:{host:'other.invalid'}}, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus,403);
  assert.deepEqual((await request('/api/tasks')).data,[]);
  assert.equal((await request('/api/tasks', input, {origin:'http://example.invalid'})).status,403);
  assert.equal((await request('/api/tasks', input, {'x-workbench-request':'0'})).status,403);
  const created=await request('/api/tasks',input);
  assert.equal(created.status,201);
  const id=created.data.task_id;
  const path='/api/tasks/'+id;
  const headers = { authorization:'Bearer ' + new URL(app.launchUrl).hash.slice(1) };
  for (const [route, method, allow] of [
    ['/app.js','PUT','GET'], ['/api/tools','PUT','GET'], ['/api/tasks','PUT','GET, POST'],
    [path,'PUT','GET'], [path+'/report','PUT','GET'], [path+'/pause','GET','POST']
  ]) {
    const response = await fetch(app.url + route, {method, headers});
    assert.equal(response.status,405,route);
    assert.equal(response.headers.get('allow'),allow,route);
    await response.json();
  }
  const other=(await request('/api/tasks',{...input,title:'Other task'})).data.task_id;
  assert.equal((await request('/api/tasks?category=misc&status=PREFLIGHT_PASSED')).data.length,2);
  assert.equal((await request(path)).data.title,'Local fixture');
  assert.equal((await request(path+'/pause',{})).data.status,'PAUSED');
  const operation={tool_id:'misc-local',operation:'base64-decode',operation_id:'decode',arguments:{file:'sample.b64'}};
  assert.equal((await request(path+'/execute',operation)).status,409);
  assert.equal((await request(path+'/resume',{})).data.status,'RUNNING');
  const folder = join(dataRoot, id);
  const snapshot = () => readdirSync(folder).sort().map(name => [name,readFileSync(join(folder,name))]);
  const before = snapshot();
  for (const authorization of [null,'Bearer wrong']) {
    for (const [url,body] of [['/api/tasks'],[path+'/report'],[path+'/attachments',{name:'a',base64:'YQ=='}],[path+'/execute',operation]]) {
      assert.equal((await request(url,body,{authorization})).status,401);
    }
  }
  assert.deepEqual(snapshot(),before);
  assert.equal((await request(path+'/execute',{...operation,arguments:{file:'../sample.b64'}})).status,409);
  assert.equal((await request(path+'/attachments',{name:'../canary',base64:'YQ=='})).status,400);
  assert.equal((await request(path+'/attachments',{name:'fixture.txt',base64:'YQ=='})).status,201);
  assert.equal((await request(path+'/execute',operation)).data.execution_status,'SUCCESS');
  const evidence=(await request(path)).data;
  assert.equal(evidence.files.length,2);
  assert.ok(evidence.files.every(file=>file.size>0&&file.sha256.startsWith('sha256:')));
  assert.ok(evidence.evidence.some(x=>x.type==='dispatch_rejected'));
  assert.ok(evidence.evidence.some(x=>x.type==='tool_result'));
  assert.equal((await request('/api/tasks/'+other)).data.files.length,0);
  const verification={operation_id:'decode',candidate:'flag{phase1b_misc}'};
  assert.equal((await request(path+'/verify',verification)).data.flag_status,'FORMAT_VALID');
  assert.equal((await request(path+'/verify',{...verification,expected:'flag{phase1b_misc}'})).data.flag_status,'FORMAT_VALID');
  assert.equal((await request('/api/tasks/'+other+'/close',{})).data.status,'INTERRUPTED');
  const report=await request(path+'/report');
  assert.match(report.headers.get('content-disposition'),/attachment/);
  assert.equal(report.data.flag_status,'FORMAT_VALID');
  assert.equal(report.data.status,'RUNNING');
  assert.equal(report.data.task_id,id);
  await app.close();
  app=await startConsole({dataRoot});
  const history=(await request(path)).data;
  assert.equal(history.title,'Local fixture');
  assert.equal(history.status,'INTERRUPTED');
  assert.equal(history.live,false);
  assert.equal((await request(path+'/execute',operation)).status,409);
});

test('Console accepts a JSON content type with an explicit UTF-8 charset', async t => {
  const dataRoot = mkdtempSync('data/console-');
  const app = await startConsole({ dataRoot });
  t.after(async () => { await app.close(); rmSync(dataRoot, { recursive: true }); });
  const response = await fetch(app.url + '/api/tasks', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + new URL(app.launchUrl).hash.slice(1),
      'x-workbench-request': '1',
      'content-type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({ title: '编码检查', challenge_type: 'misc', authorized_scope: 'local-only' })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).preflight_status, 'PASSED');
});

test('Console reports damaged history consistently without echoing journal contents', async t => {
  const dataRoot = mkdtempSync('data/console-');
  const id = 'ctf-00000000-0000-4000-8000-000000000000';
  mkdirSync(join(dataRoot, id));
  const journal = join(dataRoot, id, 'evidence.jsonl');
  const app = await startConsole({ dataRoot });
  t.after(async () => { await app.close(); rmSync(dataRoot, { recursive: true }); });
  const headers = { authorization: 'Bearer ' + new URL(app.launchUrl).hash.slice(1) };
  for (const damage of ['malformed JSON', 'invalid chain', 'directory', 'missing']) {
    await t.test(damage, async () => {
      if (damage === 'malformed JSON') writeFileSync(journal, 'private malformed record\n');
      if (damage === 'invalid chain') writeFileSync(journal, '{}\n');
      if (damage === 'directory') mkdirSync(journal);
      try {
        const list = await (await fetch(app.url + '/api/tasks', { headers })).json();
        assert.equal(list[0].status, 'RECOVERY_REQUIRED');
        assert.equal(list[0].error_category, 'INVALID_EVIDENCE');
        for (const suffix of ['', '/report']) {
          const response = await fetch(app.url + '/api/tasks/' + id + suffix, { headers });
          assert.equal(response.status, 409);
          assert.deepEqual(await response.json(), { error: '任务证据损坏，需要人工恢复', error_category: 'INVALID_EVIDENCE' });
        }
      } finally {
        if (damage !== 'missing') rmSync(journal, { recursive: damage === 'directory' });
      }
    });
  }
  const unknown = await fetch(app.url + '/api/tasks/ctf-00000000-0000-4000-8000-000000000001', { headers });
  assert.equal(unknown.status, 404);
});
