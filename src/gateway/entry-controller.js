import { createHash, randomUUID } from 'node:crypto';
import { loadSkill } from '../skills/loader.js';
import { retrieveForTask } from '../knowledge/task-retrieval.js';
import { capabilities, route } from './capability-router.js';
import { audit } from './audit-recorder.js';
import { createTaskState } from '../state/task-state.js';
import { createEvidenceStore } from '../state/evidence-store.js';

const permits = new WeakSet();

export function hasGatewayPermit(decision) { return permits.has(decision); }

export function checkScope(type, scope) {
  if (type !== 'web') return scope === 'local-only';
  if (typeof scope !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(scope)) return false;
  return Number(scope.split(':').at(-1)) <= 65535;
}

export function preflight(root, input = {}) {
  const id = 'ctf-' + randomUUID();
  const store = createEvidenceStore(root, id);
  const state = createTaskState(store);
  state.transition('PREFLIGHT_PENDING');
  const { challenge_type: type, authorized_scope: scope, budget_limit: budget = {
    max_tool_calls: 20, max_runtime_seconds: 300
  } } = input ?? {};
  const validType = typeof type === 'string' && Object.hasOwn(capabilities, type);
  let reason = null;
  if (!validType) reason = 'INVALID_TYPE';
  else if (!checkScope(type, scope)) reason = 'INVALID_SCOPE';
  else if (!Number.isInteger(budget?.max_tool_calls) || budget.max_tool_calls < 1 || budget.max_tool_calls > 20
    || !Number.isInteger(budget.max_runtime_seconds) || budget.max_runtime_seconds < 1
    || budget.max_runtime_seconds > 300) reason = 'INVALID_BUDGET';

  const selection = reason ? { card: null, tools: [] } : route(type, input?.requested_tools);
  reason ??= selection.reason ?? null;
  let skill = {};
  let loaded;
  if (!reason) {
    const identity = { operation_id: 'skill:load', skill_id: 'ctf-' + type };
    const invoked = audit(store, 'skill_load', 'INVOKED', identity);
    let failedVersion;
    try {
      loaded = loadSkill(type, selection.tools);
    } catch (error) {
      reason = error.message;
      failedVersion = error.skillVersion;
    }
    const result = audit(store, 'skill_load', reason ? 'LOAD_FAILED' : 'LOADED', {
      ...identity,
      source_evidence_id: invoked.evidence_id,
      skill_version: loaded?.metadata.version ?? failedVersion ?? null,
      error_category: reason,
      content_hash: loaded ? 'sha256:' + createHash('sha256').update(loaded.body).digest('hex') : null
    });
    skill = {
      selected_skill_id: identity.skill_id,
      selected_skill_version: result.skill_version,
      skill_load_status: result.result_status,
      skill_evidence_id: result.evidence_id
    };
  }
  const knowledge = !reason || input?.knowledge_query !== undefined
    ? retrieveForTask(store, validType ? type : null, input?.knowledge_query, skill, reason)
    : null;
  const decision = Object.freeze({
    ...(knowledge ? { knowledge } : {}),
    ...skill,
    task_id: id, challenge_type: validType ? type : null,
    authorized_scope: reason ? null : scope,
    selected_method_card: selection.card?.id ?? null,
    tool_allowlist: Object.freeze(reason ? [] : selection.tools),
    budget_limit: reason ? null : Object.freeze({
      max_tool_calls: budget.max_tool_calls, max_runtime_seconds: budget.max_runtime_seconds
    }),
    preflight_status: reason ? 'REJECTED' : 'PASSED'
  });
  audit(store, 'preflight', decision.preflight_status, {
    title: typeof input?.title === 'string'
      ? input.title.trim().toWellFormed().slice(0, 120).replace(/[\uD800-\uDBFF]$/, '') : null,
    error_category: reason, challenge_type: decision.challenge_type,
    authorized_scope: decision.authorized_scope,
    tool_allowlist: decision.tool_allowlist,
    selected_method_card: decision.selected_method_card
  });
  state.transition(reason ? 'REJECTED' : 'PREFLIGHT_PASSED', reason);
  if (!reason) permits.add(decision);
  return { decision, reason, state, store, loadedSkill: loaded };
}

