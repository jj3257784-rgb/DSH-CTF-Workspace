import { readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readEvidence } from './evidence-store.js';

const limit = 64 * 1024 * 1024;
const require = createRequire(import.meta.url);

export function storeUpload(root, task, bytes, register) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(join(root, '.upload-quota.sqlite'), { timeout: 5000 });
  try {
    // SQLite releases this cross-process lock even if the writer is terminated.
    db.exec('BEGIN IMMEDIATE');
    let used = 0;
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^ctf-[a-f0-9-]{36}$/.test(dir.name)) continue;
      const folder = join(root, dir.name);
      const files = readdirSync(folder, {withFileTypes:true});
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.upload.bin')) used += lstatSync(join(folder, file.name)).size;
      }
      if (files.some(file => file.isFile() && /^[a-f0-9-]{36}\.bin$/.test(file.name))) {
        if (!files.some(file => file.isFile() && file.name === 'evidence.jsonl')) {
          throw new Error('无法核对历史附件用量');
        }
        for (const row of readEvidence(root, dir.name)) {
          if (row.type !== 'attachment_registered' || !/^[a-f0-9-]{36}\.bin$/.test(row.artifact_path)) continue;
          const stat = lstatSync(join(folder, row.artifact_path), {throwIfNoEntry:false});
          if (stat?.isFile()) used += stat.size;
        }
      }
    }
    if (used + bytes.length > limit) throw Object.assign(new Error('工作区上传附件总量限 64 MiB'), {http:413});
    const path = task.store.artifact(bytes, '.upload.bin');
    try {
      return register(path);
    } catch (error) {
      unlinkSync(join(root, task.decision.task_id, path));
      throw error;
    }
  } finally {
    db.close();
  }
}
