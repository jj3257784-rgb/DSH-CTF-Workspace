import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const denied = () => new Error('CTF session or workspace not authorized');

function inside(root, path) {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep);
}

export function checkedDirectory(root, path, optional = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || !inside(root, path)) throw denied();
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat && optional) return;
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw denied();
  }
  if (!inside(root, realpathSync(path))) throw denied();
}

export function authorizeWorkspace(ctx, workspaceId, root, exec) {
  const agent = exec?.agent;
  const session = agent?.session;
  const workspace = ctx.workspaceRegistry.get(workspaceId);
  const activeMember = () => typeof agent?.id === 'string'
    && agent.id === session?.id && session.header?.id === session.id
    && session.header.parentSession === undefined
    && ctx.agents.get(agent.id) === agent
    && workspace?.id === workspaceId && ctx.workspaceRegistry.get(workspaceId) === workspace
    && workspace.sessionIds.includes(session.id)
    && !ctx.workspaceRegistry.archivedSessionIds.includes(session.id);
  if (!activeMember() || !exec.callId || typeof exec.callId !== 'string'
    || typeof exec.signal?.throwIfAborted !== 'function'
    || typeof workspace.path !== 'string' || relative(root, realpathSync(workspace.path)) !== '') throw denied();
  exec.signal.throwIfAborted();
  checkedDirectory(root, session.header.cwd);
  const cwd = ctx.workingDirectory.get(session);
  checkedDirectory(root, cwd);
  checkedDirectory(root, join(root, 'fixtures', 'misc'));
  checkedDirectory(root, join(root, 'data'), true);
  exec.signal.throwIfAborted();
  if (!activeMember()) throw denied();
  return agent;
}
