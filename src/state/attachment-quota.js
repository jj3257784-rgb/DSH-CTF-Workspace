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
      let files;
      try {
        files = readdirSync(folder, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.upload.bin')) continue;
        const stat = lstatSync(join(folder, file.name), { throwIfNoEntry: false });
        if (stat?.isFile()) used += stat.size;
      }
      if (files.some(file => file.isFile() && /^[a-f0-9-]{36}\.bin$/.test(file.name))) {
        if (!files.some(file => file.isFile() && file.name === 'evidence.jsonl')) {
          throw new Error('无法核对历史附件用量');
        }
        const evidence = readEvidence(root, dir.name);
        if (!evidence.length) {
          if (!lstatSync(folder, { throwIfNoEntry: false })) continue;
          throw new Error('无法核对历史附件用量');
        }
        const registered = new Set(evidence
          .filter(row => row.type === 'attachment_registered')
          .map(row => row.artifact_path));
        for (const file of files) {
          if (!file.isFile() || !/^[a-f0-9-]{36}\.bin$/.test(file.name) || !registered.has(file.name)) continue;
          const stat = lstatSync(join(folder, file.name), {throwIfNoEntry:false});
          if (stat?.isFile()) used += stat.size;
        }
      }
    }
    if (used + bytes.length > limit) throw Object.assign(new Error('工作区上传附件总量限 64 MiB'), {http:413});
    const path = task.store.artifact(bytes, '.upload.bin');
    try {
      return register(path);
    } catch (error) {
      try {
        unlinkSync(join(root, task.decision.task_id, path));
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          throw Object.assign(new AggregateError([error, cleanupError], 'Attachment registration and cleanup failed'),
            { artifact_path: path });
        }
      }
      throw error;
    }
  } finally {
    db.close();
  }
}
