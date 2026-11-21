import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, listTools, readEvidence, selectOfflineMethodCard, verifyFlag } from '../index.js';
import { authorizeWorkspace, checkedDirectory } from './workspace-access.js';
import { checkScope } from '../gateway/entry-controller.js';

export const name = 'ctf-workspace';
export const inject = ['tools', 'agents', 'workspaceRegistry', 'workingDirectory'];
const project = fileURLToPath(new URL('../../', import.meta.url));
const categories = ['web', 'pwn', 'reverse', 'crypto', 'misc'];
// Desktop grants are always local-only, so checkScope can never accept web there.
const desktopCategories = ['pwn', 'reverse', 'crypto', 'misc'];
const desktopScope = 'local-only';
const string = { type: 'string' };
const desktopDeadlineSeconds = 90;
const miscSampleExpectedFlag = 'flag{phase1b_misc}';

export function apply(ctx, config) {
  const root = realpathSync(project);
  const { workspaceId } = config ?? {};
  const tool = desktopTool(ctx, config, root);
  const registrations = new Map();
  const unregister = agent => {
    const dispose = registrations.get(agent);
    registrations.delete(agent);
    dispose?.();
  };
  const reconcile = (workspace, archived) => {
    const members = new Set(typeof workspace?.path === 'string' && relative(root, workspace.path) === ''
      ? workspace.sessionIds : []);
    const eligible = new Set(ctx.agents.list().filter(agent => {
      const session = agent.session;
      return session?.id === agent.id && session.header?.id === agent.id
        && session.header.parentSession === undefined
        && members.has(agent.id) && !archived.includes(agent.id);
    }));
    for (const agent of registrations.keys()) {
      if (!eligible.has(agent)) unregister(agent);
    }
    for (const agent of eligible) {
      if (!registrations.has(agent)) registrations.set(agent, agent.ctx.tools.register(tool));
    }
  };
  const refresh = () => reconcile(ctx.workspaceRegistry.get(workspaceId), ctx.workspaceRegistry.archivedSessionIds);
  ctx.on('agent/created', refresh);
  ctx.on('agent/disposed', ({ agent }) => unregister(agent));
  ctx.on('domain/changed', change => {
    if (change.domain !== 'workspace') return;
    if (change.table === 'workspaces' && change.key === workspaceId) {
      // The storage notification precedes the Workspace object's snapshot update.
      reconcile(change.operation === 'put' ? change.value : undefined, ctx.workspaceRegistry.archivedSessionIds);
    } else if (change.table === '' && change.operation === 'put') {
      reconcile(ctx.workspaceRegistry.get(workspaceId), change.value.archivedSessionIds);
    }
  });
  ctx.effect(() => () => {
    for (const agent of registrations.keys()) unregister(agent);
  }, 'ctf-workspace scoped tool cleanup');
  refresh();
}

export function registerDesktopTool(ctx, config, workspacePath) {
  ctx.tools.register(desktopTool(ctx, config, realpathSync(workspacePath)));
}

function desktopTool(ctx, config, root) {
  const workspaceId = config?.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new Error('CTF requires a trusted Workspace registration ID');
  }
  const handlers = new Map();
  return {
    ...desktopContract,
    async execute(args, exec) {
      const agent = authorizeWorkspace(ctx, workspaceId, root, exec);
      const sessionId = agent.session.id;
      const entry = handlers.get(sessionId);
      if (entry && entry.agent !== agent) throw new Error('CTF session grant cannot survive Agent replacement');
      if (args?.action === 'offline-method-card') {
        const material = args.material;
        if (!material || !['web', 'crypto'].includes(material.category)
          || ['source', 'httpRecord'].some(key => material[key] !== undefined
            && (typeof material[key] !== 'string' || material[key].length > 16384))) {
          throw new Error('Invalid offline material');
        }
        return { knowledge: selectOfflineMethodCard(material) };
      }
      let handler = entry?.handler;
      if (!handler) {
        if (args?.action !== 'start') throw new Error('No authorized CTF task');
        // Validate before reserving the grant: a mistyped start must stay retryable
        // in the same session instead of leaving an orphaned grant directory behind.
        assertStartArgs(args, desktopCategories, desktopScope);
        const issuedAt = Date.now();
        reserveSession(root, workspaceId, sessionId);
        try {
          handler = createSessionHandler(ctx, {
            sessionId: agent.session.id, authorizedScope: desktopScope, expectedFlag: config.expectedFlag,
            binding: { workspaceId, agentId: agent.id, workspaceRoot: root,
              issuedAt, expiresAt: issuedAt + desktopDeadlineSeconds * 1000 }
          }, root);
          const value = await handler(args, exec);
          handlers.set(sessionId, { agent, handler });
          return value;
        } catch (error) {
          await handler?.dispose?.();
          releaseSession(root, workspaceId, sessionId);
          throw error;
        }
      }
      return handler(args, exec);
    }
  };
}

function grantDirectory(root, workspaceId, sessionId) {
  const directory = join(root, 'data', 'desktop-session-grants');
  const key = createHash('sha256').update(JSON.stringify([workspaceId, sessionId])).digest('hex');
  return { directory, path: join(directory, key) };
}

function reserveSession(root, workspaceId, sessionId) {
  const { directory, path } = grantDirectory(root, workspaceId, sessionId);
  checkedDirectory(root, directory, true);
  mkdirSync(directory, { recursive: true });
  checkedDirectory(root, directory);
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('CTF session grant was already issued; open a new session');
  }
}

function releaseSession(root, workspaceId, sessionId) {
  const { directory, path } = grantDirectory(root, workspaceId, sessionId);
  checkedDirectory(root, directory, true);
  if (!existsSync(path)) return;
  checkedDirectory(root, directory);
  // A reservation is an empty directory. Preserve unexpected contents.
  rmdirSync(path);
}

function assertStartArgs(args, allowed, authorizedScope) {
  if (!allowed.includes(args?.category)) {
    const reason = allowed === desktopCategories && args?.category === 'web'
      ? '. Desktop Gateway does not execute Web tasks. Keep the Web classification and continue with offline review of supplied evidence.'
      : '';
    throw new Error(`Invalid task category: ${JSON.stringify(args?.category)} (expected one of: ${allowed.join(', ')})${reason}`);
  }
  if (typeof args.title !== 'string' || !args.title.trim()) {
    throw new Error('Invalid task title: a non-empty title is required');
  }
  assertKnowledgeArgs(args);
  if (!checkScope(args.category, authorizedScope)) {
    throw new Error(`Category "${args.category}" is not permitted with authorized scope "${authorizedScope}"`);
  }
}

function assertKnowledgeArgs({ query, tags }) {
  if (query !== undefined && (typeof query !== 'string' || query.length > 1024)) {
    throw new Error('Invalid knowledge query');
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.length > 16
    || Array.from(tags).some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 64))) {
    throw new Error('Invalid knowledge tags');
  }
}

function inspectTaskAttachment(root, attachmentPath) {
  if (typeof attachmentPath !== 'string' || !attachmentPath || attachmentPath.length > 1024
    || /[:\x00]/.test(attachmentPath) || isAbsolute(attachmentPath)
    || attachmentPath.split(/[\\/]/).includes('..')) {
    throw new Error('Expected a workspace-relative attachment path');
  }
  const path = join(root, attachmentPath);
  checkedDirectory(root, dirname(path));
  if (!lstatSync(path).isFile()) throw new Error('Expected a regular attachment file');
  const resolved = realpathSync(path);
  const within = relative(root, resolved);
  if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) {
    throw new Error('Attachment outside workspace');
  }
  const fd = openSync(resolved, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Expected a regular attachment file');
    const header = Buffer.alloc(64);
    const length = readSync(fd, header, 0, header.length, 0);
    const elf = length >= 4 && header.readUInt32BE(0) === 0x7f454c46;
    const bits = ({ 1: 32, 2: 64 })[header[4]];
    const order = header[5];
    const validHeader = elf && bits && length >= (bits === 64 ? 64 : 52) && [1, 2].includes(order);
    return {
      path: attachmentPath, format: elf ? 'ELF' : 'UNKNOWN', size: stat.size,
      ...(validHeader && {
        bits, machine: order === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18),
        entry: '0x' + (bits === 64
          ? (order === 1 ? header.readBigUInt64LE(24) : header.readBigUInt64BE(24))
          : (order === 1 ? header.readUInt32LE(24) : header.readUInt32BE(24))).toString(16)
      })
    };
  } finally {
    closeSync(fd);
  }
}

export function registerWorkspaceTool(ctx, config, workspacePath) {
  ctx.tools.register({ ...toolContract, execute: createSessionHandler(ctx, config, workspacePath) });
}

function createSessionHandler(ctx, config, workspacePath) {
  const { sessionId, authorizedScope, expectedFlag, binding } = config ?? {};
  if (typeof sessionId !== 'string' || !sessionId
    || !checkScope(authorizedScope === 'local-only' ? 'misc' : 'web', authorizedScope)
    || (expectedFlag !== undefined && verifyFlag(expectedFlag) !== 'FORMAT_VALID')) {
    throw new Error('CTF requires a trusted session grant');
  }
  const root = realpathSync(workspacePath);
  const core = createWorkspace(join(root, 'data'), join(root, 'fixtures/misc'));
  let permit;
  const miscSampleOperations = new Set();
  const queries = new Set();
  const documents = new Set();
  const preflightKnowledge = new Map();
  const attachmentTags = { ZIP: 'zip', PNG: 'png', WAVE: 'wave', BASE64: 'encoding' };

  function query(args) {
    return { query: args.query, tags: args.tags };
  }

  function queryKey(args) {
    const tags = Array.isArray(args.tags) ? [...new Set(args.tags)].sort() : args.tags ?? [];
    return JSON.stringify([args.query.trim().replace(/\s+/g, ' ').toLowerCase(), tags]);
  }

  function newKnowledge(found) {
    const results = (found?.results ?? []).filter(item => {
      if (documents.has(item.content_hash) || documents.size >= 9) return false;
      documents.add(item.content_hash);
      return true;
    });
    if (found.result_status === 'RETRIEVED' && !results.length) {
      return { ...found, result_status: 'SKIPPED', results };
    }
    return { ...found, results };
  }

  const pending = new Set();
  let disposed = false;
  let disposal;
  const execute = async (args, exec) => {
      const session = exec?.agent?.session;
      if (session?.id !== sessionId || typeof exec.callId !== 'string' || !exec.callId
        || typeof session.header?.cwd !== 'string' || (!binding && realpathSync(session.header.cwd) !== root)) {
        throw new Error('CTF session or workspace not authorized');
      }
      exec.signal?.throwIfAborted();
      if (binding && Date.now() >= binding.expiresAt && args?.action !== 'evidence') {
        throw new Error('CTF session grant expired');
      }
      const operationId = typeof args?.operation_id === 'string' && /^[\w-]{1,64}$/.test(args.operation_id)
        ? args.operation_id : 'dsh-' + createHash('sha256').update(exec.callId).digest('hex').slice(0, 40);
      const correlation = { ...binding, session_id: sessionId, call_id: exec.callId, operation_id: operationId };
      if (args?.action === 'start') {
        if (permit) throw new Error('CTF task already initialized for this grant');
        assertStartArgs(args, categories, authorizedScope);
        const attachment = ['pwn', 'reverse'].includes(args.category) && args.attachment_path !== undefined
          ? inspectTaskAttachment(root, args.attachment_path) : null;
        const tools = listTools(args.category).filter(tool => tool.execution_enabled);
        const decision = core.createTask({
          title: args.title, challenge_type: args.category, authorized_scope: authorizedScope,
          requested_tools: tools.map(tool => tool.tool_id), knowledge_query: query(args),
          budget_limit: { max_tool_calls: 6, max_runtime_seconds: binding ? desktopDeadlineSeconds : 300 }
        });
        if (decision.preflight_status !== 'PASSED') throw new Error(decision.rejection_reason);
        permit = decision;
        const evidence = core.recordHostProposal(permit, { ...correlation, task_id: permit.task_id });
        if (args.query?.trim()) queries.add(queryKey(args));
        const tryCategoryReference = ['misc', 'reverse', 'crypto'].includes(args.category)
          && args.query?.trim() && permit.knowledge?.result_status === 'NO_RESULT';
        const knowledge = tryCategoryReference
          ? { ...core.retrieveForSolver(permit, { tags: args.tags }), fallback: 'CATEGORY_REFERENCE' }
          : permit.knowledge;
        return {
          task_id: permit.task_id, evidence_id: evidence.evidence_id, skill: core.skillContext(permit),
          ...(attachment && { attachment }),
          knowledge: newKnowledge(knowledge), tools: tools.filter(tool => permit.tool_allowlist.includes(tool.tool_id))
            .map(({ tool_id, supported_operations, allowed_arguments }) => ({ tool_id, supported_operations, allowed_arguments }))
        };
      }
      if (permit?.preflight_status !== 'PASSED') throw new Error('No authorized CTF task');
      if (args.task_id !== undefined && args.task_id !== permit.task_id) throw new Error('CTF task identity mismatch');
      if (binding) {
        const taskRoot = join(root, 'data', permit.task_id);
        checkedDirectory(root, taskRoot);
        if (!lstatSync(join(taskRoot, 'evidence.jsonl')).isFile()) throw new Error('CTF audit unavailable');
      }
      const evidence = core.recordHostProposal(permit, { ...correlation, task_id: permit.task_id });
      const reference = { task_id: permit.task_id, proposal_evidence_id: evidence.evidence_id, operation_id: operationId };
      switch (args?.action) {
        case 'execute': {
          if (args.operation_id !== undefined && args.operation_id !== operationId) throw new Error('Invalid operation_id');
          try {
            const result = await core.executeTool(permit, {
              ...reference, tool_id: args.tool_id, operation: args.operation,
              arguments: args.arguments, authorized_scope: authorizedScope
            });
            if (binding && result.execution_status === 'SUCCESS' && args.tool_id === 'misc-local'
              && args.operation === 'base64-decode' && args.arguments?.file === 'sample.b64') {
              miscSampleOperations.add(operationId);
            }
            let tag;
            if (args.include_method_card !== false && args.tool_id === 'static-local'
              && result.execution_status === 'SUCCESS') {
              if (permit.challenge_type === 'misc') tag = attachmentTags[result.format];
              if (result.format === 'ELF' && permit.challenge_type === 'pwn') tag = 'elf';
              if (result.format === 'ELF' && permit.challenge_type === 'reverse') tag = 'static';
            }
            if (tag && !preflightKnowledge.has(result.evidence_id)) {
              const found = core.retrieveForSolver(permit, { tags: [tag] });
              preflightKnowledge.set(result.evidence_id, found);
              for (const card of found.results) documents.add(card.content_hash);
            }
            const knowledge = tag && preflightKnowledge.get(result.evidence_id);
            return { ...reference, ...result, value: typeof result.value === 'string'
              ? result.value.slice(0, 8192) : result.value ?? null,
              value_truncated: typeof result.value === 'string' && result.value.length > 8192,
              ...(knowledge && { knowledge }) };
          } catch (error) {
            if (!error.evidence_id) throw error;
            return { ...reference, evidence_id: error.evidence_id, execution_status: error.execution_status, reason: error.message };
          }
        }
        case 'pause':
          await core.pause(permit);
          return { ...reference, status: 'PAUSED' };
        case 'resume':
          core.resume(permit);
          return { ...reference, status: 'RUNNING' };
        case 'evidence':
          return { ...reference, evidence: readEvidence(join(root, 'data'), permit.task_id).slice(-10)
            .map(({ evidence_id, timestamp, type, result_status }) => ({ evidence_id, timestamp, type, result_status })) };
        case 'retrieve': {
          assertKnowledgeArgs(args);
          if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('Provide a focused query');
          const key = queryKey(args);
          if (queries.has(key) || queries.size >= 4) return { ...reference, status: 'SKIPPED', results: [] };
          queries.add(key);
          return { ...reference, knowledge: newKnowledge(core.retrieveForSolver(permit, query(args))) };
        }
        case 'skill':
          return { ...reference, skill: core.skillContext(permit, args.category) };
        case 'verify':
          if (args.operation_id !== operationId) throw new Error('Provide the successful operation_id');
          return { ...reference, status: await core.finish(permit, operationId, args.candidate,
            expectedFlag ?? (miscSampleOperations.has(operationId) ? miscSampleExpectedFlag : undefined)) };
        default:
          throw new Error('Unknown CTF action');
      }
  };
  const handler = (args, exec) => {
    if (disposed) return Promise.reject(new Error('CTF session handler disposed'));
    const work = execute(args, exec);
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  handler.dispose = () => {
    if (disposed) return disposal;
    disposed = true;
    if (!pending.size) return core.close();
    disposal = Promise.allSettled([...pending]).then(() => core.close());
    return disposal;
  };
  ctx.on('dispose', () => handler.dispose());
  return handler;
}

const toolContract = {
    name: 'ctf_workspace',
    description: 'Use the CTF Gateway in the designated workspace session. Classify then start, read returned Skill, execute permitted tools, inspect results, and verify. For Misc attachment preflight, execute static-local inspect-header to get format, size and any matching method card. Pass arguments.file as a filename directly under fixtures/misc, for example sample.b64. Omit the fixtures/misc/ prefix and any directory separators.',
    parameters: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'execute', 'retrieve', 'skill', 'verify', 'pause', 'resume', 'evidence'] },
        category: { type: 'string', enum: categories }, title: string, query: string,
        attachment_path: { type: 'string', description: 'For Pwn or Reverse start, pass the known workspace-relative path of the user-provided binary to automatically inspect its header. Extension is optional.' },
        tags: { type: 'array', items: string }, task_id: string, operation_id: string, tool_id: string,
        operation: string, arguments: { type: 'object', description: 'For strings-local, file must be a filename directly under fixtures/misc ending in .bin, .elf, .zip or .b64. A workspace attachment_path accepted by start is not an executor file grant. An .exe file is unsupported by strings-local.' }, candidate: string,
        include_method_card: { type: 'boolean', description: 'Set false on execute to return static observations without an automatic reference card.' }
      }
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    }
};

// The Desktop tool only ever runs with the local-only grant, so web is removed from
// the advertised enum instead of being offered and then rejected by checkScope.
const desktopContract = {
  ...toolContract,
  description: toolContract.description
    + ' Use offline-method-card with material.category web or crypto and supplied HTTP records, Node HTTP source, or explicit XOR parameters to select a reference card without starting a task.'
    + ' Desktop start grants are local-only: start.category must be pwn, reverse, crypto or misc. For a Web task, keep the Web classification and review supplied evidence offline. Each session can start one 90-second grant with at most 6 tool executions. Read the returned operation and argument allowlists before executing; this is a restricted fixture workspace, not a general challenge runner. value_truncated means the returned value is incomplete. LOCALLY_VERIFIED is local verification, not platform acceptance.',
  parameters: {
    ...toolContract.parameters,
    properties: {
      ...toolContract.parameters.properties,
      action: { type: 'string', enum: [...toolContract.parameters.properties.action.enum, 'offline-method-card'] },
      category: { type: 'string', enum: desktopCategories },
      material: {
        type: 'object', required: ['category'], additionalProperties: false,
        properties: {
          category: { type: 'string', enum: ['web', 'crypto'] },
          source: string, httpRecord: string,
          algorithm: string, ciphertext: string, key: { type: 'integer' }
        }
      }
    }
  }
};
