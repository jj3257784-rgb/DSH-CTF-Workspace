import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../src/console/public/app.js', import.meta.url), 'utf8');

async function mount(respond) {
  class Element {
    listeners = {};
    dataset = {};
    children = [];
    value = '';
    addEventListener(name, handler) { this.listeners[name] = handler; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    add(child) { this.append(child); }
    setAttribute(name, value) { this[name] = value; }
    reset() {}
  }
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('create').values = { title: 'Sample', challenge_type: 'misc', authorized_scope: 'local-only' };
  await runInNewContext('(async () => {\n' + source + '\n})()', {
    document: {
      getElementById: get, createElement: () => new Element(),
      querySelectorAll: () => [], addEventListener() {}
    },
    location: { hash: '' }, sessionStorage: { getItem: () => 'sample-token' },
    Option: class {}, setInterval() {},
    FormData: class {
      constructor(form) { this.values = form.values; }
      [Symbol.iterator]() { return Object.entries(this.values)[Symbol.iterator](); }
      getAll() { return []; }
    },
    fetch: async (path, options) => {
      const [status, body] = await respond(path, options);
      return { ok: status < 400, status, json: async () => body };
    }
  });
  return get;
}

test('A created task preserves its detail error when the initial detail request fails', async () => {
  const id = 'ctf-00000000-0000-4000-8000-000000000001';
  let detailReads = 0;
  const get = await mount((path, options) => {
    if (path === '/api/tasks' && options.method === 'POST') {
      return [201, { task_id: id, preflight_status: 'PASSED' }];
    }
    if (path === '/api/tasks/' + id) {
      if (++detailReads === 1) return [409, { error: '任务证据损坏，需要人工恢复' }];
      return new Promise(() => {});
    }
    return [200, []];
  });
  const form = get('create');
  form.listeners.submit({ currentTarget: form, submitter: { form }, preventDefault() {} });
  await setImmediate();
  assert.equal(get('feedback').textContent, '任务证据损坏，需要人工恢复');
  assert.equal(get('feedback').dataset.kind, 'error');
  assert.equal(get('task').hidden, true);
});

test('A late create response preserves a task selected while creation was pending', async () => {
  const existingId = 'ctf-00000000-0000-4000-8000-000000000001';
  const newId = 'ctf-00000000-0000-4000-8000-000000000002';
  const creation = Promise.withResolvers();
  const requested = [];
  const get = await mount((path, options) => {
    requested.push(path);
    if (path === '/api/tasks' && options.method === 'POST') return creation.promise;
    if (path === '/api/tasks') return [200, [{ task_id: existingId, title: 'Existing', status: 'INTERRUPTED' }]];
    if (path === '/api/tasks/' + existingId) return [409, { error: 'Existing task needs recovery' }];
    return [200, []];
  });
  const form = get('create');
  form.listeners.submit({ currentTarget: form, submitter: { form }, preventDefault() {} });
  await get('tasks').children[0].children[0].listeners.click();
  creation.resolve([201, { task_id: newId, preflight_status: 'PASSED' }]);
  await setImmediate();
  assert.ok(!requested.includes('/api/tasks/' + newId));
  assert.equal(get('feedback').textContent, 'Existing task needs recovery');
});

test('An expired console launch token gives a recovery instruction during startup', async () => {
  const get = await mount(path => path === '/api/tools'
    ? [401, { error: '请通过控制台启动链接访问' }] : [200, []]);
  assert.equal(get('connection').textContent, '请通过控制台启动链接访问');
});
