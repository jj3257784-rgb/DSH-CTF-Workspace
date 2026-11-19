const el = id => document.getElementById(id);
if (location.hash) {
  sessionStorage.setItem('workbench-token', location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
}
const authorization = 'Bearer ' + sessionStorage.getItem('workbench-token');
const categories = ['web', 'pwn', 'reverse', 'crypto', 'misc'];
const active = new Set(['PREFLIGHT_PASSED', 'RUNNING', 'PAUSED']);
const terminal = ['COMPLETED', 'FAILED', 'REJECTED', 'INTERRUPTED', 'RECOVERY_REQUIRED'];
const stage = {
  state:'任务状态', preflight:'Gateway 与工具路由', skill_load:'Skill 加载',
  knowledge_retrieval:'知识检索', dispatch:'工具派发', tool_result:'工具结果',
  dispatch_rejected:'执行拒绝', flag_candidate:'Flag 候选', flag_verification:'本地验证',
  attachment_registered:'附件登记'
};
let selected;
let detail;
let selectionVersion = 0;
let loadingDetail = false;
let tools = [];
let refreshing = false;
let renderedTaskList;
let renderedStats;

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function badge(status) {
  const kind = /REJECTED|FAILED|TIMEOUT/.test(status) ? 'bad'
    : /SUCCESS|PASSED|COMPLETED|VERIFIED|LOADED|RETRIEVED|VALID/.test(status) && status !== 'UNVERIFIED'
      ? 'ok' : 'wait';
  return node('span', status, 'tag ' + kind);
}

async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? {headers:{authorization}} : {
    method:'POST',
    headers:{authorization,'content-type':'application/json','x-workbench-request':'1'},
    body:JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error + (data.evidence_id ? ' · ' + data.evidence_id : ''));
  return data;
}

function message(text, kind = 'ok') {
  el('feedback').textContent = text;
  el('feedback').dataset.kind = kind;
}

function taskUrl(id = selected) { return '/api/tasks/' + id; }

el('report').addEventListener('click', async event => {
  event.preventDefault();
  const id = selected;
  if (!id) return;
  try {
    const report = await api(taskUrl(id) + '/report');
    const url = URL.createObjectURL(new Blob([JSON.stringify(report)], {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = id + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { message(error.message, 'bad'); }
});

function formValues(form) { return Object.fromEntries(new FormData(form)); }

function populateToolArguments() {
  const tool = tools.find(item => item.tool_id === el('tool').value);
  const list = el('arguments');
  list.replaceChildren();
  for (const key of tool?.allowed_arguments ?? []) {
    const field = node('label', key);
    const input = node('input');
    input.name = key;
    input.required = true;
    if (key === 'key') { input.type = 'number'; input.min = 0; input.max = 255; input.value = 0; }
    if (key === 'file') input.value = tool.tool_id === 'archive-local' ? 'phase2b.zip'
      : tool.tool_id === 'misc-local' ? 'sample.b64' : '';
    if (key === 'url') input.value = detail.authorized_scope + '/sample';
    field.append(input);
    list.append(field);
  }
}

function renderDetail(data) {
  detail = data;
  el('empty').hidden = true;
  el('task').hidden = false;
  el('task-id').textContent = data.task_id;
  el('task-title').textContent = data.title ?? '历史任务';
  el('report').href = taskUrl() + '/report';
  const facts = el('facts');
  facts.replaceChildren();
  for (const [label, value] of [
    ['状态', badge(data.status)], ['题型', data.challenge_type], ['授权范围', data.authorized_scope],
    ['Skill', [data.selected_skill_id, data.selected_skill_version, data.skill_load_status].filter(Boolean).join(' · ')],
    ['Flag', badge(data.flag_status)], ['执行许可', data.live ? '当前进程' : '历史只读'],
    ['恢复检查', data.recovery.required ? '待人工检查 · 不自动重放' : '—']
  ]) {
    const dd = node('dd');
    dd.append(value instanceof Node ? value : value || '—');
    facts.append(node('dt', label), dd);
  }
  const tool = el('tool');
  const currentTools = [...tool.options].map(option => option.value);
  if (JSON.stringify(currentTools) !== JSON.stringify(data.tool_allowlist)) {
    tool.replaceChildren(...data.tool_allowlist.map(id => new Option(id,id)));
    populateToolArguments();
  }
  const runnable = data.live && ['PREFLIGHT_PASSED','RUNNING'].includes(data.status);
  el('execute').querySelector('button').disabled = !runnable || !tool.value;
  el('verify').querySelectorAll('button').forEach(button => { button.disabled = !data.live || data.status !== 'RUNNING'; });
  el('attach').querySelector('button').disabled = !data.live;
  for (const button of document.querySelectorAll('[data-action]')) {
    const action = button.dataset.action;
    button.disabled = !data.live || !(action === 'pause' ? runnable
      : action === 'resume' ? data.status === 'PAUSED' : active.has(data.status));
  }

  el('candidates').replaceChildren(...data.candidates.map(record =>
    node('li', [record.operation_id, record.result_status, record.candidate_hash].join(' · '))));
  el('knowledge').replaceChildren(...data.evidence.filter(record => record.type === 'knowledge_retrieval').map(record =>
    node('li', [record.result_status, record.source_path, record.content_hash, record.evidence_id].filter(Boolean).join(' · '))));
  el('files').replaceChildren(...data.files.map(file =>
    node('li', [file.kind, file.name, file.path, file.available ? file.size + ' B' : '不可读', file.sha256].join(' · '))));
  const timeline = el('evidence');
  const open = new Set([...timeline.querySelectorAll('details[open]')].map(item => item.dataset.id));
  timeline.replaceChildren(...data.evidence.map(record => {
    const item = node('li');
    const expansion = node('details');
    expansion.dataset.id = record.evidence_id;
    expansion.open = open.has(record.evidence_id);
    const summary = node('summary');
    summary.append(node('time', new Date(record.timestamp).toLocaleTimeString()),
      node('span', stage[record.type] ?? record.type), badge(record.result_status ?? 'UNVERIFIED'),
      node('span', record.operation_id ?? ''), node('span', record.evidence_id, 'muted'),
      node('span', record.output_summary ?? record.error_category ?? '', 'muted'));
    expansion.append(summary);
    if (expansion.open) expansion.append(node('pre', JSON.stringify(record,null,2)));
    expansion.addEventListener('toggle', () => {
      if (expansion.open && !expansion.querySelector('pre')) expansion.append(node('pre', JSON.stringify(record,null,2)));
    });
    item.append(expansion);
    return item;
  }));
}

async function refresh(refreshedDetailId) {
  if (refreshing) return;
  refreshing = true;
  try {
    const id = selected;
    const version = selectionVersion;
    const tasks = await api('/api/tasks');
    const stat = [['全部任务',tasks.length], ['进行中',tasks.filter(x=>active.has(x.status)).length],
      ['本地已验证',tasks.filter(x=>x.flag_status==='LOCALLY_VERIFIED').length]];
    const statsKey = stat.map(([, count]) => count).join(',');
    if (statsKey !== renderedStats) {
      el('stats').replaceChildren(...stat.map(([label,count]) => {
        const box=node('div'); box.append(node('strong',count),node('span',label)); return box;
      }));
      renderedStats = statsKey;
    }
    const category = el('filter-category').value;
    const status = el('filter-status').value;
    const filtered = tasks.filter(task => (!category || task.challenge_type === category) && (!status || task.status === status));
    if (el('filter-order').value === 'oldest') filtered.reverse();
    const taskList = JSON.stringify([selected, filtered.map(task =>
      [task.task_id, task.title, task.challenge_type, task.created_at, task.status])]);
    if (taskList !== renderedTaskList) {
      el('tasks').replaceChildren(...filtered.map(task => {
        const item = node('li');
        const button = node('button');
        button.setAttribute('aria-current', String(task.task_id === selected));
        button.append(node('strong', task.title ?? task.task_id), node('span',
          [task.challenge_type, new Date(task.created_at).toLocaleString()].filter(Boolean).join(' · '),'muted'),badge(task.status));
        button.addEventListener('click', () => select(task.task_id));
        item.append(button); return item;
      }));
      renderedTaskList = taskList;
    }
    if (id && id !== refreshedDetailId && selectionVersion === version && !loadingDetail) {
      const current = await api(taskUrl(id));
      if (selectionVersion === version && JSON.stringify(current) !== JSON.stringify(detail)) {
        if (!detail) message('');
        renderDetail(current);
      }
    }
    el('connection').textContent = '本地已连接';
  } catch {
    el('connection').textContent = '本地连接或读取失败';
  } finally {
    refreshing = false;
  }
}

async function select(id) {
  const version = ++selectionVersion;
  loadingDetail = true;
  selected = id;
  detail = undefined;
  el('task').hidden = true;
  el('execute').reset();
  el('tool').replaceChildren();
  el('verify').reset();
  el('attach').reset();
  el('output').textContent = '';
  el('execution-output').hidden = true;
  message('');
  try {
    const data = await api(taskUrl(id));
    if (selectionVersion !== version) return;
    renderDetail(data);
    await refresh(id);
  } catch (error) {
    if (selectionVersion === version) message(error.message,'error');
  } finally {
    if (selectionVersion === version) loadingDetail = false;
  }
}

async function submit(button, work, id = selected) {
  button.disabled = true;
  message('等待本地响应…');
  try { await work(); }
  catch (error) { if (selected === id) message(error.message,'error'); }
  finally { button.disabled = false; await refresh(); }
}

function updateCreateTools() {
  const category = el('category').value;
  el('create').elements.authorized_scope.value = category === 'web' ? 'http://127.0.0.1:' : 'local-only';
  const fieldset = el('tool-options');
  fieldset.replaceChildren(node('legend','可选工具'));
  for (const tool of tools.filter(item => item.tool_id !== 'gdb' && item.supported_categories.includes(category))) {
    const label = node('label');
    const check = node('input');
    check.type = 'checkbox'; check.name = 'requested_tools'; check.value = tool.tool_id;
    check.disabled = !tool.execution_enabled;
    label.append(check, document.createTextNode(tool.tool_id + (check.disabled ? '（未安装或指纹不匹配）' : '')));
    fieldset.append(label);
  }
}

categories.forEach(category => {
  el('category').add(new Option(category.toUpperCase(),category));
  el('filter-category').add(new Option(category.toUpperCase(),category));
});
for (const status of [...active,...terminal]) el('filter-status').add(new Option(status,status));
el('category').value = 'misc';
el('category').addEventListener('change',updateCreateTools);
el('tool').addEventListener('change',populateToolArguments);
for (const id of ['filter-category','filter-status','filter-order']) el(id).addEventListener('change',refresh);
el('create').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const { title, challenge_type, authorized_scope, query } = formValues(form);
  const requested_tools = new FormData(form).getAll('requested_tools');
  submit(event.submitter, async () => {
    const result = await api('/api/tasks',{title,challenge_type,authorized_scope,requested_tools,
      ...(query ? {knowledge_query:{query}} : {})});
    await select(result.task_id);
    message(result.preflight_status === 'PASSED' ? '任务已创建，预检通过' : '预检拒绝 · ' + result.rejection_reason,
      result.preflight_status === 'PASSED' ? 'ok' : 'error');
  });
});

el('execute').addEventListener('submit', event => {
  event.preventDefault();
  const id = selected;
  const { tool_id, operation_id, ...args } = formValues(event.currentTarget);
  if (args.key !== undefined) args.key = Number(args.key);
  submit(event.submitter, async () => {
    const operation = tools.find(item=>item.tool_id===tool_id).supported_operations[0];
    const result = await api(taskUrl(id)+'/execute',{tool_id,operation_id,operation,arguments:args});
    if (selected !== id) return;
    el('output').textContent = JSON.stringify(result,null,2);
    el('execution-output').hidden = false;
    el('execution-output').open = true;
    el('verify').elements.operation_id.value = operation_id;
    message('执行完成 · ' + result.evidence_id);
  }, id);
});

for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => {
  const action = button.dataset.action;
  const id = selected;
  if (action === 'close' && !confirm('关闭后本次任务只能查询，且不会自动重放。确认关闭？')) return;
  submit(button, async () => {
    const result = await api(taskUrl(id)+'/'+action,{});
    if (selected === id) message(result.status);
  }, id);
});

el('verify').addEventListener('submit', event => {
  event.preventDefault();
  const {operation_id,candidate} = formValues(event.currentTarget);
  const action = event.submitter.value;
  const id = selected;
  submit(event.submitter, async () => {
    const result = await api(taskUrl(id)+'/'+action,{operation_id,candidate});
    if (selected === id) message(result.flag_status ?? result.result_status);
  }, id);
});

el('attach').addEventListener('submit', event => {
  event.preventDefault();
  const file = event.currentTarget.elements.file.files[0];
  const id = selected;
  submit(event.submitter, async () => {
    if (!file || file.size > 1024*1024) throw new Error('请选择不超过 1 MiB 的文件');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    const result = await api(taskUrl(id)+'/attachments',{name:file.name,base64:btoa(binary)});
    if (selected === id) message('附件已登记 · ' + result.evidence_id);
  }, id);
});

try { tools = await api('/api/tools'); updateCreateTools(); }
catch (error) { message(error.message,'error'); }
await refresh();
function refreshWhenVisible() {
  if (!document.hidden) void refresh();
}
document.addEventListener('visibilitychange', refreshWhenVisible);
setInterval(refreshWhenVisible,1500);
