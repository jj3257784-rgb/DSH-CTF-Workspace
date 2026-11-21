import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdtempSync, readdirSync, rmSync, readFileSync, renameSync, truncateSync } from 'node:fs';
import { createWorkspace } from '../../src/index.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { storeUpload } from '../../src/state/attachment-quota.js';

test('Upload cleanup preserves the registration error and reports a second failure', t => {
  const root = mkdtempSync('data/quota-rollback-');
  t.after(() => rmSync(root, { recursive: true }));
  const task_id = 'ctf-00000000-0000-0000-0000-000000000001';
  const folder = join(root, task_id);
  fs.mkdirSync(folder);
  const filename = 'artifact.upload.bin';
  const path = join(folder, filename);
  const task = { decision: { task_id }, store: { artifact(bytes) {
    fs.writeFileSync(path, bytes);
    return filename;
  } } };
  const registrationError = new Error('registration failed');
  const cleanupError = new Error('cleanup failed');
  const originalUnlink = fs.unlinkSync;
  let failCleanup = false;
  const spy = t.mock.method(fs, 'unlinkSync', target => {
    if (target === path && failCleanup) throw cleanupError;
    return originalUnlink(target);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => storeUpload(root, task, Buffer.from('attachment'), () => {
      originalUnlink(path);
      throw registrationError;
    }), error => error === registrationError);
    failCleanup = true;
    assert.throws(() => storeUpload(root, task, Buffer.from('attachment'), () => {
      throw registrationError;
    }), error => error instanceof AggregateError
      && error.errors[0] === registrationError && error.errors[1] === cleanupError);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('workspace upload tolerates a previously listed attachment disappearing', t => {
  const root = mkdtempSync('data/quota-disappear-');
  const core = createWorkspace(root);
  t.after(() => { core.close(); rmSync(root, { recursive: true }); });
  const task = core.createTask({ challenge_type: 'misc', authorized_scope: 'local-only' });
  const old = core.registerAttachment(task, 'old', Buffer.from('old'));
  const vanished = resolve(root, task.task_id, old.artifact_path);
  const stat = fs.lstatSync;
  const spy = t.mock.method(fs, 'lstatSync', (path, options) => {
    if (path === vanished && fs.existsSync(vanished)) fs.unlinkSync(vanished);
    return stat(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(core.registerAttachment(task, 'new', Buffer.from('new')).result_status, 'REGISTERED');
    assert.equal(fs.existsSync(vanished), false);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('workspace upload handles a historical task directory disappearing during the scan', t => {
  const root = mkdtempSync('data/quota-disappear-');
  const core = createWorkspace(root);
  t.after(() => { core.close(); rmSync(root, { recursive: true }); });
  const input = { challenge_type: 'misc', authorized_scope: 'local-only' };
  const historical = core.createTask(input);
  core.closeTask(historical);
  const current = core.createTask(input);
  const folder = resolve(root, historical.task_id);
  const original = fs.readdirSync;
  let removeFromScan = false;
  const spy = t.mock.method(fs, 'readdirSync', (path, options) => {
    if (path === folder) {
      if (!removeFromScan) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      renameSync(folder, join(root, 'moved-task'));
    }
    return original(path, options);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => core.registerAttachment(current, 'denied', Buffer.from('sample')), { code: 'EACCES' });
    removeFromScan = true;
    assert.equal(core.registerAttachment(current, 'accepted', Buffer.from('sample')).result_status, 'REGISTERED');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('workspace upload refuses to undercount legacy attachments when their journal disappears', t => {
  const root = mkdtempSync('data/quota-legacy-');
  const core = createWorkspace(root);
  t.after(() => { core.close(); rmSync(root, { recursive: true }); });
  const input = { challenge_type: 'misc', authorized_scope: 'local-only' };
  const historical = core.createTask(input);
  const current = core.createTask(input);
  const row = core.registerAttachment(historical, 'legacy', Buffer.from('sample'));
  core.closeTask(historical);
  const folder = resolve(root, historical.task_id);
  const journal = join(folder, 'evidence.jsonl');
  const contents = readFileSync(journal, 'utf8');
  const legacy = row.artifact_path.replace('.upload.bin', '.bin');
  renameSync(join(folder, row.artifact_path), join(folder, legacy));
  const legacyContents = contents.replace(row.artifact_path, legacy);
  fs.writeFileSync(journal, legacyContents);
  const stat = fs.lstatSync;
  const spy = t.mock.method(fs, 'lstatSync', (target, options) => {
    if (target === journal && fs.existsSync(journal)) fs.unlinkSync(journal);
    return stat(target, options);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => core.registerAttachment(current, 'new', Buffer.from('sample')), /无法核对历史附件用量/);
    assert.deepEqual(readdirSync(join(root, current.task_id)), ['evidence.jsonl']);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
    fs.writeFileSync(journal, legacyContents);
  }
  assert.equal(core.registerAttachment(current, 'retry', Buffer.from('sample')).result_status, 'REGISTERED');
});

test('workspace upload quota includes historical attachments and serializes independent writers', async t => {
  const root = mkdtempSync('data/quota-');
  t.after(() => rmSync(root,{recursive:true}));
  const input = {challenge_type:'misc',authorized_scope:'local-only'};
  const first = createWorkspace(root);
  const old = first.createTask(input);
  const row = first.registerAttachment(old,'legacy',Buffer.alloc(1));
  first.close();
  // Stand in for historical uploads with one sparse legacy artifact.
  const dir = join(root,old.task_id);
  const legacy = row.artifact_path.replace('.upload.bin','.bin');
  renameSync(join(dir,row.artifact_path),join(dir,legacy));
  const fs = await import('node:fs');
  const log = join(dir,'evidence.jsonl');
  fs.writeFileSync(log,readFileSync(log,'utf8').replace(row.artifact_path,legacy));
  // Two historical references to one file consume its disk space only once.
  const last = JSON.parse(readFileSync(log,'utf8').trimEnd().split('\n').at(-1));
  fs.appendFileSync(log, JSON.stringify({ ...row, artifact_path:legacy,
    evidence_id:'repeated-registration', previous_evidence_id:last.evidence_id }) + '\n');
  truncateSync(join(dir,legacy),64*1024*1024-1);
  const worker = `
    import {createWorkspace} from './src/index.js';
    const core=createWorkspace(process.argv[1]);
    const task=core.createTask({challenge_type:'misc',authorized_scope:'local-only'});
    try {core.registerAttachment(task,'one',Buffer.alloc(1));console.log('accepted')}
    catch(e){if(e.http!==413)throw e;console.log('full')}
    finally {core.close()}`;
  const run = () => promisify(execFile)(process.execPath,['--input-type=module','-e',worker,root]);
  const results = await Promise.all([run(),run()]);
  assert.deepEqual(results.map(r=>r.stdout.trim()).sort(),['accepted','full']);
  const next = createWorkspace(root);
  t.after(()=>next.close());
  assert.equal(next.taskDetail(old.task_id).task_id,old.task_id);
  const task = next.createTask(input);
  const folder = join(root,task.task_id);
  const files = readdirSync(folder);
  const before = readFileSync(join(folder,'evidence.jsonl'));
  assert.throws(()=>next.registerAttachment(task,'over',Buffer.alloc(1)),e=>e.http===413);
  assert.deepEqual(readdirSync(folder),files);
  assert.deepEqual(readFileSync(join(folder,'evidence.jsonl')),before);
  next.close();
});
