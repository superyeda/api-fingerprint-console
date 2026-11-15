export class NotificationConfigError extends Error {
  constructor(message = '通知配置无效，请检查填写内容。') { super(message); this.name = 'NotificationConfigError'; }
}
export const NOTIFICATION_CHANNELS = ['bark', 'webhook', 'local_command'];
const SECRET_FIELDS = ['barkDeviceKey', 'webhookUrl', 'webhookToken'];
const WEBHOOK_FORMATS = ['json', 'slack', 'wecom', 'dingtalk'];
const copy = value => structuredClone(value);
function boolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new NotificationConfigError('通知开关必须是布尔值。');
  return value;
}
function safeText(value, fallback = '', max = 100) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new NotificationConfigError('通知分组或提示音配置无效。');
  return value.trim();
}
export function defaultNotifications() {
  return { enabled: false, channel: 'bark', allowInsecure: false, bark: { serverUrl: 'https://api.day.app', group: 'API 指纹巡检', sound: '' }, webhook: { format: 'json' } };
}
export function normalizeNotifications(input) {
  const base = defaultNotifications();
  if (!input || typeof input !== 'object') return base;
  // Existing v1 notifications keep their local-command behavior; fresh installs use portable HTTP.
  return { enabled: typeof input.enabled === 'boolean' ? input.enabled : false,
    channel: NOTIFICATION_CHANNELS.includes(input.channel) ? input.channel : 'local_command',
    allowInsecure: input.allowInsecure === true,
    bark: { serverUrl: typeof input.bark?.serverUrl === 'string' ? input.bark.serverUrl : base.bark.serverUrl,
      group: typeof input.bark?.group === 'string' ? input.bark.group : base.bark.group,
      sound: typeof input.bark?.sound === 'string' ? input.bark.sound : '' },
    webhook: { format: WEBHOOK_FORMATS.includes(input.webhook?.format) ? input.webhook.format : 'json' } };
}
function httpUrl(value, allowInsecure, originOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw new NotificationConfigError(originOnly ? 'Bark 服务器地址格式不正确。' : 'Webhook URL 格式不正确。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || value.length > 8192) throw new NotificationConfigError('通知地址仅支持 HTTP/HTTPS，不能含账号、密码或片段。');
  if (url.protocol === 'http:' && !allowInsecure) throw new NotificationConfigError('HTTP 会明文发送凭据；请使用 HTTPS，或明确允许不安全 HTTP。');
  if (originOnly && (url.pathname !== '/' || url.search)) throw new NotificationConfigError('Bark 服务器只填写域名地址，不要带设备 Key、/push 或查询参数。');
  return originOnly ? url.origin : url.href;
}
function secretValue(value, field) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new NotificationConfigError('通知凭据格式无效；不会输出输入内容。');
  if (field === 'barkDeviceKey' && (value.length > 512 || /[\/:?#]/.test(value))) throw new NotificationConfigError('设备 Key 只填 Bark 的设备标识，不是完整推送 URL，也不是模型 API Key。');
  return value;
}
export function notificationReady(config, secrets = {}, { platform = process.platform } = {}) {
  const c = normalizeNotifications(config);
  if (c.channel === 'local_command') return platform === 'darwin';
  if (c.channel === 'bark') return Boolean(secrets.barkDeviceKey);
  return Boolean(secrets.webhookUrl);
}
export function publicNotifications(config, secrets = {}) {
  return { ...normalizeNotifications(config), hasBarkKey: Boolean(secrets.barkDeviceKey), hasWebhookUrl: Boolean(secrets.webhookUrl), hasWebhookToken: Boolean(secrets.webhookToken) };
}
export function updateNotifications(previous, input, privateSecrets = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new NotificationConfigError();
  const config = normalizeNotifications(previous);
  const secrets = copy(privateSecrets);
  if (input.channel !== undefined && !NOTIFICATION_CHANNELS.includes(input.channel)) throw new NotificationConfigError('不支持此通知通道。');
  config.channel = input.channel ?? config.channel;
  config.enabled = boolean(input.enabled, config.enabled);
  config.allowInsecure = boolean(input.allowInsecure, config.allowInsecure);
  if (input.bark !== undefined && (!input.bark || typeof input.bark !== 'object' || Array.isArray(input.bark))) throw new NotificationConfigError();
  if (input.webhook !== undefined && (!input.webhook || typeof input.webhook !== 'object' || Array.isArray(input.webhook))) throw new NotificationConfigError();
  config.bark.serverUrl = httpUrl(input.bark?.serverUrl ?? config.bark.serverUrl, config.allowInsecure, true);
  config.bark.group = safeText(input.bark?.group, config.bark.group, 100);
  config.bark.sound = safeText(input.bark?.sound, config.bark.sound, 80);
  const format = input.webhook?.format ?? config.webhook.format;
  if (!WEBHOOK_FORMATS.includes(format)) throw new NotificationConfigError('Webhook 消息格式无效。');
  config.webhook.format = format;
  if (input.clearSecrets !== undefined) {
    if (!Array.isArray(input.clearSecrets) || input.clearSecrets.some(k => !SECRET_FIELDS.includes(k))) throw new NotificationConfigError('清除通知凭据的选项无效。');
    for (const field of input.clearSecrets) delete secrets[field];
  }
  const supplied = input.credentials ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new NotificationConfigError();
  for (const field of SECRET_FIELDS) {
    if (supplied[field] !== undefined && supplied[field] !== '') secrets[field] = secretValue(supplied[field], field);
  }
  if (secrets.webhookUrl && (config.channel === 'webhook' || supplied.webhookUrl)) secrets.webhookUrl = httpUrl(secrets.webhookUrl, config.allowInsecure);
  if (config.enabled && config.channel !== 'local_command' && !notificationReady(config, secrets)) throw new NotificationConfigError('请先录入所选通道的通知凭据，或暂时关闭自动通知。');
  return { config, secrets };
}
export function notificationRequest(config, secrets, message) {
  const c = normalizeNotifications(config);
  const title = typeof message?.title === 'string' ? message.title.slice(0, 120) : '指纹巡检台';
  const body = typeof message?.body === 'string' ? message.body.slice(0, 2000) : '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' };
  if (c.channel === 'bark') {
    if (!secrets?.barkDeviceKey) throw new NotificationConfigError('请先配置 Bark 设备 Key。');
    const server = httpUrl(c.bark.serverUrl, c.allowInsecure, true);
    secretValue(secrets.barkDeviceKey, 'barkDeviceKey');
    return { channel: 'bark', url: server + '/push', headers,
      payload: { device_key: secrets.barkDeviceKey, title, body, ...(c.bark.group ? { group: c.bark.group } : {}), ...(c.bark.sound ? { sound: c.bark.sound } : {}) } };
  }
  if (c.channel === 'webhook') {
    if (!secrets?.webhookUrl) throw new NotificationConfigError('请先配置 Webhook URL。');
    const url = httpUrl(secrets.webhookUrl, c.allowInsecure);
    if (secrets.webhookToken) headers.Authorization = 'Bearer ' + secretValue(secrets.webhookToken, 'webhookToken');
    const content = `${title}\n${body}`;
    const payload = c.webhook.format === 'slack' ? { text: content }
      : ['wecom', 'dingtalk'].includes(c.webhook.format) ? { msgtype: 'text', text: { content } }
      : { event: 'api_fingerprint', title, body, text: content };
    return { channel: 'webhook', format: c.webhook.format, url, headers, payload };
  }
  throw new NotificationConfigError('此通道不使用 HTTP 发送。');
}
export function exportedNotifications(config) {
  return { ...normalizeNotifications(config), enabled: false };
}
export function notificationSecretValues(secrets = {}) { return SECRET_FIELDS.map(k => secrets[k]).filter(v => typeof v === 'string' && v); }
