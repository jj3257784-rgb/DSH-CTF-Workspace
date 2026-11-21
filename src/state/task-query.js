import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './evidence-store.js';

const taskIdPattern = /^ctf-[a-f0-9-]{36}$/;
const terminal = new Set(['REJECTED', 'COMPLETED', 'FAILED', 'INTERRUPTED']);

function inspect(root, id, liveStatus) {
  if (typeof id !== 'string' || !taskIdPattern.test(id)) throw new Error('Invalid task ID');
  const dir = join(root, id);
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()
    || !lstatSync(join(dir, 'evidence.jsonl'), { throwIfNoEntry: false })?.isFile()) return null;

  let evidence;
  try {
    evidence = readEvidence(root, id);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const operations = new Map();
  const candidates = new Map();
  let preflight;
  let state;
  let flagStatus = 'NOT_FOUND';
  let skill;
  for (const record of evidence) {
    if (record.type === 'preflight') preflight = record;
    if (record.type === 'state') state = record;
    if (record.type === 'skill_load' && !record.advisory_only) skill = record;
    if (record.type === 'flag_verification' || (record.type === 'flag_candidate' && record.candidate_hash)) {
      flagStatus = record.result_status;
    }
    if (record.candidate_hash && ['flag_candidate', 'flag_verification'].includes(record.type)) {
      const key = record.operation_id + ':' + record.candidate_hash;
      if (record.type === 'flag_verification' || !candidates.has(key)) candidates.set(key, record);
    }
    if (record.type === 'dispatch') {
      operations.set(record.operation_id, {
        operation_id: record.operation_id, input_hash: record.input_hash, tool: record.tool,
        status: 'RUNNING', dispatch_evidence_id: record.evidence_id, result_evidence_id: null
      });
    }
    if (record.type === 'tool_result' && operations.has(record.operation_id)) {
      const operation = operations.get(record.operation_id);
      operation.status = record.result_status;
      operation.result_evidence_id = record.evidence_id;
    }
  }
  const recordedStatus = state?.result_status ?? null;
  const unresolved = [...operations.values()].filter(operation => !operation.result_evidence_id);
  const inconsistentCompletion = recordedStatus === 'COMPLETED' && unresolved.length > 0;
  const status = liveStatus ?? (terminal.has(recordedStatus) && !inconsistentCompletion
    ? recordedStatus : 'RECOVERY_REQUIRED');
  return {
    task_id: id,
    title: preflight?.title ?? null,
    challenge_type: preflight?.challenge_type ?? null,
    authorized_scope: preflight?.authorized_scope ?? null,
    selected_method_card: preflight?.selected_method_card ?? null,
    selected_skill_id: skill?.skill_id ?? null,
    selected_skill_version: skill?.skill_version ?? null,
    skill_load_status: skill?.result_status ?? null,
    skill_evidence_id: skill?.evidence_id ?? null,
    status,
    recorded_status: recordedStatus,
    created_at: evidence[0]?.timestamp ?? null,
    updated_at: evidence.at(-1)?.timestamp ?? null,
    error_category: state?.error_category ?? preflight?.error_category ?? null,
    flag_status: flagStatus,
    recovery: {
      required: status === 'INTERRUPTED' || status === 'RECOVERY_REQUIRED',
      auto_replay: false,
      unresolved_operations: unresolved.map(operation => operation.operation_id)
    },
    operations: [...operations.values()],
    candidates: [...candidates.values()],
    evidence
  };
}

export function inspectTask(root, id) {
  return inspect(root, id);
}

export function inspectLiveTask(root, id, status) {
  return inspect(root, id, status);
}

export function listTasks(root, statusFor = () => undefined, cache) {
  if (!lstatSync(root, { throwIfNoEntry: false })) {
    cache?.clear();
    return [];
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const ids = new Set(entries.filter(entry => entry.isDirectory() && taskIdPattern.test(entry.name))
    .map(entry => entry.name));
  if (cache) {
    for (const id of cache.keys()) {
      if (!ids.has(id)) cache.delete(id);
    }
  }
  return [...ids]
    .map(id => {
      try {
        const status = statusFor(id);
        const stat = cache && status == null && lstatSync(join(root, id, 'evidence.jsonl'), {
          bigint: true, throwIfNoEntry: false
        });
        const version = stat?.isFile?.() && [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('/');
        const cached = version && cache.get(id);
        if (cached && cached.version === version) return structuredClone(cached.summary);
        cache?.delete(id);
        const detail = inspect(root, id, status);
        if (!detail) throw new Error('Invalid task evidence chain');
        const { evidence, operations, candidates, ...summary } = detail;
        if (version) cache.set(id, { version, summary: structuredClone(summary) });
        return summary;
      } catch (error) {
        if (!(error instanceof SyntaxError) && error.message !== 'Invalid task evidence chain') throw error;
        return {
          task_id: id, status: 'RECOVERY_REQUIRED', recorded_status: null,
          created_at: null, updated_at: null, error_category: 'INVALID_EVIDENCE',
          flag_status: 'NOT_FOUND',
          recovery: { required: true, auto_replay: false, unresolved_operations: [] }
        };
      }
    })
    .sort((left, right) => (right.created_at ? Date.parse(right.created_at) : -Infinity)
      - (left.created_at ? Date.parse(left.created_at) : -Infinity)
      || left.task_id.localeCompare(right.task_id));
}

export function taskReport(root, id) {
  const detail = inspectTask(root, id);
  return detail === null ? null : JSON.stringify(detail, null, 2);
}
