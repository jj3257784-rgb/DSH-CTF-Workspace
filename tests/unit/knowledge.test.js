import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWorkspace, readEvidence, retrieveKnowledge, searchKnowledge, selectOfflineMethodCard } from '../../src/index.js';
import { createKnowledgeSearch } from '../../src/knowledge/retrieval.js';
import { findMethodCard } from '../../src/knowledge/knowledge-search.js';

test('A corrupt legacy card manifest does not block Skill loading or verified retrieval', async t => {
  const root = setup(t);
  const core = createWorkspace(root);
  let corrupt = true;
  const original = fs.readFileSync;
  const spy = t.mock.method(fs, 'readFileSync', (path, ...args) =>
    corrupt && String(path).endsWith('/methods.json') ? Buffer.from('{') : original(path, ...args));
  syncBuiltinESMExports();
  try {
    await assert.doesNotReject(import('../../src/knowledge/knowledge-search.js?corrupt-manifest'));
    const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
    assert.equal(task.preflight_status, 'PASSED');
    assert.equal(task.skill_load_status, 'LOADED');
    assert.equal(task.selected_method_card, null);
    assert.equal(task.knowledge.result_status, 'RETRIEVED');
    assert.deepEqual(searchKnowledge({ type: 'misc' }), []);
    corrupt = false;
    assert.equal(findMethodCard('misc').id, 'misc-method-card');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    core.close();
  }
});

const sha = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const categories = ['web', 'pwn', 'reverse', 'crypto', 'misc'];

test('A damaged knowledge schema does not prevent workspace import or Skill loading', async t => {
  const read = fs.readFileSync;
  let damaged = true;
  const spy = t.mock.method(fs, 'readFileSync', (path, ...args) =>
    damaged && String(path).endsWith('document.schema.json') ? Buffer.from('{') : read(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  await assert.doesNotReject(import('../../src/knowledge/retrieval.js?damaged-schema'));
  const core = createWorkspace(setup(t));
  try {
    const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
    assert.equal(task.skill_load_status, 'LOADED');
    assert.equal(task.knowledge.result_status, 'READ_FAILED');
    assert.deepEqual(task.knowledge.issues, [{ error_category: 'INDEX_READ_FAILED' }]);
    damaged = false;
    assert.equal(retrieveKnowledge({ category: 'misc' }).result_status, 'RETRIEVED');
  } finally {
    core.close();
  }
});

test('Knowledge reports an index read failure for invalid UTF-8 in JSON', t => {
  const read = fs.readFileSync;
  const spy = t.mock.method(fs, 'readFileSync', (path, encoding) => {
    if (!String(path).endsWith('documents.json')) return read(path, encoding);
    const rows = JSON.parse(read(path, 'utf8'));
    rows[0].title = 'CORRUPT_TITLE';
    const [prefix, suffix] = JSON.stringify(rows).split('CORRUPT_TITLE');
    const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)]);
    return encoding === 'utf8' ? bytes.toString('utf8') : bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  assert.deepEqual(retrieveKnowledge({ category: 'web' }), {
    result_status: 'READ_FAILED', results: [], issues: [{ error_category: 'INDEX_READ_FAILED' }]
  });
});

test('Malformed knowledge rules fail before document matching and recover on the next lookup', t => {
  const read = fs.readFileSync;
  const changes = [
    schema => { schema.properties.source_path.pattern = '['; },
    schema => { delete schema.properties.tags.items; },
  ];
  let change;
  const spy = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const bytes = read(path, ...args);
    if (!change || !String(path).endsWith('document.schema.json')) return bytes;
    const schema = JSON.parse(bytes);
    change(schema);
    return Buffer.from(JSON.stringify(schema));
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  const core = createWorkspace(setup(t));
  try {
    for (change of changes) {
      const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
      assert.equal(task.skill_load_status, 'LOADED');
      assert.equal(task.knowledge.result_status, 'READ_FAILED');
      assert.deepEqual(task.knowledge.issues, [{ error_category: 'INDEX_READ_FAILED' }]);
      assert.deepEqual(searchKnowledge({ type: 'misc' }), []);
    }
    change = undefined;
    assert.equal(searchKnowledge({ type: 'misc' })[0]?.id, 'misc-method-card');
  } finally {
    core.close();
  }
});

test('Long sibling documents cannot exhaust the legacy method card budget', t => {
  const read = fs.readFileSync;
  const large = Buffer.from('x'.repeat(4096));
  const other = Buffer.from('y'.repeat(4096));
  const siblings = { 'png-structure-triage': large, 'wave-chunk-triage': other };
  const spy = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const name = String(path).replaceAll('\\', '/').split('/').pop();
    if (name === 'documents.json') {
      const rows = JSON.parse(read(path, ...args));
      for (const row of rows) {
        const bytes = siblings[row.document_id];
        if (bytes) {
          row.content_hash = sha(bytes);
          row.document_id = 'a-' + row.document_id;
        }
      }
      return Buffer.from(JSON.stringify(rows));
    }
    return siblings[name.replace(/\.md$/, '')] ?? read(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  assert.match(searchKnowledge({ type: 'misc' })[0]?.content ?? '', /^# misc 方法卡/);
});

for (const mode of ['changed', 'missing']) {
  test('Legacy knowledge search excludes ' + mode + ' method sources without blocking other cards', t => {
    const read = fs.readFileSync;
    const spy = t.mock.method(fs, 'readFileSync', (path, ...args) => {
      if (String(path).replaceAll('\\', '/').endsWith('/methods/web-method-card.md')) {
        if (mode === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return args[0] === 'utf8' ? 'untrusted replacement' : Buffer.from('untrusted replacement');
      }
      return read(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
    assert.equal(retrieveKnowledge({ category: 'web' }).result_status, 'READ_FAILED');
    assert.deepEqual(searchKnowledge({ type: 'web' }), []);
    assert.deepEqual(searchKnowledge({ tag: 'http' }), []);
    assert.equal(searchKnowledge({ type: 'crypto' }).length, 1);
  });
}

test('Legacy knowledge limits verified unique cards rather than manifest candidates', t => {
  const read = fs.readFileSync;
  const spy = t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const bytes = read(path, ...args);
    if (!String(path).endsWith('/methods.json')) return bytes;
    const cards = JSON.parse(bytes);
    const misc = cards.find(card => card.type === 'misc');
    const missing = { ...misc, source: 'knowledge/methods/missing.md' };
    return Buffer.from(JSON.stringify([...Array(5).fill(missing), misc, misc]));
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  assert.deepEqual(searchKnowledge({ type: 'misc' }).map(card => card.id), ['misc-method-card']);
});

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

test('Knowledge rejects a source that grows past the size cap between stat and read', t => {
  const root = setup(t);
  const larger = Buffer.alloc(256 * 1024 + 1, 'x');
  const entry = row(root, 'growing', 'short', { content_hash: sha(larger) });
  const read = fs.readFileSync;
  const spy = t.mock.method(fs, 'readFileSync', (path, ...args) =>
    path === resolve(root, 'growing.md') ? larger : read(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  assert.deepEqual(createKnowledgeSearch(root, [entry])({ category: 'web' }), {
    result_status: 'READ_FAILED', results: [],
    issues: [{ document_id: 'growing', error_category: 'SOURCE_READ_FAILED' }]
  });
});

test('Knowledge rejects invalid UTF-8 even when the source hash matches', t => {
  const root = setup(t);
  const invalid = Buffer.from([0x23, 0x20, 0xff]);
  const search = createKnowledgeSearch(root, [row(root, 'damaged', invalid)]);
  assert.deepEqual(search({ category: 'web' }), {
    result_status: 'READ_FAILED', results: [],
    issues: [{ document_id: 'damaged', error_category: 'SOURCE_READ_FAILED' }]
  });
});

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

test('Knowledge preserves the matched original text under both excerpt limits', t => {
  const root = setup(t);
  const search = createKnowledgeSearch(root, [row(root, 'mixed', 'İ🧪 KEY tail')]);
  for (const maxSnippetChars of [3, 32]) {
    const result = search({ category:'web', query:'key', maxSnippetChars, maxContextChars:3 });
    assert.equal(result.results[0].snippet, 'KEY');
  }
});

test('Knowledge excerpt limits preserve whole Unicode characters', t => {
  const root = setup(t);
  const search = createKnowledgeSearch(root, [
    row(root, 'emoji', '🧪 tail'),
    row(root, 'next', 'next')
  ]);
  for (const budgets of [
    { maxSnippetChars: 1, maxContextChars: 3 },
    { maxSnippetChars: 8, maxContextChars: 1 }
  ]) {
    const result = search({ category: 'web', limit: 1, ...budgets });
    assert.deepEqual(result.results.map(item => item.snippet), ['n']);
  }
});

test('Knowledge rejects indexed tag arrays with missing elements', t => {
  const root = setup(t);
  const invalid = row(root, 'invalid', 'fixture', { tags: [, 'http'] });
  const result = createKnowledgeSearch(root, [invalid])({ category: 'web' });
  assert.equal(result.result_status, 'REJECTED');
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.issues, [{ error_category: 'INVALID_METADATA' }]);
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
