import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWorkspace, listTools } from '../index.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const taskPath = /^\/api\/tasks\/(ctf-[a-f0-9-]{36})(?:\/(execute|pause|resume|close|candidate|verify|attachments|report))?$/;
const uploadLimit = 1024 * 1024;
const bodyLimit = 4 * Math.ceil(uploadLimit / 3) + 4096;

function reply(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  // Keep reading the bounded-memory stream so an oversized request can receive a response.
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= bodyLimit) chunks.push(chunk);
  }
  if (size > bodyLimit) throw Object.assign(new Error('请求体超过限制'), { http: 413 });
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error('请求必须是 JSON 对象'), { http: 400 });
  }
}

function decodeAttachment({ name, base64 }) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_. -]{1,120}$/u.test(name)
    || name === '.' || name === '..' || typeof base64 !== 'string'
    || base64.length > 4 * Math.ceil(uploadLimit / 3)) {
    throw Object.assign(new Error('附件名称或内容无效'), { http: 400 });
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > uploadLimit || bytes.toString('base64') !== base64) {
    throw Object.assign(new Error('附件必须是有效 Base64 且不超过 1 MiB'), { http: 400 });
  }
  return { name, bytes };
}

function fileList(root, detail) {
  return detail.evidence.flatMap(record => {
    const path = record.artifact_path;
    if (typeof path !== 'string' || !/^[a-f0-9-]{36}(?:\.upload)?\.bin$/.test(path)) return [];
    const stat = lstatSync(join(root, detail.task_id, path), { throwIfNoEntry: false });
    const available = stat?.isFile() === true;
    return [{
      name: record.attachment_name ?? path, path,
      kind: record.type === 'attachment_registered' ? 'INPUT' : 'ARTIFACT',
      size: available ? stat.size : null, sha256: record.artifact_hash ?? record.details?.artifact_hash ?? null,
      evidence_id: record.evidence_id, available
    }];
  });
}

export async function startConsole({ dataRoot = 'data', fixtureRoot = 'fixtures/misc', port = 0, host = '127.0.0.1' } = {}) {
  const root = resolve(dataRoot);
  const core = createWorkspace(root, fixtureRoot);
  const permits = new Map();
  const token = randomBytes(32).toString('hex');
  let origin;
  let closing;
  const server = createServer({ requestTimeout: 15000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (request.headers.host !== new URL(origin).host) return reply(response, 403, { error: 'Host 不受信任' });
    const method = request.method;
    if (method === 'POST' && ((request.headers.origin && request.headers.origin !== origin)
      || request.headers['x-workbench-request'] !== '1'
      || request.headers['content-type'] !== 'application/json')) {
      return reply(response, 403, { error: '仅允许本地工作台提交' });
    }
    try {
      const url = new URL(request.url, origin);
      const pathname = url.pathname;
      if (pathname.startsWith('/api/') && request.headers.authorization !== 'Bearer ' + token) {
        return reply(response, 401, { error: '请通过控制台启动链接访问' });
      }
      const asset = assets.get(pathname);
      if (method === 'GET' && asset) {
        const [file, type] = asset;
        const bytes = readFileSync(new URL('./public/' + file, import.meta.url));
        response.writeHead(200, { 'content-type': type });
        return response.end(bytes);
      }
      if (method === 'GET' && pathname === '/api/tools') return reply(response, 200, listTools());
      if (pathname === '/api/tasks') {
        if (method === 'GET') {
          const category = url.searchParams.get('category');
          const status = url.searchParams.get('status');
          const tasks = core.listTasks().filter(task => (!category || task.challenge_type === category)
            && (!status || task.status === status));
          if (url.searchParams.get('order') === 'oldest') tasks.reverse();
          return reply(response, 200, tasks);
        }
        if (method === 'POST') {
          const input = await body(request);
          if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120) {
            return reply(response, 400, { error: '请输入 1–120 字符的任务名称' });
          }
          const decision = core.createTask(input);
          if (decision.preflight_status === 'PASSED') permits.set(decision.task_id, decision);
          return reply(response, 201, decision);
        }
      }
      const match = taskPath.exec(pathname);
      if (!match) return reply(response, 404, { error: '页面或任务不存在' });
      const [, id, action] = match;
      const detail = core.taskDetail(id);
      if (!detail) return reply(response, 404, { error: '任务不存在' });
      const permit = permits.get(id);
      if (method === 'GET' && (!action || action === 'report')) {
        const data = {
          ...detail, live: Boolean(permit), tool_allowlist: permit?.tool_allowlist ?? [],
          files: fileList(root, detail),
          unresolved: [
            ...detail.recovery.unresolved_operations.map(op => '待检查操作 ' + op),
            ...(detail.flag_status === 'LOCALLY_VERIFIED' ? [] : ['尚无本地验证的 Flag'])
          ]
        };
        return reply(response, 200, data, action === 'report'
          ? { 'content-disposition': 'attachment; filename="' + id + '.json"' } : {});
      }
      if (method !== 'POST' || !action || action === 'report') return reply(response, 405, { error: '操作不受支持' });
      if (!permit) return reply(response, 409, { error: '任务没有本进程执行许可' });
      const input = await body(request);
      if (action === 'execute') {
        const result = await core.executeTool(permit, { ...input, task_id: id, authorized_scope: permit.authorized_scope });
        return reply(response, 200, result);
      }
      if (action === 'pause') await core.pause(permit);
      if (action === 'resume') core.resume(permit);
      if (action === 'close') {
        core.closeTask(permit);
        permits.delete(id);
        return reply(response, 200, { status: core.taskDetail(id).status });
      }
      if (action === 'candidate') return reply(response, 201, await core.recordCandidate(permit, input.operation_id, input.candidate));
      if (action === 'verify') return reply(response, 200, {
        flag_status: await core.finish(permit, input.operation_id, input.candidate)
      });
      if (action === 'attachments') {
        const { name, bytes } = decodeAttachment(input);
        return reply(response, 201, core.registerAttachment(permit, name, bytes));
      }
      return reply(response, 200, { status: core.status(permit) });
    } catch (error) {
      return reply(response, error.http ?? (error.code ? 500 : 409), {
        error: error.code ? '本地存储或运行时错误' : error.message,
        evidence_id: error.evidence_id ?? null
      });
    }
  });
  server.listen(port, host);
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    url: origin,
    launchUrl: origin + '/#' + token,
    close() {
      closing ??= new Promise((done, reject) => {
        server.close(error => {
          if (error) return reject(error);
          try { core.close(); done(); } catch (failure) { reject(failure); }
        });
      });
      return closing;
    }
  };
}
