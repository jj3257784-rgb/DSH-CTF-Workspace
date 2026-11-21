import { appendFileSync, mkdirSync, readFileSync, existsSync, lstatSync, truncateSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

function evidencePath(root, id) {
  if (typeof id !== 'string' || !/^ctf-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task ID');
  return join(root, id, 'evidence.jsonl');
}

export function readEvidence(root, id) {
  const path = evidencePath(root, id);
  const directory = lstatSync(join(root, id), { throwIfNoEntry: false });
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error('Invalid task evidence chain');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile()) throw new Error('Invalid task evidence chain');
  const bytes = readFileSync(path);
  const tailStart = bytes.lastIndexOf(10) + 1;
  const complete = bytes.subarray(0, tailStart);
  if (!isUtf8(complete)) throw new Error('Invalid task evidence chain');
  const text = complete.toString('utf8');
  const records = [];
  let start = 0;
  for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
    const recordEnd = text[end - 1] === '\r' ? end - 1 : end;
    if (recordEnd > start) records.push(JSON.parse(text.slice(start, recordEnd)));
    start = end + 1;
  }
  // A killed process can leave an incomplete final record.
  const tailBytes = bytes.subarray(tailStart);
  const tail = isUtf8(tailBytes) ? tailBytes.toString('utf8') : '';
  if (tail?.trim()) {
    try { records.push(JSON.parse(tail)); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const ids = new Set();
  let previous = null;
  let lastTimestamp;
  for (const record of records) {
    if (!record || record.task_id !== id || record.previous_evidence_id !== previous
      || typeof record.type !== 'string' || !record.type.trim()
      || typeof record.result_status !== 'string' || !record.result_status.trim()
      || typeof record.evidence_id !== 'string' || !record.evidence_id || ids.has(record.evidence_id)
      || typeof record.timestamp !== 'string'
      || (record.timestamp !== lastTimestamp && !Number.isFinite(Date.parse(record.timestamp)))) {
      throw new Error('Invalid task evidence chain');
    }
    ids.add(record.evidence_id);
    previous = record.evidence_id;
    lastTimestamp = record.timestamp;
  }
  return records;
}

export function createEvidenceStore(root, id) {
  const path = evidencePath(root, id);
  const directory = dirname(path);
  mkdirSync(root, { recursive: true });
  mkdirSync(directory);
  writeFileSync(path, '', { flag: 'wx' });
  let previous = null;
  let journalFailure;
  function checkWritableDirectory() {
    if (journalFailure) throw journalFailure;
    if (!lstatSync(directory).isDirectory()) throw new Error('Invalid task evidence chain');
  }
  return {
    append(type, fields) {
      checkWritableDirectory();
      const record = {
        tool: null, tool_version: null, purpose: null, input_hash: null,
        exit_code: null, output_summary: null, artifact_path: null,
        ...fields, type, task_id: id, evidence_id: randomUUID(),
        timestamp: new Date().toISOString(), previous_evidence_id: previous
      };
      const line = JSON.stringify(record) + '\n';
      const journal = lstatSync(path);
      if (!journal.isFile()) throw new Error('Invalid task evidence chain');
      try {
        appendFileSync(path, line, { flush: true });
      } catch (error) {
        try {
          truncateSync(path, journal.size);
        } catch (rollbackError) {
          journalFailure = new AggregateError([error, rollbackError], 'Evidence append and rollback failed');
          throw journalFailure;
        }
        throw error;
      }
      previous = record.evidence_id;
      return record;
    },
    artifact(value, suffix = '.bin') {
      checkWritableDirectory();
      const relative = randomUUID() + suffix;
      const target = join(directory, relative);
      try {
        writeFileSync(target, value, { flag: 'wx', flush: true });
      } catch (error) {
        if (error.code !== 'EEXIST' && existsSync(target)) {
          try {
            unlinkSync(target);
          } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') {
              throw Object.assign(new AggregateError([error, cleanupError], 'Artifact write and cleanup failed'),
                { artifact_path: relative });
            }
          }
        }
        throw error;
      }
      return relative;
    }
  };
}

export function historicalStatus(root, id) {
  let chain = [];
  try {
    chain = readEvidence(root, id);
  } catch (error) {
    if (error.code === 'EISDIR' || error instanceof SyntaxError || error.message === 'Invalid task evidence chain') {
      return 'RECOVERY_REQUIRED';
    }
    if (error.code !== 'ENOENT') throw error;
  }
  const last = chain.findLast(record => record.type === 'state');
  if (!last) {
    const directory = lstatSync(join(root, id), { throwIfNoEntry: false });
    return directory?.isDirectory() ? 'RECOVERY_REQUIRED' : null;
  }
  if (last.result_status === 'COMPLETED') {
    const unresolved = new Set();
    for (const record of chain) {
      if (record.type === 'dispatch') unresolved.add(record.operation_id);
      if (record.type === 'tool_result') unresolved.delete(record.operation_id);
    }
    if (unresolved.size) return 'RECOVERY_REQUIRED';
  }
  return ['REJECTED', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(last.result_status)
    ? last.result_status : 'RECOVERY_REQUIRED';
}
