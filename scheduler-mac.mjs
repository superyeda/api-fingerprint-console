import { execFile as nativeExecFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const LABEL = 'io.local.api-fingerprint-console.monitor';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INTERVALS = new Set([1, 2, 3, 4, 6, 8, 12, 24]);
const CHILD_TIMEOUT = 30_000;
const LAUNCHCTL = '/bin/launchctl';
const PLUTIL = '/usr/bin/plutil';
const SAFE_ERROR = '排程操作失败；请检查本地权限和运行环境。';

function absolute(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)
      || path.normalize(value) !== value || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error('排程路径必须是规范的绝对路径。');
  }
  return value;
}

function scheduleValues(options) {
  const intervalHours = options.intervalHours ?? options.schedule?.intervalHours ?? 3;
  const minute = options.minute ?? options.schedule?.minute ?? 59;
  if (!INTERVALS.has(intervalHours) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('排程间隔或分钟无效。');
  }
  return { intervalHours, minute };
}

function settings(options = {}) {
  const root = absolute(options.root ?? ROOT);
  const home = absolute(options.home ?? homedir());
  const dataDir = absolute(options.dataDir ?? process.env.CONSOLE_DATA_DIR ?? path.join(root, 'data'));
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('无法确定本机用户。');
  const agentsDir = path.join(home, 'Library', 'LaunchAgents');
  return {
    ...options, ...scheduleValues(options), root, home, dataDir, uid, agentsDir,
    nodePath: absolute(options.nodePath ?? process.execPath),
    pythonPath: absolute(options.pythonPath ?? '/usr/bin/python3'),
    plistPath: path.join(agentsDir, `${LABEL}.plist`),
    platform: options.platform ?? process.platform,
    execFile: options.execFileFn ?? options.execFile ?? nativeExecFile,
    domain: `gui/${uid}`, service: `gui/${uid}/${LABEL}`,
  };
}

function xml(value) {
  return String(value).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** Pure XML builder. All supplied filesystem paths must be canonical absolute paths. */
export function buildPlist(options) {
  const o = settings(options);
  const calendars = [];
  for (let hour = 0; hour < 24; hour += o.intervalHours) {
    calendars.push(`    <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${o.minute}</integer></dict>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(o.pythonPath)}</string><string>${xml(path.join(o.root, 'job.py'))}</string><string>--scheduled</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_EXECUTABLE</key><string>${xml(o.nodePath)}</string><key>CONSOLE_DATA_DIR</key><string>${xml(o.dataDir)}</string></dict>
  <key>WorkingDirectory</key><string>${xml(o.root)}</string>
  <key>RunAtLoad</key><false/>
  <key>Umask</key><integer>63</integer>
  <key>StartCalendarInterval</key>
  <array>
${calendars.join('\n')}
  </array>
  <key>StandardOutPath</key><string>${xml(path.join(o.dataDir, 'logs', 'scheduler.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(o.dataDir, 'logs', 'scheduler.stderr.log'))}</string>
</dict>
</plist>
`;
}

// Inspect every existing component, not only the final file. No credential files are read.
async function inspectPath(target, kind = 'file') {
  absolute(target);
  const parsed = path.parse(target);
  let current = parsed.root;
  const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw new Error(SAFE_ERROR);
    }
    if (stat.isSymbolicLink()) throw new Error('排程路径不允许符号链接。');
    const final = index === parts.length - 1;
    if ((!final || kind === 'directory') && !stat.isDirectory()) throw new Error('排程目录无效。');
    if (final && kind === 'file' && !stat.isFile()) throw new Error('排程文件无效。');
  }
  return true;
}

async function ensureDirectory(directory) {
  await inspectPath(directory, 'directory');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await inspectPath(directory, 'directory');
}

function command(o, executable, args) {
  return new Promise((resolve) => {
    let finished = false;
    let child;
    const timeout = Number.isInteger(o.timeoutMs) && o.timeoutMs > 0 ? Math.min(o.timeoutMs, CHILD_TIMEOUT) : CHILD_TIMEOUT;
    const complete = (error, stdout = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''), code: error?.code });
    };
    const timer = setTimeout(() => {
      complete(new Error(SAFE_ERROR));
      try { child?.kill?.('SIGKILL'); } catch { /* Child errors are private. */ }
    }, timeout);
    try {
      child = o.execFile(executable, [...args], {
        timeout, killSignal: 'SIGKILL', maxBuffer: 65_536,
        encoding: 'utf8', windowsHide: true, shell: false,
      }, complete);
      // Both the native callback interface and promise-returning offline adapters work.
      if (child && typeof child.then === 'function') {
        child.then((result) => complete(null, typeof result === 'string' ? result : result?.stdout), (error) => complete(error));
      }
    } catch { complete(new Error(SAFE_ERROR)); }
  });
}

async function requireSuccess(o, executable, args) {
  const result = await command(o, executable, args);
  if (!result.ok) throw new Error(SAFE_ERROR);
  return result;
}

function emptyStatus(message = '') {
  return { installed: false, enabled: false, running: false, message, nextRunAt: null, runtimeOutdated: false };
}

function nextRun(hours, minute, nowValue) {
  const now = new Date(typeof nowValue === 'function' ? nowValue() : nowValue ?? Date.now());
  if (!Number.isFinite(now.getTime())) return null;
  for (let day = 0; day < 3; day += 1) {
    for (const hour of hours) {
      const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, minute, 0, 0);
      // A nonexistent local clock time (DST jump) must not become a different hour.
      if (candidate.getHours() === hour && candidate.getMinutes() === minute && candidate > now) return candidate.toISOString();
    }
  }
  return null;
}

function unxml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (match, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

async function installedCalendar(o) {
  const stat = await fs.lstat(o.plistPath);
  if (stat.size > 131_072) throw new Error(SAFE_ERROR);
  // O_NOFOLLOW also protects against swapping the final component after lstat.
  const handle = await fs.open(o.plistPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents;
  try { contents = await handle.readFile('utf8'); } finally { await handle.close(); }
  const directory = contents.match(/<key>WorkingDirectory<\/key>\s*<string>([^]*?)<\/string>/u)?.[1];
  const argumentsXml = contents.match(/<key>ProgramArguments<\/key>\s*<array>([^]*?)<\/array>/u)?.[1] ?? '';
  const argumentsList = [...argumentsXml.matchAll(/<string>([^]*?)<\/string>/gu)].map((m) => unxml(m[1]));
  const job = argumentsList.find((value) => value.endsWith('/job.py'));
  const runtimeOutdated = (directory !== undefined && unxml(directory) !== o.root)
    || (job !== undefined && job !== path.join(o.root, 'job.py'))
    || (directory === undefined && job === undefined);
  const entries = [...contents.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/gu)];
  const valid = entries.length && !entries.some((m) => Number(m[1]) > 23 || Number(m[2]) > 59 || m[2] !== entries[0][2]);
  const calendar = valid ? { hours: [...new Set(entries.map((m) => Number(m[1])))].sort((a, b) => a - b), minute: Number(entries[0][2]) } : null;
  return { calendar, runtimeOutdated };
}

/** Read-only status. Child errors and untrusted command output never appear in messages. */
export async function scheduleStatus(options = {}) {
  let o;
  try { o = settings(options); } catch { return emptyStatus('排程配置路径或参数无效。'); }
  if (o.platform !== 'darwin') return emptyStatus('原生排程仅支持 macOS。');
  let installed;
  let calendar;
  let runtimeOutdated = false;
  try {
    installed = await inspectPath(o.plistPath);
    if (installed) ({ calendar, runtimeOutdated } = await installedCalendar(o));
  } catch { return emptyStatus('排程路径不安全或无法读取。'); }
  const disabled = await command(o, LAUNCHCTL, ['print-disabled', o.domain]);
  const loaded = await command(o, LAUNCHCTL, ['print', o.service]);
  if (!disabled.ok) return { ...emptyStatus('无法查询 macOS 排程状态。'), installed, runtimeOutdated };
  const escaped = LABEL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const explicitlyDisabled = new RegExp(`"${escaped}"\\s*=>\\s*true(?:\\s|[;,}])`, 'u').test(disabled.stdout);
  const enabled = installed && loaded.ok && !explicitlyDisabled;
  const running = loaded.ok && /\bstate\s*=\s*running\b/u.test(loaded.stdout);
  return {
    installed, enabled, running, runtimeOutdated,
    message: enabled ? '原生定时监测已启用；不会立即执行。' : explicitlyDisabled ? '原生定时监测已停用（下次登录也不会自动加载）。' : installed ? '排程已安装但未加载。' : '尚未安装原生排程。',
    nextRunAt: enabled && calendar ? nextRun(calendar.hours, calendar.minute, o.now) : null,
  };
}

function requireMac(o) {
  if (o.platform !== 'darwin') throw new Error('原生排程仅支持 macOS。');
}

function verifyOwnTarget(o, target, temporary = false) {
  absolute(target);
  const basename = path.basename(target);
  const isOwn = temporary
    ? basename.startsWith(`.${LABEL}.`) && basename.endsWith('.tmp.plist')
    : basename === `${LABEL}.plist`;
  if (path.dirname(target) !== o.agentsDir || !isOwn) throw new Error('拒绝操作非本产品的排程文件。');
}

/** Explicit UI action only. Never kickstarts, requests an API, or changes another label. */
export async function enableSchedule(options = {}) {
  const o = settings(options);
  requireMac(o);
  let temporary;
  try {
    if (!await inspectPath(o.root, 'directory') || !await inspectPath(path.join(o.root, 'job.py'))) throw new Error(SAFE_ERROR);
    // Executables may be legitimate package-manager symlinks; only stat them, never read them.
    for (const executable of [o.nodePath, o.pythonPath]) {
      const stat = await fs.stat(executable);
      if (!stat.isFile()) throw new Error(SAFE_ERROR);
    }
    await ensureDirectory(o.agentsDir);
    await ensureDirectory(o.dataDir);
    await ensureDirectory(path.join(o.dataDir, 'logs'));
    for (const name of ['scheduler.stdout.log', 'scheduler.stderr.log']) await inspectPath(path.join(o.dataDir, 'logs', name));
    verifyOwnTarget(o, o.plistPath);
    await inspectPath(o.plistPath);
    temporary = path.join(o.agentsDir, `.${LABEL}.${randomUUID()}.tmp.plist`);
    verifyOwnTarget(o, temporary, true);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(buildPlist(o), 'utf8'); } finally { await handle.close(); }
    await requireSuccess(o, PLUTIL, ['-lint', temporary]);
    const loaded = await command(o, LAUNCHCTL, ['print', o.service]);
    if (loaded.ok) await requireSuccess(o, LAUNCHCTL, ['bootout', o.service]);
    // Revalidate both exact absolute targets before the sole rename operation.
    verifyOwnTarget(o, temporary, true);
    verifyOwnTarget(o, o.plistPath);
    await inspectPath(temporary);
    await inspectPath(o.plistPath);
    await fs.rename(temporary, o.plistPath);
    temporary = undefined;
    await fs.chmod(o.plistPath, 0o600);
    await requireSuccess(o, LAUNCHCTL, ['enable', o.service]);
    await requireSuccess(o, LAUNCHCTL, ['bootstrap', o.domain, o.plistPath]);
    return await scheduleStatus(o);
  } catch {
    throw new Error(SAFE_ERROR);
  } finally {
    if (temporary) {
      // Never clean up a computed path unless it is still our regular staging file.
      try {
        verifyOwnTarget(o, temporary, true);
        if (await inspectPath(temporary)) await fs.unlink(temporary);
      } catch { /* A suspicious path is deliberately left untouched. */ }
    }
  }
}

/** Persistent disable override prevents login from auto-reloading the retained plist. */
export async function disableSchedule(options = {}) {
  const o = settings(options);
  requireMac(o);
  try {
    // Validate the installation path even though disable never removes any file.
    verifyOwnTarget(o, o.plistPath);
    await inspectPath(o.plistPath);
    await requireSuccess(o, LAUNCHCTL, ['disable', o.service]);
    const loaded = await command(o, LAUNCHCTL, ['print', o.service]);
    if (loaded.ok) await requireSuccess(o, LAUNCHCTL, ['bootout', o.service]);
    return await scheduleStatus(o);
  } catch { throw new Error(SAFE_ERROR); }
}

// Injection contract: execFile / execFileFn(file, argv, options, callback), or an
// async function returning { stdout }. Every call receives shell:false and a
// 30-second timeout; output is consumed for status only, never logged or echoed.
