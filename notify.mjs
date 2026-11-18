import { spawn as nativeSpawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { normalizeNotifications, notificationRequest, NotificationConfigError } from './notification-config.mjs';

const MAX_BODY_CHARACTERS = 590;
const LIMITATION = '指纹不能独立证明降质；题库置信度不等于身份真实性或能力评分；astra/6.1-sol 为合并参考类。';
const DEFAULT_TIMEOUT = 30_000;

function count(text) { return [...text].length; }
function clipped(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function display(value, max = 28) {
  if (typeof value !== 'string' && typeof value !== 'number') return '未提供';
  const text = String(value).replace(/[\x00-\x1f\x7f]/gu, ' ').trim()
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{6,}/giu, '[密钥已隐藏]')
    .replace(/\bBearer\s+\S+/giu, '[凭据已隐藏]')
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|~\/)[^\s；，]*/gu, '[路径已隐藏]');
  return text ? clipped(text, max) : '未提供';
}

const STATUS_LABELS = {
  match: '匹配参考类', suspect: '偏离参考类', inconclusive: '证据不足',
  technical_error: '技术错误', skipped: '已跳过',
};

// One line per Key: alias + candidate. Without a candidate the conclusion stands in
// for it, so a skipped or failed Key is still visible instead of looking complete.
function candidate(result) {
  const r = result && typeof result === 'object' ? result : {};
  const name = display(r.topName, 40);
  if (name !== '未提供') return name;
  return typeof r.status === 'string' && Object.hasOwn(STATUS_LABELS, r.status)
    ? STATUS_LABELS[r.status] : (r.status == null ? '未提供' : '未知');
}

function resultLine(result) {
  const r = result && typeof result === 'object' ? result : {};
  // Never render reason, exception details, raw replies, report paths or key IDs.
  return `【${display(r.alias, 24)}】${candidate(r)}${r.alert === true ? '；连续异常，需人工复核' : ''}`;
}

function aggregateTitle(results) {
  if (results.some((result) => result?.alert === true)) return '连续异常，需要人工复核';
  // Aggregate every Key, including rows omitted from the bounded body. Mixed
  // batches prioritize errors, then suspect, then incomplete/unknown evidence.
  const statuses = results.map((result) => result?.status);
  if (statuses.includes('technical_error')) return '技术错误';
  if (statuses.includes('suspect')) return '待复核';
  if (!statuses.length || statuses.some((status) => status !== 'match' && status !== 'skipped')) return '无法判断';
  if (statuses.includes('match')) return '指纹一致';
  return '本轮跳过';
}

/** Pure, bounded Chinese summary. Untrusted reason/raw-response fields are ignored. */
export function formatNotification(batch = {}) {
  const source = batch && typeof batch === 'object' ? batch : {};
  const results = Array.isArray(source.results) ? source.results : [];
  const title = aggregateTitle(results);
  if (!results.length) {
    return { title, body: `未提供各 Key 结果。\n${LIMITATION}` };
  }
  const heading = `本批次 ${results.length} 个 Key（别名 → 候选）：`;
  const lines = [];
  for (let index = 0; index < results.length; index += 1) {
    const next = resultLine(results[index]);
    const remaining = results.length - index - 1;
    const omission = remaining ? `另有 ${remaining} 个 Key 未列出，请查看本地控制台。` : '';
    const draft = [heading, ...lines, next, omission, LIMITATION].filter(Boolean).join('\n');
    if (count(draft) > MAX_BODY_CHARACTERS) break;
    lines.push(next);
  }
  const omitted = results.length - lines.length;
  return {
    title,
    body: [heading, ...lines, omitted ? `另有 ${omitted} 个 Key 未列出，请查看本地控制台。` : '', LIMITATION].filter(Boolean).join('\n'),
  };
}

function validCommand(command) {
  return typeof command === 'string' && path.isAbsolute(command)
    && path.normalize(command) === command && !/[\x00-\x1f\x7f]/u.test(command);
}

/**
 * Send once, never retry. Default executable: ~/.local/bin/ai-notify.
 * spawnFn(command, ['-t', title], options) -> ChildProcess is the preferred DI.
 * execFileFn / execFile(command, argv, options, callback) -> ChildProcess is also
 * accepted; its returned child MUST expose writable stdin. Body is stdin only.
 * timeoutMs may lower (never raise) the 30s ceiling, useful for offline tests.
 */
export async function sendLegacyNotification(batch, options = {}) {
  const { enabled = true } = options;
  if (enabled === false) return { status: 'disabled' };
  const command = options.commandPath ?? path.join(homedir(), '.local', 'bin', 'ai-notify');
  if (!validCommand(command)) return { status: 'unavailable' };
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, DEFAULT_TIMEOUT) : DEFAULT_TIMEOUT;
  const { title, body } = options.message || formatNotification(batch);
  return new Promise((resolve) => {
    let child;
    let done = false;
    let timer;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failure = (error) => finish({ status: error?.code === 'ENOENT' ? 'unavailable' : 'failed' });
    timer = setTimeout(() => {
      // Mark the timeout before kill: injected children may emit close synchronously.
      finish({ status: 'failed' });
      try { child?.kill?.('SIGKILL'); } catch { /* Never expose child errors. */ }
    }, timeoutMs);
    try {
      const exec = options.execFileFn ?? options.execFile;
      if (exec && !options.spawnFn) {
        child = exec(command, ['-t', title], {
          timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 65_536,
          encoding: 'utf8', shell: false, windowsHide: true,
        }, (error) => {
          // Native execFile is asynchronous; defer synchronous test adapters too,
          // so a missing/broken stdin cannot report accepted before body delivery.
          queueMicrotask(() => {
            if (error) {
              if (Number.isInteger(error.code)) finish({ status: 'failed', exitCode: error.code });
              else failure(error);
            } else finish({ status: 'accepted', exitCode: 0 });
          });
        });
      } else {
        child = (options.spawnFn ?? nativeSpawn)(command, ['-t', title], {
          stdio: ['pipe', 'ignore', 'ignore'], shell: false, windowsHide: true,
          timeout: timeoutMs, killSignal: 'SIGKILL',
        });
      }
      if (!child || !child.stdin || typeof child.stdin.end !== 'function') {
        finish({ status: 'failed' });
        try { child?.kill?.('SIGKILL'); } catch { /* No raw error output. */ }
        return;
      }
      child.once?.('error', failure);
      child.once?.('close', (code) => {
        finish(Number.isInteger(code)
          ? { status: code === 0 ? 'accepted' : 'failed', exitCode: code }
          : { status: 'failed' });
      });
      child.stdin.once?.('error', () => {
        finish({ status: 'failed' });
        try { child.kill?.('SIGKILL'); } catch { /* No raw error output. */ }
      });
      child.stdin.end(body, 'utf8');
    } catch (error) {
      failure(error);
      try { child?.kill?.('SIGKILL'); } catch { /* No child is left running after stdin failure. */ }
    }
  });
}


async function boundedJson(response) {
  if (!response.body?.getReader) return await response.json();
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16384) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { try { await reader.cancel(); } catch {} }
}

export async function sendHttpNotification(message, options = {}) {
  const config = normalizeNotifications(options.config);
  const channel = config.channel;
  let request;
  try { request = notificationRequest(config, options.secrets || {}, message); }
  catch (error) { return { status: 'unavailable', channel, reasonCode: error instanceof NotificationConfigError ? 'configuration' : 'unavailable' }; }
  const controller = new AbortController();
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 10000) : 10000;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'failed', channel, reasonCode: 'timeout' }); }, timeoutMs); });
  const send = async () => {
    try {
      const response = await (options.fetchFn || fetch)(request.url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(request.payload),
        signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
      });
      const httpStatus = response.status;
      if (httpStatus >= 300 && httpStatus < 400) { try { await response.body?.cancel(); } catch {} return { status: 'failed', channel, reasonCode: 'redirect_blocked', httpStatus }; }
      if (!response.ok) { try { await response.body?.cancel(); } catch {} return { status: 'failed', channel, reasonCode: [401,403].includes(httpStatus) ? 'authentication' : 'http_error', httpStatus }; }
      if (channel === 'bark' || ['wecom','dingtalk'].includes(request.format)) {
        let result;
        try { result = await boundedJson(response); }
        catch { return { status: 'failed', channel, reasonCode: 'invalid_response', httpStatus }; }
        const accepted = channel === 'bark' ? result?.code === 200 : result?.errcode === 0;
        return { status: accepted ? 'accepted' : 'failed', channel, ...(accepted ? {} : { reasonCode: 'remote_rejected' }), httpStatus };
      }
      try { await response.body?.cancel(); } catch {}
      return { status: 'accepted', channel, httpStatus };
    } catch { return { status: 'failed', channel, reasonCode: controller.signal.aborted ? 'timeout' : 'network' }; }
  };
  try { return await Promise.race([send(), timeout]); }
  finally { clearTimeout(timer); }
}

/** Portable HTTP channels; explicit legacy fallback preserves v1 Mac behavior. */
export async function sendNotification(batch, options = {}) {
  const config = options.config ? normalizeNotifications(options.config) : { enabled: options.enabled !== false, channel: 'local_command' };
  const enabled = options.test === true || (options.enabled ?? config.enabled);
  if (!enabled) return { status: 'disabled', ...(options.config ? { channel: config.channel } : {}) };
  const message = options.message || formatNotification(batch);
  if (config.channel === 'local_command') {
    if (options.config && (options.platform || process.platform) !== 'darwin') return { status: 'unavailable', channel: 'local_command', reasonCode: 'unsupported_platform' };
    const result = await sendLegacyNotification(batch, { ...options, enabled: true, message });
    return { ...result, ...(options.config ? { channel: 'local_command' } : {}) };
  }
  return sendHttpNotification(message, { ...options, config });
}

export const TEST_NOTIFICATION_MESSAGE = {
  title: '指纹巡检台 · 通知配置测试',
  body: '这是一条由你主动发起的通知配置测试。未调用模型 API，未进行指纹检测，不消耗模型检测额度。服务接受请求不保证手机已显示；请检查接收端。',
};
