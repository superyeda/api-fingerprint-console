import { readFile, writeFile, mkdir, rename, lstat, chmod, appendFile, open } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultDataDir } from './platform.mjs';
import { protectVault, unprotectVault } from './credentials.mjs';
import { defaultNotifications, normalizeNotifications, publicNotifications, updateNotifications, exportedNotifications, NotificationConfigError } from './notification-config.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
export const LIMITATION = '指纹检测不能独立证明是否降质；库内置信度不是身份真实性概率或能力分数。';
export class UserError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const ID = /^[a-z0-9-]{1,64}$/;
const clone = value => structuredClone(value);
const text = (v, label, max = 100) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max || /[\x00-\x1f]/.test(v)) throw new UserError(`${label}不能为空、含控制字符或过长。`);
  return v.trim();
};
const bool = (v, fallback) => v === undefined ? fallback : typeof v === 'boolean' ? v : (() => { throw new UserError('启用状态必须为布尔值。'); })();
function candidates(v, fallback) {
  if (v === undefined) return [...fallback];
  if (!Array.isArray(v) || !v.length || v.length > 30) throw new UserError('请至少填写一个目标指纹类别。');
  return [...new Set(v.map(s => text(s, '目标指纹类别', 120)))];
}
export function endpointFields(input, previous = {}) {
  const name = text(input.name ?? previous.name, '接口名称', 60);
  const model = text(input.model ?? previous.model ?? 'gpt-6.1-sol', '请求模型', 150);
  let url;
  try { url = new URL(input.baseUrl ?? previous.baseUrl); } catch { throw new UserError('接口 URL 格式不正确。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new UserError('URL 仅支持 HTTP/HTTPS，不能含账号、密码、查询参数或片段。');
  if (url.href.length > 2048) throw new UserError('接口 URL 过长。');
  const api = input.api ?? previous.api ?? 'responses';
  if (!['responses', 'chat_completions', 'messages'].includes(api)) throw new UserError('暂不支持此接口协议。');
  const effort = input.effort ?? previous.effort ?? 'low';
  if (!['low', 'medium', 'high', 'max'].includes(effort)) throw new UserError('推理强度配置无效。');
  return { name, baseUrl: url.href.replace(/\/$/, ''), model, api, effort, enabled: bool(input.enabled, previous.enabled ?? true),
    expectedCandidateIds: candidates(input.expectedCandidateIds, previous.expectedCandidateIds ?? ['gpt-6-astra', 'gpt-6.1-sol']),
    expectedCandidateNames: candidates(input.expectedCandidateNames, previous.expectedCandidateNames ?? ['gpt-6-astra/6.1-sol', 'gpt-6.1-sol']) };
}
function validSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 1 || secret.length > 8192 || /\s/.test(secret)) throw new UserError('Key 不能为空、含空白或过长；输入内容不会回显。');
  return secret;
}
export function defaultVault() {
  return { config: { revision: 1, endpoints: [], schedule: { intervalHours: 3, minute: 59 }, notifications: defaultNotifications(), legacyMonitor: { present: false },
    limits: { count: 3, roundTimeoutSeconds: 420, confidenceThreshold: 0.75, consecutiveAnomalies: 2 } }, secrets: {}, notificationSecrets: {} };
}
export function publicConfig(vault) {
  const config = clone(vault.config);
  for (const endpoint of config.endpoints) endpoint.keys = endpoint.keys.map(({ credentialVersion, ...key }) => ({ ...key, hasSecret: Boolean(vault.secrets[key.id]) }));
  config.notifications = publicNotifications(vault.config.notifications, vault.notificationSecrets || {});
  return config;
}
export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let s = value;
    for (const secret of secrets) if (secret) s = s.split(secret).join('[REDACTED]');
    return s.replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !/^(secret|api_?key|authorization|access_token|refresh_token|password)$/i.test(k)).map(([k, v]) => [k, redact(v, secrets)]));
  return value;
}
export class Store {
  constructor(dataDir = process.env.CONSOLE_DATA_DIR || defaultDataDir(), options = {}) { this.dir = resolve(dataDir); this.queue = Promise.resolve(); this.protection = { platform: options.platform || process.platform, spawnFn: options.protectionSpawnFn, commandPath: options.protectionCommandPath }; }
  path(name) { const p = resolve(this.dir, name); if (!p.startsWith(this.dir + sep)) throw new UserError('数据路径无效。'); return p; }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.dir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new UserError('数据目录不能是符号链接。');
    await chmod(this.dir, 0o700);
    for (const folder of ['reports', 'logs']) {
      const p = this.path(folder);
      await mkdir(p, { recursive: true, mode: 0o700 });
      if ((await lstat(p)).isSymbolicLink()) throw new UserError('数据子目录不能是符号链接。');
      await chmod(p, 0o700);
    }
    try { await this.privateSnapshot(); }
    catch (e) { if (e.code !== 'ENOENT') throw e; await this.atomic('vault.json', defaultVault()); }
    if (this.protection.platform === 'win32' && !(await this.read('vault.json')).protectedSecrets) await this.atomic('vault.json', await this.privateSnapshot());
    await chmod(this.path('vault.json'), 0o600);
    return this;
  }
  async read(name, fallback) {
    const p = this.path(name);
    try {
      if ((await lstat(p)).isSymbolicLink()) throw new UserError('拒绝读取符号链接。');
      return JSON.parse(await readFile(p, 'utf8'));
    } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return clone(fallback); throw e; }
  }
  async atomic(name, value) {
    const target = this.path(name); const temporary = this.path(`${name}.${randomUUID()}.tmp`);
    try { if ((await lstat(target)).isSymbolicLink()) throw new UserError('拒绝覆盖符号链接。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const serialized = name === 'vault.json' ? await protectVault(value, this.protection) : value;
    await writeFile(temporary, JSON.stringify(serialized, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // Both source and destination have been resolved and confined to this data directory.
    await rename(temporary, target);
  }
  async privateSnapshot() {
    const vault = await unprotectVault(await this.read('vault.json'), this.protection);
    if (!vault?.config || !Array.isArray(vault.config.endpoints) || !vault.secrets || typeof vault.secrets !== 'object') throw new UserError('本机数据文件损坏，请使用备份恢复。', 500);
    if (vault.notificationSecrets !== undefined && (!vault.notificationSecrets || typeof vault.notificationSecrets !== 'object' || Array.isArray(vault.notificationSecrets))) throw new UserError('本机通知凭据数据损坏。',500);
    vault.notificationSecrets ||= {};
    vault.config.notifications = normalizeNotifications(vault.config.notifications);
    return vault;
  }
  async config() { return publicConfig(await this.privateSnapshot()); }
  async edit(mutator) {
    const work = this.queue.then(async () => {
      const vault = await this.privateSnapshot();
      const result = await mutator(vault);
      vault.config.revision++;
      await this.atomic('vault.json', vault);
      return result;
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async addEndpoint(input) {
    return this.edit(v => {
      if (v.config.endpoints.length >= 20) throw new UserError('最多支持20个接口。');
      const endpoint = { id: randomUUID(), ...endpointFields(input), keys: [] };
      v.config.endpoints.push(endpoint); return clone(endpoint);
    });
  }
  async updateEndpoint(id, input) {
    return this.edit(v => {
      const endpoint = v.config.endpoints.find(e => e.id === id); if (!endpoint) throw new UserError('接口不存在。', 404);
      Object.assign(endpoint, endpointFields(input, endpoint));
      return publicConfig(v).endpoints.find(e => e.id === id);
    });
  }
  async removeEndpoint(id) {
    return this.edit(v => {
      const e = v.config.endpoints.find(e => e.id === id); if (!e) throw new UserError('接口不存在。', 404);
      for (const key of e.keys) delete v.secrets[key.id];
      v.config.endpoints = v.config.endpoints.filter(e => e.id !== id); return { deleted: true };
    });
  }
  findKey(v, id) { for (const endpoint of v.config.endpoints) { const key = endpoint.keys.find(k => k.id === id); if (key) return { endpoint, key }; } throw new UserError('Key 不存在。', 404); }
  async addKey(endpointId, input) {
    return this.edit(v => {
      const endpoint = v.config.endpoints.find(e => e.id === endpointId); if (!endpoint) throw new UserError('接口不存在。', 404);
      if (v.config.endpoints.reduce((n,e) => n + e.keys.length, 0) >= 100) throw new UserError('最多支持100个 Key。');
      const alias = text(input.alias, 'Key 别名', 48);
      if (endpoint.keys.some(k => k.alias.toLowerCase() === alias.toLowerCase())) throw new UserError('同一接口内的 Key 别名不能重复。');
      const secret = input.secret ? validSecret(input.secret) : null;
      const key = { id: randomUUID(), alias, enabled: secret ? bool(input.enabled, true) : false, credentialVersion: randomUUID() };
      endpoint.keys.push(key); if (secret) v.secrets[key.id] = secret;
      return { id: key.id, alias, enabled: key.enabled, hasSecret: Boolean(secret) };
    });
  }
  async updateKey(id, input) {
    return this.edit(v => {
      const { endpoint, key } = this.findKey(v, id);
      const alias = input.alias === undefined ? key.alias : text(input.alias, 'Key 别名', 48);
      if (endpoint.keys.some(k => k.id !== id && k.alias.toLowerCase() === alias.toLowerCase())) throw new UserError('同一接口内的 Key 别名不能重复。');
      if (input.secret) { v.secrets[id] = validSecret(input.secret); key.credentialVersion = randomUUID(); }
      const enabled = bool(input.enabled, key.enabled);
      if (enabled && !v.secrets[id]) throw new UserError('请先保存该 Key 的凭据。');
      Object.assign(key, { alias, enabled });
      return { id, alias, enabled, hasSecret: Boolean(v.secrets[id]) };
    });
  }
  async removeKey(id) { return this.edit(v => { const { endpoint } = this.findKey(v,id); endpoint.keys = endpoint.keys.filter(k => k.id !== id); delete v.secrets[id]; return { deleted: true }; }); }
  async settings(input) {
    return this.edit(v => {
      if (input.schedule) {
        const s = input.schedule;
        if (!INTERVALS.includes(s.intervalHours) || !Number.isInteger(s.minute) || s.minute < 0 || s.minute > 59) throw new UserError('定时间隔或分钟配置无效。');
        v.config.schedule = { intervalHours: s.intervalHours, minute: s.minute };
      }
      if (input.notifications) {
        try { const n = updateNotifications(v.config.notifications, { enabled: bool(input.notifications.enabled, v.config.notifications.enabled) }, v.notificationSecrets); v.config.notifications = n.config; v.notificationSecrets = n.secrets; }
        catch (e) { if (e instanceof NotificationConfigError) throw new UserError(e.message); throw e; }
      }
      return publicConfig(v);
    });
  }
  async notifications(input) {
    return this.edit(v => {
      try { const n = updateNotifications(v.config.notifications, input, v.notificationSecrets); v.config.notifications = n.config; v.notificationSecrets = n.secrets; return publicNotifications(n.config,n.secrets); }
      catch (e) { if (e instanceof NotificationConfigError) throw new UserError(e.message); throw e; }
    });
  }
  async exportConfig() {
    const config = await this.config();
    return { format: 'api-fingerprint-console', version: 1, endpoints: config.endpoints.map(e => ({ ...e, keys: e.keys.map(k => ({ alias: k.alias, enabled: false })) })), schedule: config.schedule, notifications: exportedNotifications(config.notifications) };
  }
  async importConfig(input) {
    if (input.format !== 'api-fingerprint-console' || input.version !== 1 || !Array.isArray(input.endpoints) || input.endpoints.length > 20) throw new UserError('不是支持的非密钥配置文件。');
    // Validate all before replacing anything. Imports intentionally contain NO credentials.
    const endpoints = input.endpoints.map(e => ({ id: randomUUID(), ...endpointFields(e), enabled: false, keys: (Array.isArray(e.keys) ? e.keys : []).map(k => ({ id: randomUUID(), alias: text(k.alias, 'Key 别名', 48), enabled: false, credentialVersion: randomUUID() })) }));
    if (endpoints.reduce((n,e) => n + e.keys.length, 0) > 100) throw new UserError('导入的 Key 数量过多。');
    for (const e of endpoints) if (new Set(e.keys.map(k=>k.alias.toLowerCase())).size !== e.keys.length) throw new UserError('导入配置含重复别名。');
    const schedule = input.schedule || { intervalHours: 3, minute: 59 };
    if (!INTERVALS.includes(schedule.intervalHours) || !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) throw new UserError('导入的定时配置无效。');
    let notifications;
    try { notifications = updateNotifications(defaultNotifications(), { ...normalizeNotifications(input.notifications), enabled: false }, {}).config; }
    catch (e) { throw new UserError(e instanceof NotificationConfigError ? e.message : '通知偏好导入无效。'); }
    return this.edit(v => { v.config.endpoints = endpoints; v.secrets = {}; v.notificationSecrets = {}; v.config.schedule = { intervalHours: schedule.intervalHours, minute: schedule.minute }; v.config.notifications = notifications; return publicConfig(v); });
  }
  async results() { return Object.values(await this.read('latest.json', {})); }
  async history(limit = 100) {
    try { if ((await lstat(this.path('history.jsonl'))).isSymbolicLink()) throw new UserError('拒绝读取符号链接。'); return (await readFile(this.path('history.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).slice(-Math.min(limit, 500)).map(s => JSON.parse(s)).reverse(); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async saveSummary(summary, analysis, secrets = []) {
    const reportId = randomUUID();
    const safe = redact({ ...summary, reportId, limitation: LIMITATION }, secrets);
    await this.atomic(`reports/${reportId}.json`, { summary: safe, analysis: redact(analysis, secrets), limitation: LIMITATION });
    const latest = await this.read('latest.json', {}); latest[safe.keyId] = safe;
    await this.atomic('latest.json', latest);
    const historyPath = this.path('history.jsonl');
    try { if ((await lstat(historyPath)).isSymbolicLink()) throw new UserError('拒绝写入符号链接。'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
    await appendFile(historyPath, JSON.stringify(safe) + '\n', { mode: 0o600 });
    return safe;
  }
  async report(id) { if (!ID.test(id) || !/^[a-f0-9-]{36}$/.test(id)) throw new UserError('报告不存在。',404); return this.read(`reports/${id}.json`); }
  async runStatus() {
    const status = await this.read('current-run.json', { running: false, startedAt: null, activeAlias: null });
    if (status.running && status.pid) { try { process.kill(status.pid, 0); } catch { status.running = false; status.activeAlias = null; } }
    return status;
  }
}
