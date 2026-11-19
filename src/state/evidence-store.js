import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function evidencePath(root, id) {
  if (typeof id !== 'string' || !/^ctf-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task ID');
  return join(root, id, 'evidence.jsonl');
}

export function readEvidence(root, id) {
  const path = evidencePath(root, id);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const records = [];
  let start = 0;
  for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
    if (end > start) records.push(JSON.parse(text.slice(start, end)));
    start = end + 1;
  }
  // A killed process can leave an incomplete final record.
  const tail = text.slice(start);
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
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, id));
  writeFileSync(path, '', { flag: 'wx' });
  let previous = null;
  return {
    append(type, fields) {
      const record = {
        tool: null, tool_version: null, purpose: null, input_hash: null,
        exit_code: null, output_summary: null, artifact_path: null,
        ...fields, type, task_id: id, evidence_id: randomUUID(),
        timestamp: new Date().toISOString(), previous_evidence_id: previous
      };
      appendFileSync(path, JSON.stringify(record) + '\n', { flush: true });
      previous = record.evidence_id;
      return record;
    },
    artifact(value, suffix = '.bin') {
      const relative = randomUUID() + suffix;
      const target = join(root, id, relative);
      try {
        writeFileSync(target, value, { flag: 'wx', flush: true });
      } catch (error) {
        if (error.code !== 'EEXIST' && existsSync(target)) unlinkSync(target);
        throw error;
      }
      return relative;
    }
  };
}

export function historicalStatus(root, id) {
  let chain;
  try {
    chain = readEvidence(root, id);
  } catch (error) {
    if (error instanceof SyntaxError || error.message === 'Invalid task evidence chain') return 'RECOVERY_REQUIRED';
    throw error;
  }
  const last = chain.findLast(record => record.type === 'state');
  if (!last) return chain.length ? 'RECOVERY_REQUIRED' : null;
  return ['REJECTED', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(last.result_status)
    ? last.result_status : 'RECOVERY_REQUIRED';
}
