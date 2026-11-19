import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, rmSync, readFileSync, renameSync, truncateSync } from 'node:fs';
import { createWorkspace } from '../../src/index.js';

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
