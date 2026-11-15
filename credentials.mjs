import { spawn as nativeSpawn } from 'node:child_process';

export class CredentialProtectionError extends Error {
  constructor() { super('Windows 当前账户凭据保护未能完成；请检查本机 PowerShell/DPAPI 环境。未输出凭据。'); this.name = 'CredentialProtectionError'; }
}
const MAX_OUTPUT = 4 * 1024 * 1024;
const SCRIPT_PREFIX = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Security; $inputText=[Console]::In.ReadToEnd(); ";
const PROTECT = SCRIPT_PREFIX + "$bytes=[Text.Encoding]::UTF8.GetBytes($inputText); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($protected));";
const UNPROTECT = SCRIPT_PREFIX + "$bytes=[Convert]::FromBase64String($inputText); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain));";

function invoke(script, input, options = {}) {
  return new Promise((resolve, reject) => {
    let child; let done = false; const chunks = []; let bytes = 0;
    const finish = (ok, value) => { if (done) return; done = true; clearTimeout(timer); ok ? resolve(value) : reject(new CredentialProtectionError()); };
    const timer = setTimeout(() => { finish(false); try { child?.kill?.(); } catch {} }, Math.min(options.timeoutMs || 10000, 10000));
    try {
      // Commands contain only a static script. ALL sensitive input uses stdin,
      // and stdout is consumed in memory, never echoed or logged.
      child = (options.spawnFn || nativeSpawn)(options.commandPath || 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) { finish(false); try { child.kill(); } catch {} return; }
        chunks.push(Buffer.from(chunk));
      });
      child.once('error', () => finish(false));
      child.once('close', code => finish(code === 0, Buffer.concat(chunks).toString('utf8').trim()));
      child.stdin.once('error', () => { finish(false); try { child.kill(); } catch {} });
      child.stdin.end(input, 'utf8');
    } catch { finish(false); try { child?.kill?.(); } catch {} }
  });
}
export async function protectVault(vault, options = {}) {
  const platform = options.platform || process.platform;
  const copy = structuredClone(vault);
  if (platform !== 'win32') { delete copy.protectedSecrets; return copy; }
  const payload = JSON.stringify({ secrets: copy.secrets || {}, notificationSecrets: copy.notificationSecrets || {} });
  const encrypted = await invoke(PROTECT, payload, options);
  if (!encrypted || !/^[A-Za-z0-9+/=]+$/.test(encrypted)) throw new CredentialProtectionError();
  delete copy.secrets; delete copy.notificationSecrets;
  copy.protectedSecrets = { kind: 'windows-dpapi-current-user', payload: encrypted };
  return copy;
}
export async function unprotectVault(raw, options = {}) {
  const copy = structuredClone(raw);
  if (!copy.protectedSecrets) return copy;
  if ((options.platform || process.platform) !== 'win32' || copy.protectedSecrets.kind !== 'windows-dpapi-current-user' || typeof copy.protectedSecrets.payload !== 'string') throw new CredentialProtectionError();
  const text = await invoke(UNPROTECT, copy.protectedSecrets.payload, options);
  let plain;
  try { plain = JSON.parse(text); } catch { throw new CredentialProtectionError(); }
  if (!plain || !plain.secrets || !plain.notificationSecrets || typeof plain.secrets !== 'object' || typeof plain.notificationSecrets !== 'object' || Array.isArray(plain.secrets) || Array.isArray(plain.notificationSecrets)) throw new CredentialProtectionError();
  copy.secrets = plain.secrets; copy.notificationSecrets = plain.notificationSecrets;
  delete copy.protectedSecrets;
  return copy;
}
