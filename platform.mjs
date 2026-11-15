import { homedir } from 'node:os';
import path from 'node:path';
import { execFile as nativeExecFile } from 'node:child_process';

export function defaultDataDir({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const base = platform === 'win32' ? (env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? p.join(home, 'Library', 'Application Support') : p.join(home, '.local', 'share');
  return p.join(base, 'API Fingerprint Console', 'data');
}

export function platformInfo({ platform = process.platform } = {}) {
  return {
    id: platform, name: platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux / 其他',
    scheduler: platform === 'win32' ? '任务计划程序' : platform === 'darwin' ? 'launchd' : '不支持',
    nativeSchedulingSupported: ['darwin', 'win32'].includes(platform),
    secretsProtection: platform === 'win32' ? 'Windows DPAPI（当前账户）' : '本机文件权限保护',
    ...(platform === 'win32' ? { windowsValidation: 'Windows 适配未进行实机验收' } : {}),
  };
}

function validExecutable(value, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !p.isAbsolute(value) || p.normalize(value) !== value || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error('Python 可执行文件必须是规范的绝对路径。');
  }
  return value;
}

export async function pythonExecutable({ platform = process.platform, env = process.env, execFile = nativeExecFile } = {}) {
  if (env.PYTHON_EXECUTABLE) return validExecutable(env.PYTHON_EXECUTABLE, platform);
  if (platform !== 'win32') return platform === 'darwin' ? '/usr/bin/python3' : '/usr/bin/python3';
  // Fixed queries only: user paths and credentials never enter shell code.
  const query = (file, args) => new Promise((resolve) => {
    let finished = false;
    let child;
    const done = (error, stdout = '') => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve(error ? null : String(stdout));
    };
    const timer = setTimeout(() => { done(new Error()); child?.kill?.(); }, 10_000);
    try {
      child = execFile(file, args, { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4096, encoding: 'utf8' }, done);
      if (child?.then) child.then((r) => done(null, r?.stdout ?? r), (e) => done(e));
    } catch { done(new Error()); }
  });
  for (const [file, args] of [['py.exe', ['-3', '-c', 'import sys; print(sys.executable)']], ['python.exe', ['-c', 'import sys; print(sys.executable)']]]) {
    const result = await query(file, args);
    if (result !== null) {
      try { return validExecutable(result.trim(), platform); } catch { /* Try the next fixed query. */ }
    }
  }
  throw new Error('未找到 Python 3；请安装 Python 或通过启动器打开。');
}
