import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWorkspace, readEvidence, retrieveKnowledge, selectOfflineMethodCard } from '../../src/index.js';
import { createKnowledgeSearch } from '../../src/knowledge/retrieval.js';

const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const categories = ['web', 'pwn', 'reverse', 'crypto', 'misc'];

test('offline method selection requires explicit applicable material', () => {
  const card = input => selectOfflineMethodCard(input).results[0]?.document_id;
  assert.equal(card({ category: 'crypto', algorithm: 'XOR', ciphertext: '4c46', key: 42 }), 'crypto-method-card');
  assert.equal(card({ category: 'crypto', algorithm: 'AES', ciphertext: '4c46', key: 42 }), undefined);
  assert.equal(card({ category: 'crypto', algorithm: 'XOR', ciphertext: '4c46' }), undefined);
  assert.equal(card({ category: 'web', httpRecord: 'GET /health HTTP/1.1\nHTTP/1.1 502 Bad Gateway' }), 'web-method-card');
  assert.equal(card({ category: 'web', source: "import { createServer } from 'node:http';" }), 'web-method-card');
  assert.equal(card({ category: 'web', source: "const http = require('node:http');" }), 'web-method-card');
  assert.equal(card({ category: 'web', source: "const $http = require('node:http');" }), 'web-method-card');
  assert.equal(card({ category: 'web', source: "const note = \"from 'node:http'\";\n// require('node:http');" }), undefined);
  assert.equal(card({ category: 'web', source: "/*\nimport http from 'node:http';\n*/" }), undefined);
  assert.equal(card({ category: 'web', source: "const example = `\nconst http = require('node:http');\n`;" }), undefined);
  assert.equal(card({ category: 'web', source: "/* example */\nimport http from 'node:http';" }), 'web-method-card');
  assert.equal(card({ category: 'web', httpRecord: 'Service unavailable' }), undefined);
  assert.equal(card({ category: 'web', httpRecord: 'GET /health HTTP/1.1 trailing garbage' }), undefined);
  assert.equal(card({ category: 'web', httpRecord: 'GET /health HTTP/1.1\r\nHost: example.test' }), 'web-method-card');
});

function setup(t) {
  const root = mkdtempSync('data/knowledge-');
  t.after(() => rmSync(root, { recursive: true }));
  return root;
}

function row(root, id, text, overrides = {}) {
  writeFileSync(join(root, id + '.md'), text);
  return { document_id:id, title:id, category:'web', tags:['http'], summary:'fixture',
    source_path:id + '.md', version:'1.0.0', content_hash:sha(text), trust:'reference-only', ...overrides };
}

test('Knowledge default index filters all five categories and exact tags', () => {
  for (const category of categories) {
    const result = retrieveKnowledge({category});
    assert.equal(result.result_status, 'RETRIEVED');
    assert.ok(result.results.every(x => x.category === category));
    assert.ok(result.results.some(x => x.document_id === `${category}-method-card`));
  }
  assert.equal(retrieveKnowledge({category:'web', tags:['elf']}).result_status, 'NO_RESULT');
  assert.equal(retrieveKnowledge({category:'web', query:'doesnotexist'}).result_status, 'NO_RESULT');
});

test('Knowledge rejects missing elements in query tags', () => {
  assert.deepEqual(retrieveKnowledge({ category: 'misc', tags: Array(1) }), {
    result_status: 'REJECTED', results: [], issues: [{ error_category: 'INVALID_QUERY' }]
  });
});

test('Knowledge reports unknown tags without relaxing known filters', t => {
  const root = setup(t);
  const search = createKnowledgeSearch(root, [
    row(root, 'first', 'first'),
    row(root, 'second', 'second', { tags: ['tls'] }),
    row(root, 'invalid', 'invalid', { category: 'misc', tags: ['typo'], trust: 'invalid' }),
  ]);
  assert.deepEqual(search({ category: 'web', tags: ['http', 'typo'] }), {
    result_status: 'REJECTED', results: [],
    issues: [{ error_category: 'UNKNOWN_TAGS', tags: ['typo'] }],
  });
  assert.equal(search({ category: 'web', tags: ['http', 'tls'] }).result_status, 'NO_RESULT');
});

test('Knowledge deterministic full-text ranking and context caps', t => {
  const root = setup(t);
  const index = ['d', 'c', 'b', 'a'].map(id => row(root, id, id + ' '.repeat(25) + 'needle tail',
    {title: id === 'd' ? 'needle' : id}));
  const search = createKnowledgeSearch(root, index);
  const defaultResult = search({category:'web', query:'needle'});
  assert.deepEqual(defaultResult.results.map(x => x.document_id), ['d','a','b']);
  assert.equal(search({category:'web', query:'tail', limit:1, maxSnippetChars:11})
    .results[0].snippet, 'needle tail');
  const capped = search({category:'web', query:'needle', tags:['http'], limit:2, maxSnippetChars:9, maxContextChars:15});
  assert.equal(capped.results.length, 2);
  assert.ok(capped.results[0].snippet.includes('needle'));
  assert.ok(capped.results.every(x => x.snippet.length <= 9));
  assert.ok(capped.results.reduce((n,x)=>n+x.snippet.length,0) <= 15);
  assert.deepEqual(search({category:'web', tags:['not-present']}).results, []);
});

test('Knowledge missing, changed and escaping sources are never cited as retrieved', t => {
  const root = setup(t);
  const missing = row(root, 'missing', 'missing');
  rmSync(join(root,'missing.md'));
  const changed = row(root,'changed','original');
  writeFileSync(join(root,'changed.md'),'tampered');
  const escape = row(root,'escape','escape',{source_path:'../outside.md'});
  const search = createKnowledgeSearch(root,[missing,changed,escape]);
  const result = search({category:'web'});
  assert.deepEqual(result.results, []);
  assert.equal(result.result_status, 'READ_FAILED');
  assert.deepEqual(result.issues.map(x => x.error_category), ['SOURCE_READ_FAILED','HASH_MISMATCH','INVALID_METADATA']);
  assert.equal(search({category:'web',source_path:'../outside.md'}).result_status,'REJECTED');
  assert.equal(createKnowledgeSearch(root,[escape])({category:'web'}).result_status,'REJECTED');
});

test('Knowledge Gateway keeps permissions and evidence scoped per task', async t => {
  const root = mkdtempSync('data/knowledge-');
  const core = createWorkspace(root);
  t.after(() => { core.close(); rmSync(root, { recursive: true }); });
  const rejected = core.createTask({challenge_type:'crypto', knowledge_query:{query:'反向验证'}});
  assert.equal(rejected.preflight_status,'REJECTED');
  const denied = readEvidence(root,rejected.task_id).find(x=>x.type==='knowledge_retrieval');
  assert.equal(denied.result_status,'REJECTED');
  assert.equal(denied.source_path,null);
  await assert.rejects(core.execute(rejected,'one','crypto-local',{}),/permit/);
  const crypto = core.createTask({challenge_type:'crypto',authorized_scope:'local-only',knowledge_query:{query:'反向验证'}});
  const pwn = core.createTask({challenge_type:'pwn',authorized_scope:'local-only'});
  assert.deepEqual(crypto.tool_allowlist,['crypto-local']);
  assert.deepEqual(pwn.tool_allowlist,[]);
  assert.equal(crypto.knowledge.results[0].category,'crypto');
  assert.equal(pwn.knowledge.results[0].category,'pwn');
  assert.notEqual(crypto.knowledge.query_id,pwn.knowledge.query_id);
  const chain = readEvidence(root,crypto.task_id);
  const record = chain.find(x=>x.evidence_id===crypto.knowledge.results[0].evidence_id);
  assert.equal(record.task_id,crypto.task_id);
  assert.equal(record.skill_id,crypto.selected_skill_id);
  assert.equal(record.source_evidence_id,crypto.skill_evidence_id);
  assert.equal(record.result_status,'RETRIEVED');
  assert.equal(record.content_hash,crypto.knowledge.results[0].content_hash);
  assert.ok(record.retrieval_timestamp);
  assert.ok(!JSON.stringify(chain).includes(crypto.knowledge.results[0].snippet));
  t.diagnostic(JSON.stringify({ rejected: denied, retrieved: record }));
});

test('Knowledge rejects an indexed junction targeting outside its root', t => {
  const parent = setup(t);
  const root = join(parent, 'trusted');
  const outside = join(parent, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const entry = row(outside, 'canary', 'synthetic private text', {source_path:'escape/canary.md'});
  symlinkSync(resolve(outside), join(root, 'escape'), 'junction');
  const result = createKnowledgeSearch(root, [entry])({category:'web'});
  assert.equal(result.result_status, 'REJECTED');
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.issues, [{document_id:'canary', error_category:'SOURCE_OUTSIDE_ROOT'}]);
});
