import { join, resolve } from 'node:path';
import { loadSkill } from './skills/loader.js';
import { retrieveForTask } from './knowledge/task-retrieval.js';
import { toolDefinition } from './executor/tool-registry.js';
import { performance } from 'node:perf_hooks';
import { preflight } from './gateway/entry-controller.js';
import { audit } from './gateway/audit-recorder.js';
import { createHash } from 'node:crypto';
import { verifyFlag } from './state/flag-verifier.js';
import { storeUpload } from './state/attachment-quota.js';
import { inspectLiveTask, listTasks } from './state/task-query.js';




function hash(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function matchesOutput(result, candidate, tool) {
  const exactLine = tool === 'strings-local' && typeof candidate === 'string'
    && typeof result.value === 'string' && result.value.split(/\r?\n/).includes(candidate);
  return (result.value === candidate || exactLine) && result.round_trip !== false;
}

export function composeWorkspace(createExecutor, root, fixtureRoot) {
  const tasks = new Map();
  const summaries = new Map();
  let closed = false;
  const executor = createExecutor(permit => tasks.has(permit), resolve(fixtureRoot));
  root = resolve(root);

  function find(permit) {
    const task = tasks.get(permit);
    if (!task) throw new Error('Missing Gateway permit');
    return task;
  }

  function liveStatus(id) {
    return [...tasks.values()].find(task => task.decision.task_id === id)?.state.status;
  }

  function reject(task, operation, tool, reason) {
    const record = audit(task.store, 'dispatch_rejected', 'REJECTED', {
      operation_id: operation, tool, error_category: reason
    });
    throw Object.assign(new Error(reason), { execution_status: 'REJECTED', evidence_id: record.evidence_id });
  }

  async function run(task, operation, tool, prepared, remaining) {
    const fields = {
      operation_id: operation, tool, tool_version: prepared.version,
      purpose: tool, operation: prepared.operation, input_hash: prepared.digest,
      environment: process.platform
    };
    audit(task.store, 'dispatch', 'RUNNING', fields);
    task.calls++;
    try {
      const { artifact, value, metrics, ...details } = await prepared.run(remaining, join(root, task.decision.task_id));
      const artifactPath = artifact ? task.store.artifact(artifact) : null;
      const resultHash = typeof value === 'string' ? hash(value) : null;
      const artifactPaths = artifactPath ? [artifactPath] : [];
      const output = {
        exit_code: 0, stdout_summary: typeof value === 'string' ? Buffer.byteLength(value) + ' bytes' : null,
        stderr_summary: null,
        output_hash: artifact ? hash(artifact) : metrics?.output_hash ?? resultHash ?? hash(JSON.stringify(details)),
        ...metrics
      };
      const record = audit(task.store, 'tool_result', 'SUCCESS', {
        ...fields, ...output, output_summary: 'Adapter completed',
        artifact_path: artifactPath, artifact_paths: artifactPaths,
        result_hash: resultHash,
        details: ['crypto-local', 'python-local'].includes(tool) ? { round_trip: details.round_trip,
          intermediate_hash: hash(details.intermediate_hex) } : details
      });
      return { ...details, ...output, value, artifact_path: artifactPath,
        execution_status: 'SUCCESS', input_hash: prepared.digest, tool_version: prepared.version,
        artifact_paths: artifactPaths,
        result_hash: resultHash, evidence_id: record.evidence_id };
    } catch (error) {
      const category = error.name === 'AbortError' ? 'TIMEOUT'
        : ['OUTPUT_LIMIT', 'HTTP_STATUS', 'INVALID_BASE64', 'TIMEOUT', 'TOOL_EXIT_NONZERO'].includes(error.message)
          ? error.message : 'ADAPTER_ERROR';
      const execution_status = category === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED';
      const output = {
        exit_code: Object.hasOwn(error, 'exit_code') ? error.exit_code : 1,
        stdout_summary: error.stdout_summary ?? null, stderr_summary: error.stderr_summary ?? null,
        output_hash: error.output_hash ?? null
      };
      const record = audit(task.store, 'tool_result', execution_status, {
        ...fields, ...output, error_category: category, output_summary: 'Adapter failed'
      });
      task.state.transition('FAILED', category);
      throw Object.assign(new Error(category), output, {
        execution_status, input_hash: prepared.digest, tool_version: prepared.version,
        artifact_paths: [], evidence_id: record.evidence_id
      });
    }
  }

  function interruptTasks(reason) {
    const failures = [];
    for (const task of tasks.values()) {
      if (['PREFLIGHT_PASSED', 'RUNNING', 'PAUSED'].includes(task.state.status)) {
        try {
          task.state.transition('INTERRUPTED', reason);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Could not persist interrupted tasks');
  }
  const interrupt = () => interruptTasks('PROCESS_EXIT');

  const api = {
    createTask(input) {
      if (closed) throw new Error('Workspace closed');
      const task = preflight(root, input);
      if (task.reason) return Object.freeze({ ...task.decision, rejection_reason: task.reason });
      if (!tasks.size) process.once('exit', interrupt);
      tasks.set(task.decision, {
        ...task, operations: new Map(), active: null, pausing: false, calls: 0,
        attachmentBytes: 0, attachmentCount: 0,
        deadline: performance.now() + task.decision.budget_limit.max_runtime_seconds * 1000
      });
      return task.decision;
    },

    status(permit) { return find(permit).state.status; },

    listTasks() { return listTasks(root, liveStatus, summaries); },

    taskDetail(id) { return inspectLiveTask(root, id, liveStatus(id)); },

    async recordCandidate(permit, operation, candidate) {
      const task = find(permit);
      const entry = task.operations.get(operation);
      if (!entry) throw new Error('Missing operation evidence');
      if (verifyFlag(candidate) !== 'FORMAT_VALID') throw new Error('Invalid candidate format');
      const result = await entry.work;
      if (find(permit) !== task || task.state.status !== 'RUNNING' || task.pausing) {
        throw new Error('Task cannot record candidate');
      }
      if (performance.now() >= task.deadline) throw new Error('Task deadline expired');
      if (!matchesOutput(result, candidate, entry.tool)) throw new Error('Candidate does not match operation output');
      return audit(task.store, 'flag_candidate', 'FORMAT_VALID', {
        operation_id: operation, source_evidence_id: result.evidence_id,
        candidate_hash: hash(candidate)
      });
    },

    skillContext(permit, category = permit.challenge_type) {
      const task = find(permit);
      if (category === permit.challenge_type) return structuredClone(task.loadedSkill);
      if (task.secondary?.metadata.category === category) return structuredClone(task.secondary);
      if (task.secondaryAttempted || !['web', 'pwn', 'reverse', 'crypto', 'misc'].includes(category)) {
        throw new Error('Secondary Skill limit');
      }
      task.secondaryAttempted = true;
      const fields = { operation_id: 'skill:secondary', skill_id: 'ctf-' + category, advisory_only: true };
      const invoked = audit(task.store, 'skill_load', 'INVOKED', fields);
      let loaded;
      try {
        const tools = { web: ['web-local'], crypto: ['crypto-local'], misc: ['misc-local'] };
        loaded = loadSkill(category, tools[category] ?? []);
      } catch (error) {
        audit(task.store, 'skill_load', 'LOAD_FAILED', {
          ...fields, source_evidence_id: invoked.evidence_id, error_category: error.message,
          skill_version: error.skillVersion ?? null
        });
        throw error;
      }
      audit(task.store, 'skill_load', 'LOADED', {
        ...fields, source_evidence_id: invoked.evidence_id, skill_version: loaded.metadata.version,
        content_hash: hash(loaded.body)
      });
      task.secondary = loaded;
      return structuredClone(loaded);
    },

    retrieveForSolver(permit, request) {
      const task = find(permit);
      return retrieveForTask(task.store, permit.challenge_type, request, permit, null);
    },

    recordHostProposal(permit, correlation) {
      return audit(find(permit).store, 'host_tool_proposal', 'PROPOSED', correlation);
    },

    recordModelUsage(permit, usage) {
      const task = find(permit);
      return audit(task.store, 'model_call', usage.status, {
        model: usage.model, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens
      });
    },

    async executeTool(permit, request) {
      const task = find(permit);
      if (!request || request.task_id !== permit.task_id || request.authorized_scope !== permit.authorized_scope) {
        return reject(task, null, null, 'Invalid task or scope');
      }
      const { operation_id, tool_id, operation, arguments: args } = request;
      if (!permit.tool_allowlist.includes(tool_id)) return reject(task, null, null, 'Tool outside allowlist');
      if (!toolDefinition(tool_id)?.supported_operations.includes(operation)) {
        return reject(task, null, tool_id, 'Operation outside allowlist');
      }
      return api.execute(permit, operation_id, tool_id, args);
    },

    async execute(permit, operation, tool, input) {
      const task = find(permit);
      if (closed || task.pausing || !['PREFLIGHT_PASSED', 'RUNNING'].includes(task.state.status)) {
        return reject(task, null, null, 'Task not runnable');
      }
      if (typeof operation !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(operation)) {
        return reject(task, null, null, 'Invalid operation ID');
      }
      if (!permit.tool_allowlist.includes(tool)) return reject(task, operation, null, 'Tool outside allowlist');
      if (performance.now() >= task.deadline) return reject(task, operation, tool, 'Budget exhausted');
      let prepared;
      try {
        prepared = executor.prepare(permit, tool, input);
      } catch {
        return reject(task, operation, tool, 'Invalid input or target outside scope');
      }
      const previous = task.operations.get(operation);
      if (previous && previous.digest !== prepared.digest) {
        return reject(task, operation, tool, 'Operation input changed');
      }
      if (previous) return structuredClone(await previous.work);
      if (task.active) return reject(task, operation, tool, 'Task already executing');
      const remaining = Math.floor(task.deadline - performance.now());
      if (remaining < 1 || task.calls >= permit.budget_limit.max_tool_calls) {
        return reject(task, operation, tool, 'Budget exhausted');
      }
      if (task.state.status === 'PREFLIGHT_PASSED') task.state.transition('RUNNING');
      const work = run(task, operation, tool, prepared, remaining);
      task.active = work;
      task.operations.set(operation, { digest: prepared.digest, tool, work });
      try {
        return structuredClone(await work);
      } finally {
        task.active = null;
      }
    },

    async pause(permit) {
      const task = find(permit);
      if (task.pausing || !['PREFLIGHT_PASSED', 'RUNNING'].includes(task.state.status)) {
        throw new Error('Task cannot pause');
      }
      task.pausing = true;
      try {
        if (task.active) await task.active;
        if (task.state.status === 'PREFLIGHT_PASSED') task.state.transition('RUNNING');
        task.state.transition('PAUSED');
      } finally {
        task.pausing = false;
      }
    },

    resume(permit) {
      const task = find(permit);
      if (task.state.status !== 'PAUSED') throw new Error('Task is not paused');
      task.state.transition('RUNNING');
    },

    finish(permit, operation, candidate, expected) {
      const task = find(permit);
      if (task.state.status !== 'RUNNING' || task.active || task.pausing) throw new Error('Task cannot finish');
      if (!task.operations.has(operation)) throw new Error('Missing operation evidence');
      return task.operations.get(operation).work.then(result => {
        if (task.state.status !== 'RUNNING' || task.active || task.pausing) throw new Error('Task cannot finish');
        if (performance.now() >= task.deadline) throw new Error('Task deadline expired');
        const matches = matchesOutput(result, candidate, task.operations.get(operation).tool);
        const status = verifyFlag(candidate, matches ? expected : null);
        audit(task.store, 'flag_verification', status, {
          candidate_hash: typeof candidate === 'string' ? hash(candidate) : null,
          operation_id: operation, source_evidence_id: result.evidence_id
        });
        if (status === 'LOCALLY_VERIFIED') task.state.transition('COMPLETED');
        return status;
      });
    },

    closeTask(permit) {
      const task = find(permit);
      if (task.active || task.pausing) throw new Error('Task operation in flight');
      if (['PREFLIGHT_PASSED', 'RUNNING', 'PAUSED'].includes(task.state.status)) {
        task.state.transition('INTERRUPTED', 'USER_CLOSED');
      }
      tasks.delete(permit);
      if (!tasks.size) process.removeListener('exit', interrupt);
    },

    registerAttachment(permit, name, bytes) {
      const task = find(permit);
      if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024 || typeof name !== 'string'
        || !/^[\p{L}\p{N}_. -]{1,120}$/u.test(name) || name === '.' || name === '..') {
        throw new Error('Invalid attachment');
      }
      if (task.attachmentCount >= 64 || task.attachmentBytes + bytes.length > 16 * 1024 * 1024) {
        throw Object.assign(new Error('每个任务最多上传 64 个附件，合计 16 MiB'), { http: 413 });
      }
      const record = storeUpload(root, task, bytes, artifact_path =>
        audit(task.store, 'attachment_registered', 'REGISTERED', {
          attachment_name: name, artifact_path, artifact_hash: hash(bytes), size: bytes.length
        }));
      task.attachmentCount++;
      task.attachmentBytes += bytes.length;
      return record;
    },

    close() {
      if ([...tasks.values()].some(task => task.active || task.pausing)) throw new Error('Task operation in flight');
      if (!closed) interruptTasks('WORKSPACE_CLOSED');
      closed = true;
      process.removeListener('exit', interrupt);
      tasks.clear();
    }
  };
  return api;
}
