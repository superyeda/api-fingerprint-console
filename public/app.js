(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusLabels = {
    match: ['指纹匹配', 'green'], suspect: ['疑似变化', 'amber'],
    inconclusive: ['暂不确定', 'neutral'], technical_error: ['技术错误', 'red'],
    skipped: ['已跳过', 'neutral'],
  };
  const intervals = [1, 2, 3, 4, 6, 8, 12, 24];
  let state = null;
  let csrfToken = '';
  let online = false;
  let writing = false;
  let refreshing = null;
  let pollTimer = null;
  let settingsDirty = false;
  let notificationsDirty = false;
  let testPending = false;
  let testCooldownUntil = 0;
  let testCooldownTimer = null;
  const secretInputs = { barkDeviceKey: 'bark-key', webhookUrl: 'webhook-url', webhookToken: 'webhook-token' };
  const clearInputs = { barkDeviceKey: 'clear-bark-key', webhookUrl: 'clear-webhook-url', webhookToken: 'clear-webhook-token' };
  const channelLabels = { bark: 'Bark', webhook: 'Webhook', local_command: '旧本机命令' };
  let editingEndpoint = null;
  let editingKey = null;
  let keyEndpoint = null;
  let confirmation = null;
  let dialogOpener = null;
  let reportRequest = 0;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  function text(id, value) { $(id).textContent = String(value ?? '—'); }
  function date(value, compact = false) {
    if (!value) return '尚未检测';
    const time = new Date(value);
    if (!Number.isFinite(time.getTime())) return '时间不可用';
    return new Intl.DateTimeFormat('zh-CN', compact
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
      : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(time);
  }
  function percent(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${(Math.min(1, Math.max(0, value)) * 100).toFixed(1)}%` : '—';
  }
  function endpoints() { return Array.isArray(state?.config?.endpoints) ? state.config.endpoints : []; }
  function keys(endpoint) { return Array.isArray(endpoint?.keys) ? endpoint.keys : []; }
  function results() { return Array.isArray(state?.results) ? state.results : []; }
  function history() { return Array.isArray(state?.history) ? state.history : []; }
  function running() { return Boolean(state?.run?.running); }
  function validTargets(endpointId, keyId) {
    return endpoints().filter((endpoint) => endpoint.enabled && (!endpointId || endpoint.id === endpointId))
      .flatMap((endpoint) => keys(endpoint).filter((key) => key.enabled && key.hasSecret && (!keyId || key.id === keyId))
        .map((key) => ({ endpoint, key })));
  }
  function latestFor(endpointId, keyId) {
    return results().filter((result) => result.endpointId === endpointId && result.keyId === keyId)
      .sort((a, b) => (Date.parse(b.finishedAt || b.startedAt) || 0) - (Date.parse(a.finishedAt || a.startedAt) || 0))[0];
  }
  function badge(status) {
    const [label, color] = statusLabels[status] || ['未检测', 'neutral'];
    return node('span', `badge ${color}`, label);
  }
  function action(label, handler, options = {}) {
    const button = node('button', options.className || 'text-button', label);
    button.type = 'button';
    button.disabled = Boolean(options.disabled);
    if (options.title) button.title = options.title;
    if (options.write !== false) button.dataset.write = 'true';
    if (options.focusKey) button.dataset.focusKey = options.focusKey;
    button.addEventListener('click', () => handler(button));
    return button;
  }
  function toggle(checked, label, handler, disabled, focusKey) {
    const wrapper = node('label', 'switch');
    const input = node('input');
    input.type = 'checkbox'; input.checked = Boolean(checked); input.disabled = Boolean(disabled);
    input.setAttribute('aria-label', label); input.dataset.write = 'true';
    input.dataset.focusKey = focusKey;
    wrapper.append(input, node('span', 'switch-track'));
    wrapper.lastChild.setAttribute('aria-hidden', 'true');
    input.addEventListener('change', async () => {
      const next = input.checked;
      input.checked = !next;
      await handler(next, input);
    });
    return wrapper;
  }
  function toast(message, type = 'success') {
    const element = node('div', `toast ${type}`);
    element.setAttribute('role', type === 'error' ? 'alert' : 'status');
    element.append(node('span', '', type === 'error' ? '!' : '✓'), node('span', '', message));
    const close = action('×', () => element.remove(), { className: 'icon-button', write: false });
    close.setAttribute('aria-label', '关闭提示');
    element.append(close); $('toast-region').append(element);
    while ($('toast-region').children.length > 4) $('toast-region').firstChild.remove();
    setTimeout(() => element.remove(), type === 'error' ? 9000 : 5000);
  }
  class SafeError extends Error {
    constructor(message, httpStatus) { super(message); this.httpStatus = httpStatus; }
  }
  function errorMessage(status) {
    if (status === 403 || status === 401) return '安全会话已失效。请刷新页面后重试；操作没有自动重发。';
    if (status === 409) return '当前有检测或其他操作正在执行，请稍后再试。';
    if (status === 400 || status === 422) return '配置未通过校验，请检查必填项、地址与参数后重试。';
    if (status === 404) return '目标已不存在，请刷新列表后重试。';
    if (status === 413) return '配置文件过大，请使用小于 256 KB 的非密钥配置。';
    if (status === 429) return '操作过于频繁，请稍后再试。';
    return '本机服务暂时无法完成操作，请稍后重试。';
  }
  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), method === 'GET' ? 15000 : 60000);
    try {
      const headers = { Accept: 'application/json' };
      if (method !== 'GET') {
        if (!csrfToken) throw new SafeError('安全会话尚未就绪，请刷新页面后重试。');
        headers['Content-Type'] = 'application/json';
        headers['X-CSRF-Token'] = csrfToken;
      }
      const response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store',
        signal: controller.signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        const testError = path === '/api/notifications/test' && ({
          409: '已有通知测试正在处理。请等待完成并查看测试记录，不会自动重复发送。',
          429: '通知测试每 30 秒最多一次。请等待冷却结束后再手动确认，不会自动重发。',
        })[response.status];
        const notificationSaveError = path === '/api/notifications' && response.status === 409
          ? '通知配置暂不能保存：旧版本系统任务仍在启用。请先「应用新版本到系统定时」，或停用旧系统任务后再保存；通知测试与教程仍可使用。' : '';
        throw new SafeError(testError || notificationSaveError || errorMessage(response.status), response.status);
      }
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (error instanceof SafeError) throw error;
      // Never expose exceptions, submitted payloads or server diagnostics.
      throw new SafeError(method === 'GET' ? '无法读取本机服务，请检查服务是否正在运行。' : '请求未能确认完成。请先刷新状态再重试，避免重复操作。');
    } finally { clearTimeout(timeout); }
  }
  function connection(ok) {
    online = ok;
    text('connection-status', ok ? '已连接' : '连接中断');
    $('connection-banner').hidden = ok;
    updateControls();
  }
  function setBusy(button, busy) {
    if (!button) return;
    if (busy) {
      button.dataset.wasDisabled = String(button.disabled);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      if (button.tagName === 'BUTTON') {
        button.dataset.originalText = button.textContent;
        const spinner = node('span', 'spinner'); spinner.setAttribute('aria-hidden', 'true');
        button.replaceChildren(spinner, node('span', '', '处理中…'));
      }
    } else {
      button.removeAttribute('aria-busy');
      button.disabled = button.dataset.wasDisabled === 'true';
      if (button.dataset.originalText !== undefined) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
      delete button.dataset.wasDisabled;
    }
  }
  function updateControls() {
    const unavailable = !online || writing;
    for (const button of [$('add-endpoint-button'), $('save-settings'), $('schedule-toggle'), $('import-config')]) button.disabled = unavailable;
    $('schedule-toggle').disabled = unavailable || state?.platform?.nativeSchedulingSupported === false;
    $('schedule-upgrade').disabled = unavailable || !state?.scheduler?.runtimeOutdated || state?.platform?.nativeSchedulingSupported === false;
    $('save-notifications').disabled = unavailable || oldRuntimeActive();
    $('notification-fields').disabled = unavailable;
    $('test-notification').disabled = unavailable || testPending || Date.now() < testCooldownUntil;
    if (!testPending) $('test-notification').textContent = Date.now() < testCooldownUntil ? '测试冷却中…' : '发送测试通知…';
    $('run-all-button').disabled = unavailable || running() || validTargets().length === 0;
    $('export-config').disabled = !online || writing;
    for (const element of document.querySelectorAll('#endpoints-list [data-write]')) {
      element.disabled = unavailable || running() || element.dataset.permanentDisabled === 'true';
    }
    for (const form of [$('endpoint-form'), $('key-form')]) form.querySelector('[type="submit"]').disabled = unavailable;
    $('confirm-submit').disabled = unavailable || Boolean(confirmation?.requireCheck && !$('confirm-check').checked);
    for (const dialog of document.querySelectorAll('dialog')) {
      for (const closer of dialog.querySelectorAll('.dialog-close')) closer.disabled = writing;
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => refreshState().catch(() => {}), running() ? 3000 : 15000);
  }
  async function refreshState({ resetSettings = false, resetNotifications = false, notify = false } = {}) {
    if (refreshing) {
      await refreshing;
      if (resetSettings || resetNotifications) return refreshState({ resetSettings, resetNotifications, notify });
      return;
    }
    $('refresh-button').setAttribute('aria-busy', 'true');
    refreshing = (async () => {
      try {
        if (!csrfToken) {
          const session = await request('/api/session');
          if (!session || typeof session.csrfToken !== 'string' || !session.csrfToken) throw new SafeError('安全会话初始化失败，请刷新页面。');
          csrfToken = session.csrfToken;
        }
        const fresh = await request('/api/state');
        if (!fresh || !fresh.config || !Array.isArray(fresh.config.endpoints)) throw new SafeError('本机服务返回的状态格式无效。');
        state = fresh; connection(true); render(resetSettings, resetNotifications);
        text('last-updated', `最近同步 ${date(new Date().toISOString(), true)}`);
      } catch (error) {
        connection(false);
        if (!state) renderInitialError();
        if (notify) toast(error.message, 'error');
      } finally {
        refreshing = null;
        $('refresh-button').removeAttribute('aria-busy');
        schedulePoll();
      }
    })();
    await refreshing;
  }
  async function mutate(path, method, body, button, success, after) {
    if (writing) return false;
    if (!online) { toast('请先恢复本机服务连接。', 'error'); return false; }
    writing = true; setBusy(button, true); updateControls();
    try {
      await request(path, { method, body });
      if (after) after();
      if (success) toast(success);
      await refreshState({ resetSettings: path === '/api/settings' || path === '/api/import', resetNotifications: path === '/api/import' });
      return true;
    } catch (error) {
      toast(error.message, 'error');
      return false;
    } finally {
      writing = false; setBusy(button, false); updateControls();
    }
  }
  function render(resetSettings = false, resetNotifications = false) {
    const configured = endpoints();
    const allKeys = configured.flatMap(keys);
    const recent = [];
    for (const endpoint of configured) for (const key of keys(endpoint)) {
      const result = latestFor(endpoint.id, key.id); if (result) recent.push(result);
    }
    text('app-version', `v${state.version || '1.0.0'}`);
    text('nav-count', configured.length); text('endpoint-total', configured.length);
    text('stat-endpoints', String(configured.length).padStart(2, '0'));
    text('stat-keys', `${allKeys.length} 个 Key 别名 · ${validTargets().length} 个已就绪`);
    $('stat-matches').replaceChildren(document.createTextNode(String(recent.filter((result) => result.status === 'match').length).padStart(2, '0')),
      node('small', '', ` / ${recent.length}`));
    text('stat-alerts', String(recent.filter((result) => ['suspect', 'inconclusive', 'technical_error'].includes(result.status)).length).padStart(2, '0'));
    text('stat-alerts-description', recent.some((result) => result.alert) ? '存在连续异常，请人工复核' : '异常、未确定与技术错误');
    const scheduler = state.scheduler || {};
    text('stat-schedule', scheduler.enabled ? `每 ${state.config.schedule?.intervalHours || 3} 小时` : '未启用');
    text('stat-next-run', scheduler.nextRunAt ? `下次 ${date(scheduler.nextRunAt, true)}` : scheduler.enabled ? '按本机日历时刻执行' : '尚未启用本机调度');
    $('run-progress').hidden = !running();
    text('run-progress-detail', state.run?.activeAlias ? `正在检测「${state.run.activeAlias}」，请勿重复提交。` : '正在收集指纹样本，请勿重复提交。');
    renderEndpoints(); renderHistory(); renderSettings(resetSettings); renderNotifications(resetNotifications); updateControls();
  }
  function renderInitialError() {
    const empty = node('div', 'empty-state');
    empty.append(node('div', 'empty-icon', '⌁'), node('h3', '', '尚未连接本机服务'), node('p', '', '请确认本地服务已启动，然后重新连接。不会自动发起任何模型检测。'),
      action('重新连接', () => refreshState({ notify: true }), { className: 'button secondary', write: false }));
    $('endpoints-list').replaceChildren(empty); $('endpoints-list').setAttribute('aria-busy', 'false');
  }
  function renderEndpoints() {
    const active = document.activeElement;
    const focusKey = $('endpoints-list').contains(active) ? active.dataset.focusKey : null;
    const query = $('endpoint-search').value.trim().toLocaleLowerCase();
    const filter = $('endpoint-filter').value;
    const visible = endpoints().filter((endpoint) => {
      const haystack = [endpoint.name, endpoint.baseUrl, endpoint.model, ...keys(endpoint).map((key) => key.alias)].join(' ').toLocaleLowerCase();
      return (!query || haystack.includes(query)) && (filter === 'all' || (filter === 'enabled' ? endpoint.enabled : !endpoint.enabled));
    });
    const fragment = document.createDocumentFragment();
    if (!visible.length) {
      const empty = node('div', 'empty-state');
      const noEndpoints = endpoints().length === 0;
      empty.append(node('div', 'empty-icon', noEndpoints ? '⌁' : '⌕'), node('h3', '', noEndpoints ? '从你的第一个 API 接口开始' : '没有符合条件的接口'),
        node('p', '', noEndpoints ? '添加接口地址与 Key 别名，建立可追溯的指纹巡检。保存配置不会自动检测。' : '尝试其他关键词，或切换回全部接口。'));
      if (noEndpoints) empty.append(action('＋ 添加第一个接口', () => openEndpoint(), { className: 'button primary' }));
      else empty.append(action('清除筛选', () => { $('endpoint-search').value = ''; $('endpoint-filter').value = 'all'; renderEndpoints(); }, { className: 'button secondary', write: false }));
      fragment.append(empty);
    }
    for (const endpoint of visible) fragment.append(endpointCard(endpoint));
    $('endpoints-list').replaceChildren(fragment); $('endpoints-list').setAttribute('aria-busy', 'false');
    if (focusKey) {
      for (const element of $('endpoints-list').querySelectorAll('[data-focus-key]')) {
        if (element.dataset.focusKey === focusKey) { element.focus({ preventScroll: true }); break; }
      }
    }
    updateControls();
  }
  function endpointCard(endpoint) {
    const card = node('article', `endpoint-card${endpoint.enabled ? '' : ' disabled'}`);
    const header = node('div', 'endpoint-header');
    const icon = node('div', 'endpoint-icon', '⌁'); icon.setAttribute('aria-hidden', 'true');
    const info = node('div', 'endpoint-info');
    const titleRow = node('div', 'endpoint-title-row');
    titleRow.append(node('h3', 'endpoint-title', endpoint.name || '未命名接口'), node('span', `badge ${endpoint.enabled ? 'green' : 'neutral'}`, endpoint.enabled ? '已启用' : '已停用'));
    info.append(titleRow, node('p', 'endpoint-url', endpoint.baseUrl || '未配置地址'));
    const meta = node('div', 'endpoint-meta');
    for (const [label, value] of [['模型', endpoint.model], ['协议', { responses: 'Responses', chat_completions: 'Chat Completions', messages: 'Messages' }[endpoint.api] || endpoint.api], ['推理', endpoint.effort]]) {
      const item = node('span', '', `${label} `); item.append(node('strong', '', value || '—')); meta.append(item);
    }
    info.append(meta);
    const controls = node('div', 'endpoint-controls');
    controls.append(action('检测接口', () => openRun(endpoint.id), { disabled: !validTargets(endpoint.id).length || running(), focusKey: `run-${endpoint.id}` }),
      action('编辑', () => openEndpoint(endpoint), { focusKey: `edit-${endpoint.id}` }),
      action('删除', () => deleteEndpoint(endpoint), { className: 'text-button muted', focusKey: `delete-${endpoint.id}` }),
      toggle(endpoint.enabled, `${endpoint.enabled ? '停用' : '启用'}接口 ${endpoint.name}`, (enabled, button) => mutate(`/api/endpoints/${encodeURIComponent(endpoint.id)}`, 'PUT', endpointPayload(endpoint, enabled), button, enabled ? '接口已启用，不会自动检测。' : '接口已停用。'), running(), `toggle-${endpoint.id}`));
    if (!validTargets(endpoint.id).length) controls.firstChild.dataset.permanentDisabled = 'true';
    header.append(icon, info, controls); card.append(header);
    const table = node('div', 'key-table');
    if (keys(endpoint).length) {
      const headings = node('div', 'key-table-header'); headings.setAttribute('aria-hidden', 'true');
      for (const value of ['KEY 别名', '最近指纹结果', '最近检测', '操作']) headings.append(node('span', '', value));
      table.append(headings);
      for (const key of keys(endpoint)) table.append(keyRow(endpoint, key));
    } else table.append(node('div', 'empty-keys', '暂无 Key。添加凭据后才能进行检测；也可先保存无凭据的别名。'));
    card.append(table);
    const footer = node('div', 'endpoint-card-footer');
    footer.append(action('＋ 添加 Key', () => openKey(endpoint), { focusKey: `add-key-${endpoint.id}` }), node('span', '', `${keys(endpoint).length} 个 Key · ${validTargets(endpoint.id).length} 个可检测`));
    card.append(footer); return card;
  }
  function keyRow(endpoint, key) {
    const row = node('div', 'key-row');
    const identity = node('div');
    const alias = node('div', 'key-alias');
    alias.append(node('span', `key-dot${key.enabled && key.hasSecret ? '' : ' disabled'}`), node('strong', '', key.alias || '未命名 Key'));
    identity.append(alias, node('p', 'key-meta', !key.hasSecret ? '待录入凭据 · 已停用' : key.enabled ? '凭据已保存 · 不可回显' : '已停用 · 凭据已保存'));
    const result = latestFor(endpoint.id, key.id);
    const resultCell = node('div');
    const resultLine = node('div', 'key-result'); resultLine.append(badge(result?.status));
    if (result) resultLine.append(node('small', '', `${percent(result.probability)} 参考库置信度`));
    resultCell.append(resultLine);
    if (result) {
      const reason = result.status === 'technical_error' ? '请求或检测过程失败，不能判断指纹变化' : result.topName || result.reason || '暂无候选信息';
      resultCell.append(node('p', 'key-result-reason', reason));
    }
    const time = node('div', 'key-time', result ? date(result.finishedAt || result.startedAt, true) : '—');
    if (result?.alert) time.append(node('div', 'badge amber', '连续异常 · 请复核'));
    const controls = node('div', 'key-actions');
    const canRun = endpoint.enabled && key.enabled && key.hasSecret;
    const runButton = action('检测', () => openRun(endpoint.id, key.id), { disabled: !canRun || running(), focusKey: `key-run-${key.id}` });
    if (!canRun) runButton.dataset.permanentDisabled = 'true';
    const switchControl = toggle(key.enabled, `${key.enabled ? '停用' : '启用'} Key ${key.alias}`, (enabled, button) => mutate(`/api/keys/${encodeURIComponent(key.id)}`, 'PUT', { enabled }, button, enabled ? 'Key 已启用，不会自动检测。' : 'Key 已停用。'), !key.hasSecret || running(), `key-toggle-${key.id}`);
    if (!key.hasSecret) switchControl.firstChild.dataset.permanentDisabled = 'true';
    controls.append(runButton, action('编辑', () => openKey(endpoint, key), { focusKey: `key-edit-${key.id}` }), action('删除', () => deleteKey(endpoint, key), { className: 'text-button muted', focusKey: `key-delete-${key.id}` }), switchControl);
    row.append(identity, resultCell, time, controls); return row;
  }
  function renderHistory() {
    text('history-total', history().length);
    const filter = $('history-filter').value;
    const items = history().filter((item) => filter === 'all' || item.status === filter)
      .slice().sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
    const fragment = document.createDocumentFragment();
    for (const result of items) {
      const row = node('tr');
      const when = node('td'); when.append(node('span', 'cell-primary', date(result.startedAt, true)), node('span', 'cell-secondary', result.endpointName || '已删除接口'));
      const alias = node('td'); alias.append(node('span', 'cell-primary', result.alias || '未命名 Key'), node('span', 'cell-secondary', `${result.requestedModel || '—'} · ${result.effort || '—'}`));
      const conclusion = node('td'); conclusion.append(badge(result.status));
      if (result.alert) conclusion.append(node('span', 'cell-secondary', '连续异常，请人工复核'));
      const candidate = node('td'); candidate.append(node('span', 'cell-primary', result.topName || '暂无候选'), node('span', 'cell-secondary', `${percent(result.probability)} 参考库置信度`));
      const samples = node('td', '', `${result.validSamples ?? 0} / ${result.sampleCount ?? 3}`);
      const operation = node('td');
      if (result.reportId) operation.append(action('查看报告 ↗', () => openReport(result), { write: false }));
      else operation.append(node('span', 'cell-secondary', '无报告'));
      row.append(when, alias, conclusion, candidate, samples, operation); fragment.append(row);
    }
    $('history-body').replaceChildren(fragment); $('history-empty').hidden = items.length > 0;
    const emptyHeading = $('history-empty').querySelector('h3');
    emptyHeading.textContent = history().length ? '没有符合筛选条件的记录' : '还没有检测记录';
  }
  function oldRuntimeActive() { return Boolean(state?.scheduler?.runtimeOutdated && state?.scheduler?.enabled); }
  function renderSettings(reset) {
    if (!settingsDirty || reset) {
      $('schedule-interval').value = String(state.config.schedule?.intervalHours || 3);
      $('schedule-minute').value = String(state.config.schedule?.minute ?? 59);
      settingsDirty = false; schedulePreview();
    }
    const scheduler = state.scheduler || {};
    $('runtime-outdated-banner').hidden = !scheduler.runtimeOutdated;
    $('notification-runtime-warning').hidden = !oldRuntimeActive();
    text('runtime-outdated-detail', scheduler.enabled
      ? '当前启用的系统任务仍指向旧版本，尚不能保证使用新通知配置。请先应用新版本，或停用该系统任务；在此之前不能保存通知配置。'
      : '系统任务仍指向旧版本，当前已停用。应用新版本会按已保存的时间重新启用；请阅读确认，不会立即检测。');
    const badgeElement = $('scheduler-badge');
    badgeElement.className = `badge ${scheduler.runtimeOutdated ? 'amber' : scheduler.enabled ? 'green' : 'neutral'}`;
    badgeElement.textContent = scheduler.runtimeOutdated ? (scheduler.enabled ? '旧版本任务启用中' : '旧版本任务已停用') : scheduler.enabled ? '已启用' : '未启用';
    text('schedule-toggle', scheduler.enabled ? '停用本机调度' : '启用本机调度');
    $('scheduler-dot').classList.toggle('enabled', Boolean(scheduler.enabled));
    const platform = state.platform || {};
    const schedulerName = platform.scheduler || '系统调度';
    const platformName = platform.name || '本机系统';
    text('platform-schedule-description', `通过 ${platformName} 的${schedulerName}按固定时刻执行。安装或保存不会立即检测，也不会影响其他任务。`);
    text('platform-name', `${platformName} · ${schedulerName}`);
    text('platform-protection', `凭据保护：${platform.secretsProtection || '平台未提供保护方式信息'}`);
    $('platform-validation').hidden = !platform.windowsValidation;
    text('platform-validation', platform.windowsValidation || '');
    $('legacy-warning').hidden = !state.config.legacyMonitor?.present;
    text('scheduler-detail-title', scheduler.enabled ? `本机${schedulerName}已启用` : scheduler.installed ? '调度已安装，当前已停用' : '调度尚未启用');
    text('scheduler-detail-message', scheduler.message || (scheduler.nextRunAt ? `下次计划执行：${date(scheduler.nextRunAt)}` : '仅管理本应用任务，不会暂停或修改旧监控。'));
  }
  function clearNotificationInputs() {
    for (const id of Object.values(secretInputs)) $(id).value = '';
  }
  function notificationDraftChanged() {
    notificationsDirty = true;
    notificationChannelFields();
    text('notification-draft-status', '存在未保存的通知更改。请独立保存；测试仍只使用服务器中已保存的配置。');
  }
  function notificationChannelFields() {
    const selected = $('notification-channel').value;
    $('notification-bark-fields').hidden = selected !== 'bark';
    $('notification-webhook-fields').hidden = selected !== 'webhook';
    $('notification-local-fields').hidden = selected !== 'local_command';
    $('bark-server').required = selected === 'bark';
    $('notification-insecure-warning').hidden = !$('notification-insecure').checked;
    for (const [name, id] of Object.entries(secretInputs)) {
      const clearing = $(clearInputs[name]).checked;
      $(id).disabled = clearing;
      if (clearing) $(id).value = '';
    }
  }
  function renderNotificationResult(notification, prefix, isTest = false) {
    const statuses = {
      accepted: ['服务已接受', 'green', '服务已接受，不保证手机显示。'],
      failed: ['推送失败', 'red', '未能确认成功提交；程序不会自动重试。'],
      disabled: isTest ? ['测试未发送', 'neutral', '本次测试未发送，请检查已保存的配置。检测通知开关不代表测试授权。'] : ['检测通知已关闭', 'neutral', '未发送检测通知，检测结果仍保留在本机历史中。'],
      unavailable: ['通知通道不可用', 'amber', '请检查已保存通道、所需凭据及平台支持。'],
    };
    const known = statuses[notification?.status];
    const badgeElement = $(prefix + '-status');
    badgeElement.className = `badge ${known?.[1] || 'neutral'}`;
    badgeElement.textContent = known?.[0] || (isTest ? '尚无测试通知记录' : '尚无检测通知记录');
    const reasons = {
      configuration: '通知配置不完整或不符合安全要求，请检查并保存。',
      not_configured: '尚未配置完整，请录入凭据并保存。', missing_credentials: '尚未保存所需凭据。',
      missing_bark_key: '尚未保存 Bark 设备 Key。', missing_webhook_url: '尚未保存完整 Webhook URL。',
      unsupported_platform: '当前平台不支持此通道。', command_unavailable: '旧本机命令不可用。',
      timeout: '请求超时（最长 10 秒）；结果可能不确定，先检查接收端。',
      network_error: '网络连接失败，请检查 DNS、代理与防火墙。', network: '网络连接失败，请检查 DNS、代理与防火墙。',
      tls_error: 'TLS 校验失败，请检查证书与系统时间。', tls: 'TLS 校验失败，请检查证书与系统时间。',
      authentication: '认证或权限失败，请检查已保存凭据与接收端权限。',
      unauthorized: '认证或权限失败，请检查已保存凭据与接收端权限。',
      http_error: '接收服务返回错误，请参阅教程检查地址、权限与格式。',
      remote_rejected: '远端拒绝消息，请检查格式及机器人安全策略。', remote_reject: '远端拒绝消息，请检查格式及机器人安全策略。',
      redirect_blocked: '不跟随重定向，请保存最终 HTTPS 接收地址。',
      invalid_response: '接收端响应无法确认为有效结果，请检查所选格式与接收服务。',
      redirect: '不跟随重定向，请保存最终 HTTPS 接收地址。',
      insecure_url: '默认只允许 HTTPS，请检查服务地址。',
    };
    const parts = known ? [known[2]] : [isTest ? '测试不会覆盖最近检测通知，也不会调用模型 API。' : '检测完成后，这里显示检测通知的处理结果。'];
    if (known) {
      if (channelLabels[notification.channel]) parts.push(`通道：${channelLabels[notification.channel]}。`);
      if (reasons[notification.reasonCode]) parts.push(reasons[notification.reasonCode]);
      const http = notification.httpStatus;
      if (Number.isInteger(http) && http >= 100 && http <= 599) {
        parts.push(`HTTP ${http}。${http === 401 || http === 403 ? '请检查认证与接收端权限。' : ''}`);
      }
      if (notification.finishedAt) parts.push(`处理时间：${date(notification.finishedAt)}`);
    }
    // Only whitelisted messages and numeric HTTP status; never display raw remote diagnostics or URLs.
    text(prefix + '-detail', parts.join(' '));
  }
  function renderNotifications(reset = false) {
    const config = state.config.notifications || {};
    if (!notificationsDirty || reset) {
      $('notifications-enabled').checked = Boolean(config.enabled);
      $('notification-channel').value = channelLabels[config.channel] ? config.channel : 'bark';
      $('notification-insecure').checked = Boolean(config.allowInsecure);
      $('bark-server').value = config.bark?.serverUrl || 'https://api.day.app';
      $('bark-group').value = config.bark?.group ?? 'API 指纹巡检';
      $('bark-sound').value = config.bark?.sound || '';
      $('webhook-format').value = ['json', 'slack', 'wecom', 'dingtalk'].includes(config.webhook?.format) ? config.webhook.format : 'json';
      clearNotificationInputs();
      for (const id of Object.values(clearInputs)) $(id).checked = false;
      notificationsDirty = false;
      text('notification-draft-status', '通知偏好已同步。测试仅使用服务器中已保存的配置，保存不会发送。');
    }
    text('notification-saved-channel', channelLabels[config.channel] || '尚未选择');
    text('notification-availability', state.notificationAvailable ? '配置可用 · 未验证网络或送达' : '配置不完整或平台不支持 · 未验证网络');
    text('bark-key-status', config.hasBarkKey ? '已保存设备 Key，不回显。留空保留；填写将替换。' : '未保存设备 Key；从 Bark App 首页单独复制。');
    text('webhook-url-status', config.hasWebhookUrl ? '已保存完整 URL，不回显。留空保留；填写将替换。' : '未保存地址。完整 URL 的路径 / 查询串可能带 token，不会回显。');
    text('webhook-token-status', config.hasWebhookToken ? '已保存 token，不回显。留空保留；填写将替换。' : '未保存额外 token；如接收端不要求认证可留空。');
    const localUnsupported = state.platform?.id !== 'darwin';
    $('local-command-option').disabled = localUnsupported;
    $('local-command-warning').hidden = !localUnsupported;
    $('notification-unavailable').hidden = state.notificationAvailable !== false;
    notificationChannelFields();
    renderNotificationResult(state.lastNotification, 'notification-last');
    renderNotificationResult(state.lastTestNotification, 'notification-test', true);
    const finished = Date.parse(state.lastTestNotification?.finishedAt);
    if (Number.isFinite(finished) && finished <= Date.now() + 10000 && finished + 30000 > testCooldownUntil) {
      startTestCooldown(finished + 30000);
    }
  }
  function startTestCooldown(until = Date.now() + 30000) {
    testCooldownUntil = Math.max(testCooldownUntil, until);
    clearTimeout(testCooldownTimer);
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((testCooldownUntil - Date.now()) / 1000));
      text('notification-test-limit', testPending ? '正在提交测试，禁止重复发送 · 零模型请求' : remaining ? `测试冷却中：还需 ${remaining} 秒 · 不会自动重发` : '需再次确认 · 零模型请求 · 每 30 秒最多一次');
      updateControls();
      if (remaining || testPending) testCooldownTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  function schedulePreview() {
    const hours = Number($('schedule-interval').value);
    const minute = Number($('schedule-minute').value);
    if (!intervals.includes(hours) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      text('schedule-preview', '请输入 0–59 之间的整数分钟。'); return;
    }
    const slots = [];
    for (let hour = 0; hour < 24; hour += hours) slots.push(String(hour).padStart(2, '0'));
    text('schedule-preview', `每天 ${slots.join('、')} 时的 ${String(minute).padStart(2, '0')} 分执行（本机时区），不是从保存时间起计时。`);
  }
  function openDialog(id) {
    const dialog = $(id);
    if (dialog.open) return;
    dialogOpener = document.activeElement;
    dialog.showModal();
    const focus = dialog.querySelector('input:not([type="checkbox"]), select, button');
    if (focus) focus.focus({ preventScroll: true });
  }
  function closeDialog(dialog, force = false) {
    if (writing && !force) return;
    dialog.close();
  }
  function endpointPayload(endpoint, enabled = endpoint.enabled) {
    return { name: endpoint.name, baseUrl: endpoint.baseUrl, model: endpoint.model, api: endpoint.api,
      effort: endpoint.effort, enabled: Boolean(enabled), ...(Array.isArray(endpoint.expectedCandidateIds) ? { expectedCandidateIds: endpoint.expectedCandidateIds } : {}),
      ...(Array.isArray(endpoint.expectedCandidateNames) ? { expectedCandidateNames: endpoint.expectedCandidateNames } : {}) };
  }
  function openEndpoint(endpoint = null) {
    editingEndpoint = endpoint;
    $('endpoint-form').reset();
    text('endpoint-dialog-title', endpoint ? '编辑接口' : '添加接口');
    $('endpoint-name').value = endpoint?.name || '';
    $('endpoint-url').value = endpoint?.baseUrl || '';
    $('endpoint-model').value = endpoint?.model || 'gpt-6.1-sol';
    $('endpoint-api').value = endpoint?.api || 'responses';
    $('endpoint-effort').value = endpoint?.effort || 'low';
    $('endpoint-enabled').checked = endpoint?.enabled ?? true;
    $('endpoint-candidates').value = endpoint?.expectedCandidateIds?.join(', ') || '';
    $('endpoint-url').setCustomValidity('');
    openDialog('endpoint-dialog'); $('endpoint-name').focus();
  }
  function openKey(endpoint, key = null) {
    keyEndpoint = endpoint; editingKey = key;
    $('key-form').reset(); $('key-secret').value = '';
    text('key-dialog-title', key ? '编辑 Key' : '添加 Key');
    text('key-endpoint-label', `所属接口：${endpoint.name}。保存不会发起检测。`);
    $('key-alias').value = key?.alias || '';
    $('key-enabled').checked = key?.enabled ?? true;
    text('key-secret-help', key?.hasSecret ? '已保存凭据不会回显。留空保留原 Key；填写将替换。' : '可暂不填写，未录入凭据的 Key 将保持停用。');
    $('key-secret').placeholder = key?.hasSecret ? '留空保留现有 Key' : '粘贴新的 API Key';
    openDialog('key-dialog'); $('key-alias').focus();
  }
  function showConfirmation({ title, eyebrow = 'CONFIRM', paragraphs = [], submit = '确认', danger = false, requireCheck = false, checkText = '', extra, execute }) {
    confirmation = { requireCheck, execute };
    text('confirm-title', title); text('confirm-eyebrow', eyebrow);
    const content = $('confirm-content'); content.replaceChildren();
    for (const paragraph of paragraphs) content.append(node('p', '', paragraph));
    if (extra) content.append(extra);
    $('confirm-check-label').hidden = !requireCheck;
    $('confirm-check').checked = false; $('confirm-check').required = requireCheck;
    text('confirm-check-text', checkText);
    $('confirm-submit').className = `button ${danger ? 'danger' : 'primary'}`;
    text('confirm-submit', submit); updateControls(); openDialog('confirm-dialog');
    // Destructive and paid operations default focus to cancel, never to submit.
    $('confirm-dialog').querySelector('.dialog-footer .dialog-close').focus();
  }
  function deleteEndpoint(endpoint) {
    showConfirmation({ title: '删除这个接口？', eyebrow: 'DELETE ENDPOINT', danger: true, submit: '确认删除接口',
      paragraphs: [`将删除「${endpoint.name}」及其 ${keys(endpoint).length} 个 Key 配置。此操作不可撤销。`, '不会发起模型请求，也不会修改旧监控配置。'],
      execute: (button) => mutate(`/api/endpoints/${encodeURIComponent(endpoint.id)}`, 'DELETE', undefined, button, '接口及其 Key 已删除。', () => closeDialog($('confirm-dialog'), true)) });
  }
  function deleteKey(endpoint, key) {
    showConfirmation({ title: '删除这个 Key？', eyebrow: 'DELETE KEY', danger: true, submit: '确认删除 Key',
      paragraphs: [`将从「${endpoint.name}」删除别名「${key.alias}」及其本机凭据。此操作不可撤销。`],
      execute: (button) => mutate(`/api/keys/${encodeURIComponent(key.id)}`, 'DELETE', undefined, button, 'Key 已删除。', () => closeDialog($('confirm-dialog'), true)) });
  }
  function openRun(endpointId, keyId) {
    if (running()) { toast('检测正在进行，请等待本轮完成。', 'error'); return; }
    const targets = validTargets(endpointId, keyId);
    if (!targets.length) { toast('没有可检测的 Key。请启用接口并录入、启用凭据。', 'error'); return; }
    const cost = node('div', 'cost-box');
    cost.append(node('span', 'cost-number', `${targets.length} 个 Key × 3 样本`), node('p', '', `预计 ${targets.length * 3} 次付费模型样本请求`), node('small', '', '实际金额由接口服务商定价与 token 用量决定。程序不会自动重试或额外加测，失败样本仍可能产生费用。'));
    showConfirmation({ title: '确认发起付费检测？', eyebrow: 'MANUAL RUN / API QUOTA', submit: '确认费用并开始检测',
      paragraphs: [keyId ? `检测「${targets[0].endpoint.name} / ${targets[0].key.alias}」。` : endpointId ? `检测接口「${targets[0].endpoint.name}」的全部已启用、有效 Key。` : '检测全部已启用接口中已启用且有凭据的 Key。', '这将实际调用模型 API 并消耗配额。指纹结果不是能力测评，也不能独立证明模型身份或质量变化。'], extra: cost,
      execute: async (button) => {
        const currentTargets = validTargets(endpointId, keyId);
        const sameTargets = currentTargets.length === targets.length && currentTargets.every((item) => targets.some((old) => old.key.id === item.key.id && old.endpoint.id === item.endpoint.id));
        if (running() || !sameTargets) { toast('检测状态或目标已变化，请关闭后重新确认。', 'error'); return; }
        const body = { confirmed: true, ...(endpointId ? { endpointId } : {}), ...(keyId ? { keyId } : {}) };
        await mutate('/api/run', 'POST', body, button, '检测请求已受理，正在等待本机执行结果。', () => {
          closeDialog($('confirm-dialog'), true);
          if (state) state.run = { ...state.run, running: true };
          render();
        });
      } });
  }
  function notificationBody() {
    return {
      enabled: $('notifications-enabled').checked, channel: $('notification-channel').value,
      allowInsecure: $('notification-insecure').checked,
      bark: { serverUrl: $('bark-server').value.trim(), group: $('bark-group').value.trim(), sound: $('bark-sound').value.trim() },
      webhook: { format: $('webhook-format').value },
      credentials: Object.fromEntries(Object.entries(secretInputs)
        .filter(([name, id]) => !$(clearInputs[name]).checked && $(id).value.trim())
        .map(([name, id]) => [name, $(id).value.trim()])),
      clearSecrets: Object.entries(clearInputs).filter(([, id]) => $(id).checked).map(([name]) => name),
    };
  }
  function validateNotificationForm() {
    const allowInsecure = $('notification-insecure').checked;
    const selected = $('notification-channel').value;
    if (selected === 'local_command' && state.platform?.id !== 'darwin') {
      toast('当前平台不支持旧本机命令，请选择 Bark 或 Webhook。', 'error'); return false;
    }
    // Validate without ever echoing submitted URLs or credential values.
    $('bark-server').setCustomValidity('');
    if (selected === 'bark') {
      try {
        const server = new URL($('bark-server').value.trim());
        if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password || server.search || server.hash || server.pathname !== '/' || (!allowInsecure && server.protocol !== 'https:')) throw new Error();
      } catch {
        $('bark-server').setCustomValidity('服务器仅接受 HTTPS 源地址（协议 + 域名 + 可选端口），不能含设备 Key、路径、查询参数或账号密码；HTTP 必须明确允许风险。');
      }
      if (!$('bark-server').reportValidity() || !$('bark-group').reportValidity() || !$('bark-sound').reportValidity()) return false;
    }
    if ($('webhook-url').value.trim() && !$('clear-webhook-url').checked) {
      try {
        const url = new URL($('webhook-url').value.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (!allowInsecure && url.protocol !== 'https:')) throw new Error();
      } catch {
        toast('Webhook URL 必须是有效的 HTTPS 接收地址，不含账号密码或片段；HTTP 必须明确允许风险。输入值不会回显。', 'error');
        if (selected === 'webhook') $('webhook-url').focus();
        return false;
      }
    }
    return true;
  }
  async function saveNotifications(button, fromConfirmation = false) {
    if (oldRuntimeActive()) { toast('请先明确应用新版本到系统定时，或停用旧版本系统任务，再保存通知配置。测试通知与教程仍可使用。', 'error'); return false; }
    if (writing || !online || !validateNotificationForm()) return false;
    const body = notificationBody();
    const hadTypedCredentials = Object.keys(body.credentials).length > 0;
    try {
      const saved = await mutate('/api/notifications', 'POST', body, button, '通知配置已保存，没有发送通知或发起模型请求。', () => {
        notificationsDirty = false;
        for (const id of Object.values(clearInputs)) $(id).checked = false;
        if (fromConfirmation) closeDialog($('confirm-dialog'), true);
      });
      if (!saved && hadTypedCredentials) toast('为保护隐私，本次凭据输入已清空；若需重试，请重新录入，不会自动重发。', 'error');
      return saved;
    } finally {
      clearNotificationInputs();
      notificationChannelFields();
    }
  }
  function submitNotifications() {
    if (oldRuntimeActive()) { toast('旧版本系统任务仍启用。请先「应用新版本到系统定时」，或停用该任务，再保存通知配置。', 'error'); return; }
    if (writing || !online || !validateNotificationForm()) return;
    const clearing = Object.entries(clearInputs).filter(([, id]) => $(id).checked).map(([name]) => ({
      barkDeviceKey: 'Bark 设备 Key', webhookUrl: '完整 Webhook URL', webhookToken: 'Webhook token',
    })[name]);
    if (!clearing.length) { saveNotifications($('save-notifications')); return; }
    showConfirmation({ title: '确认清除通知凭据？', eyebrow: 'NOTIFICATIONS / CLEAR SECRETS', danger: true, submit: '确认清除并保存',
      paragraphs: [`将清除：${clearing.join('、')}。此操作不可撤销；需要重新录入才能恢复相应通道。`, '未勾选清除且留空的凭据会保留。只保存通知配置，不发送通知、不调用模型，也不改系统调度。'],
      requireCheck: true, checkText: '我确认清除所勾选的通知凭据，并保存本次通知偏好。',
      execute: (button) => saveNotifications(button, true) });
  }
  async function sendTestNotification(button) {
    if (writing || testPending || !online || Date.now() < testCooldownUntil) return;
    writing = true; testPending = true; setBusy(button, true); startTestCooldown(); updateControls();
    try {
      const result = await request('/api/notifications/test', { method: 'POST', body: { confirmed: true } });
      if (result?.notification && state) {
        state.lastTestNotification = result.notification;
        renderNotificationResult(result.notification, 'notification-test', true);
      }
      closeDialog($('confirm-dialog'), true);
      toast(result?.notification?.status === 'accepted' ? '测试服务已接受，不保证手机显示；零模型请求。' : '测试已完成，请查看独立测试记录与通知配置教程。', result?.notification?.status === 'accepted' ? 'success' : 'error');
      await refreshState();
    } catch (error) {
      if (error.httpStatus === 429 || error.httpStatus === 409) startTestCooldown();
      toast(error.message, 'error');
      closeDialog($('confirm-dialog'), true);
      // Never automatically re-send after a timeout, network failure, or rate limit.
      await refreshState();
    } finally {
      testPending = false; writing = false; setBusy(button, false); startTestCooldown(testCooldownUntil); updateControls();
    }
  }
  function openNotificationTest() {
    if (!state || writing || testPending || !online || Date.now() < testCooldownUntil) return;
    const saved = state.config.notifications || {};
    const savedSnapshot = JSON.stringify(saved);
    showConfirmation({ title: '发送一条真实测试通知？', eyebrow: 'NOTIFICATION TEST / ZERO MODEL CALLS', submit: '确认发送实际测试消息',
      paragraphs: [`将使用已保存的「${channelLabels[saved.channel] || '通知'}」通道发送一条固定测试推送 / Webhook 消息。不会读取未保存草稿。`,
        notificationsDirty ? '你有未保存的通知更改；本次不会应用这些更改。若要测试新配置，请取消，先独立保存。' : '通知配置已保存；保存本身没有发送消息。',
        '这是真实通知发送，但零模型请求，不消耗模型 API 配额，不安装或启用调度。即使检测通知开关关闭，也会单独授权本次测试。',
        '每 30 秒最多一次；HTTP 最长等待 10 秒，不重试、不跟随重定向。服务已接受不保证手机显示。'],
      requireCheck: true, checkText: '我确认发送一条真实测试消息，并理解这不会调用模型 API。',
      execute: (button) => {
        if (JSON.stringify(state.config.notifications || {}) !== savedSnapshot) {
          toast('已保存的通知配置已变化，请关闭并重新确认测试通道。', 'error'); return;
        }
        return sendTestNotification(button);
      } });
  }
  function settingsBody() {
    return { schedule: {
      intervalHours: Number($('schedule-interval').value), minute: Number($('schedule-minute').value) } };
  }
  function upgradeScheduleRuntime() {
    if (!state?.scheduler?.runtimeOutdated || writing || !online || state.platform?.nativeSchedulingSupported === false) return;
    const schedule = {
      intervalHours: Number(state.config.schedule?.intervalHours),
      minute: Number(state.config.schedule?.minute),
    };
    if (!intervals.includes(schedule.intervalHours) || !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
      toast('已保存的调度参数无效，请先检查并保存调度偏好，再重新确认更新。', 'error'); return;
    }
    const snapshot = JSON.stringify(schedule);
    const schedulerName = state.platform?.scheduler || '系统调度';
    showConfirmation({ title: '应用新版本到系统定时？', eyebrow: 'SYSTEM SCHEDULE / UPDATE RUNTIME', submit: '确认应用新版本到系统定时',
      paragraphs: [`只更新本应用的${schedulerName}任务，使后续定时运行使用当前版本。不会擅自更新其他应用或外部旧监控任务。`,
        `复用已保存的时刻：每 ${schedule.intervalHours} 小时，在对应整点第 ${String(schedule.minute).padStart(2, '0')} 分执行。未保存的调度草稿不会应用。`,
        state.scheduler.enabled ? '当前任务已启用；更新后仍按上述已保存时刻执行，不会立即检测。' : '当前任务已停用；确认应用后将按上述已保存时刻启用，不会立即检测。',
        '本次更新不调用模型、不发送通知。后续定时检测仍会消耗模型 API 配额；通知配置需另行保存，测试也需单独确认。'],
      requireCheck: Boolean(state.config.legacyMonitor?.present),
      checkText: '我已检查并暂停可能重复运行的旧监控任务，理解本应用无法替我停用旧任务。',
      execute: (button) => {
        if (!state.scheduler?.runtimeOutdated) { toast('系统任务状态已变化，请关闭后重新检查。', 'error'); return; }
        const current = { intervalHours: Number(state.config.schedule?.intervalHours), minute: Number(state.config.schedule?.minute) };
        if (JSON.stringify(current) !== snapshot) { toast('已保存的调度时刻已变化，请关闭后重新确认更新。', 'error'); return; }
        if (state.config.legacyMonitor?.present && !$('confirm-check').checked) return;
        const body = { ...schedule, ...(state.config.legacyMonitor?.present ? { legacyAcknowledged: true } : {}) };
        return mutate('/api/schedule/enable', 'POST', body, button, '已将新版本应用到系统定时；不会立即检测。请检查任务状态，再独立保存通知配置。', () => closeDialog($('confirm-dialog'), true));
      } });
  }
  function scheduleAction() {
    if (!state || state.platform?.nativeSchedulingSupported === false) return;
    const schedulerName = state.platform?.scheduler || '系统调度';
    if (state?.scheduler?.enabled) {
      showConfirmation({ title: '停用本机自动巡检？', eyebrow: 'LOCAL SCHEDULE', submit: '确认停用调度',
        paragraphs: [`只停用本应用的${schedulerName}任务。控制台仍可访问，当前已开始的检测可能继续运行，其他应用与旧任务不受影响。`],
        execute: (button) => mutate('/api/schedule/disable', 'POST', {}, button, '本应用自动巡检已停用。', () => closeDialog($('confirm-dialog'), true)) });
      return;
    }
    if (!$('settings-form').reportValidity()) return;
    const schedule = settingsBody().schedule;
    const legacyPresent = Boolean(state.config.legacyMonitor?.present);
    showConfirmation({ title: '启用本机自动巡检？', eyebrow: 'LOCAL / SYSTEM SCHEDULE', submit: '确认启用调度',
      paragraphs: [`每 ${schedule.intervalHours} 小时，在对应整点的第 ${String(schedule.minute).padStart(2, '0')} 分检测所有已启用有效 Key，将消耗 API 配额。`, `只安装或启用本应用的${schedulerName}任务，不会立即检测，也不会自动暂停旧监控。通知偏好需另行「保存通知配置」，不会随调度保存。`],
      requireCheck: legacyPresent, checkText: '我已检查并暂停可能重复运行的旧监控任务，理解本应用无法替我停用旧任务。',
      execute: (button) => {
        if (state.config.legacyMonitor?.present && !$('confirm-check').checked) return;
        const body = { ...schedule, ...(state.config.legacyMonitor?.present ? { legacyAcknowledged: true } : {}) };
        return mutate('/api/schedule/enable', 'POST', body, button, '本机调度已启用；不会立即发起检测。', () => closeDialog($('confirm-dialog'), true));
      } });
  }
  async function openReport(result) {
    const ticket = ++reportRequest;
    $('report-content').replaceChildren(node('div', 'loading-state', '正在读取安全检测报告…'));
    openDialog('report-dialog');
    try {
      const report = await request(`/api/reports/${encodeURIComponent(result.reportId)}`);
      if (ticket !== reportRequest || !$('report-dialog').open) return;
      const fragment = document.createDocumentFragment();
      fragment.append(node('div', 'report-limitation', '指纹 ≠ 能力测评。参考库置信度不是模型身份真实性或能力分数；astra / 6.1-sol 是合并参考类。请结合多次结果人工复核。'));
      const summary = report?.summary && typeof report.summary === 'object' ? report.summary : result;
      const fields = [['接口', summary.endpointName || result.endpointName], ['Key 别名', summary.alias || result.alias], ['请求模型 / 推理', `${summary.requestedModel || result.requestedModel || '—'} / ${summary.effort || result.effort || '—'}`], ['检测时间', date(summary.startedAt || result.startedAt)], ['结论', statusLabels[summary.status || result.status]?.[0] || '暂不确定'], ['首位候选', summary.topName || result.topName || '暂无候选'], ['参考库置信度', percent(summary.probability ?? result.probability)], ['有效样本', `${summary.validSamples ?? result.validSamples ?? 0} / ${summary.sampleCount ?? result.sampleCount ?? 3}`]];
      const list = node('dl', 'report-summary');
      for (const [label, value] of fields) { const item = node('div', 'report-field'); item.append(node('dt', '', label), node('dd', '', value || '—')); list.append(item); }
      fragment.append(list);
      const reason = (summary.status || result.status) === 'technical_error' ? '请求或检测过程失败；此结果不能用于判断指纹变化。' : summary.reason || result.reason;
      if (reason) fragment.append(node('h3', 'report-subtitle', '结论说明'), node('p', 'confirm-content', reason));
      if (report?.analysis !== undefined) {
        fragment.append(node('h3', 'report-subtitle', '安全分析数据'), node('pre', 'report-json', JSON.stringify(report.analysis, null, 2)));
      }
      $('report-content').replaceChildren(fragment);
    } catch (error) {
      if (ticket !== reportRequest) return;
      const message = node('div', 'empty-state');
      message.append(node('h3', '', '报告暂时无法读取'), node('p', '', error.message), action('重试', () => openReport(result), { className: 'button secondary', write: false }));
      $('report-content').replaceChildren(message);
    }
  }
  function navigate() {
    const view = ['overview', 'history', 'settings', 'notification-help'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    for (const section of document.querySelectorAll('.page-view')) section.hidden = section.id !== `view-${view}`;
    for (const link of document.querySelectorAll('[data-view]')) {
      const current = link.dataset.view === view; link.classList.toggle('active', current);
      if (current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    text('breadcrumb-title', { overview: '巡检概览', history: '检测历史', settings: '调度与设置', 'notification-help': '通知配置教程' }[view]);
    document.title = `${{ overview: '巡检概览', history: '检测历史', settings: '调度与设置', 'notification-help': '通知配置教程' }[view]} · 指纹巡检台`;
  }
  async function exportConfig(button) {
    if (!online || writing) return;
    setBusy(button, true);
    try {
      const config = await request('/api/export');
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = node('a'); link.href = url;
      link.download = `fingerprint-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出非密钥配置；不含 API Key 或通知凭据，导出中的检测通知保持关闭。');
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(button, false); updateControls(); }
  }
  function containsSecret(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => /^(secret|api[_-]?key|authorization|token|password|credentials|barkDeviceKey|webhookUrl|webhookToken|device_key)$/i.test(key) || containsSecret(item));
  }
  async function importFile(file) {
    if (!file) return;
    if (file.size > 250 * 1024) { toast('配置文件过大，请选择小于 250 KB 的 JSON 文件。', 'error'); return; }
    let imported;
    try {
      imported = JSON.parse(await file.text());
      if (!imported || typeof imported !== 'object' || Array.isArray(imported) || containsSecret(imported)) throw new Error();
      const config = imported.config || imported;
      if (!Array.isArray(config.endpoints)) throw new Error();
    } catch { toast('无法导入：请选择本应用导出的非密钥 JSON 配置，不要包含任何密钥字段。', 'error'); return; }
    const count = (imported.config || imported).endpoints.length;
    showConfirmation({ title: '导入并替换配置？', eyebrow: 'IMPORT / WITHOUT SECRETS', submit: '确认导入配置',
      paragraphs: [`文件包含 ${count} 个接口。导入将替换现有配置，建议先导出备份。`, '导入后的 API Key 会分配新 ID、清除凭据并停用；通知凭据也会清除，检测通知保持关闭。需重新录入、保存后再明确测试。不会自动发起检测或发送通知。'],
      execute: (button) => mutate('/api/import', 'POST', imported, button, '配置已导入。请重新录入凭据并检查启用状态。', () => closeDialog($('confirm-dialog'), true)) });
  }

  $('endpoint-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (writing) return;
    const form = event.currentTarget;
    $('endpoint-name').value = $('endpoint-name').value.trim();
    $('endpoint-model').value = $('endpoint-model').value.trim();
    let url;
    try {
      url = new URL($('endpoint-url').value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      $('endpoint-url').setCustomValidity('');
    } catch { $('endpoint-url').setCustomValidity('请输入有效的 HTTP(S) 基础地址，不要包含用户名、密码、查询参数或片段。'); }
    if (!form.reportValidity()) return;
    const candidates = $('endpoint-candidates').value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    const originalCandidates = editingEndpoint?.expectedCandidateIds || [];
    const unchanged = JSON.stringify(candidates) === JSON.stringify(originalCandidates);
    const body = { name: $('endpoint-name').value, baseUrl: url.toString().replace(/\/$/, ''), model: $('endpoint-model').value,
      api: $('endpoint-api').value, effort: $('endpoint-effort').value, enabled: $('endpoint-enabled').checked,
      ...(candidates.length ? { expectedCandidateIds: candidates, expectedCandidateNames: unchanged && editingEndpoint?.expectedCandidateNames ? editingEndpoint.expectedCandidateNames : candidates.map((id) => id === 'gpt-6-astra' ? 'gpt-6-astra/6.1-sol' : id) } : {}) };
    await mutate(editingEndpoint ? `/api/endpoints/${encodeURIComponent(editingEndpoint.id)}` : '/api/endpoints', editingEndpoint ? 'PUT' : 'POST', body,
      form.querySelector('[type="submit"]'), '接口已保存。保存配置不会自动检测。', () => closeDialog($('endpoint-dialog'), true));
  });
  $('endpoint-url').addEventListener('input', () => $('endpoint-url').setCustomValidity(''));
  $('key-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (writing) return;
    const form = event.currentTarget;
    $('key-alias').value = $('key-alias').value.trim();
    if (!form.reportValidity()) return;
    const secret = $('key-secret').value.trim();
    const hasCredential = Boolean(secret || editingKey?.hasSecret);
    const body = { alias: $('key-alias').value, enabled: $('key-enabled').checked && hasCredential, ...(secret ? { secret } : {}) };
    await mutate(editingKey ? `/api/keys/${encodeURIComponent(editingKey.id)}` : `/api/endpoints/${encodeURIComponent(keyEndpoint.id)}/keys`, editingKey ? 'PUT' : 'POST', body,
      form.querySelector('[type="submit"]'), hasCredential ? 'Key 配置已保存，不会自动检测。' : '别名已保存，待录入凭据后再启用。', () => closeDialog($('key-dialog'), true));
    // A failed submission also clears the input; credentials never remain in a closed form.
    $('key-secret').value = '';
  });
  $('confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (writing || !confirmation || (confirmation.requireCheck && !$('confirm-check').checked)) return;
    await confirmation.execute($('confirm-submit'));
  });
  $('confirm-check').addEventListener('change', updateControls);
  $('settings-form').addEventListener('input', () => { settingsDirty = true; schedulePreview(); });
  $('settings-form').addEventListener('change', () => { settingsDirty = true; schedulePreview(); });
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (writing || !event.currentTarget.reportValidity()) return;
    await mutate('/api/settings', 'POST', settingsBody(), $('save-settings'), '调度偏好已保存，不会立即检测或修改通知草稿；已启用调度的生效状态请以下方状态为准。');
  });
  $('notifications-form').addEventListener('input', notificationDraftChanged);
  $('notifications-form').addEventListener('change', notificationDraftChanged);
  $('notifications-form').addEventListener('submit', (event) => { event.preventDefault(); submitNotifications(); });
  $('bark-server').addEventListener('input', () => $('bark-server').setCustomValidity(''));
  $('notification-insecure').addEventListener('change', () => $('bark-server').setCustomValidity(''));
  $('test-notification').addEventListener('click', openNotificationTest);
  for (const link of document.querySelectorAll('[data-guide-target]')) link.addEventListener('click', (event) => {
    event.preventDefault();
    const target = $(link.dataset.guideTarget);
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); target.focus({ preventScroll: true });
  });
  $('schedule-upgrade').addEventListener('click', upgradeScheduleRuntime);
  $('schedule-toggle').addEventListener('click', scheduleAction);
  $('add-endpoint-button').addEventListener('click', () => openEndpoint());
  $('run-all-button').addEventListener('click', () => openRun());
  $('endpoint-search').addEventListener('input', renderEndpoints);
  $('endpoint-filter').addEventListener('change', renderEndpoints);
  $('history-filter').addEventListener('change', renderHistory);
  for (const id of ['refresh-button', 'retry-button', 'history-refresh']) $(id).addEventListener('click', () => refreshState({ notify: true }));
  $('export-config').addEventListener('click', () => exportConfig($('export-config')));
  $('import-config').addEventListener('click', () => { $('import-file').value = ''; $('import-file').click(); });
  $('import-file').addEventListener('change', async () => { const file = $('import-file').files[0]; $('import-file').value = ''; await importFile(file); });
  for (const dialog of document.querySelectorAll('dialog')) {
    for (const button of dialog.querySelectorAll('.dialog-close')) button.addEventListener('click', () => closeDialog(dialog));
    dialog.addEventListener('cancel', (event) => { if (writing) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (dialog.id === 'key-dialog') { $('key-secret').value = ''; editingKey = null; keyEndpoint = null; }
      if (dialog.id === 'confirm-dialog') confirmation = null;
      if (dialog.id === 'report-dialog') reportRequest += 1;
      if (dialogOpener?.isConnected) dialogOpener.focus({ preventScroll: true });
      else $('main-content').focus({ preventScroll: true });
    });
  }
  window.addEventListener('hashchange', navigate);
  window.addEventListener('online', () => refreshState());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshState(); });
  window.addEventListener('pagehide', () => { clearTimeout(pollTimer); clearTimeout(testCooldownTimer); $('key-secret').value = ''; clearNotificationInputs(); });
  navigate(); updateControls(); refreshState();
})();
