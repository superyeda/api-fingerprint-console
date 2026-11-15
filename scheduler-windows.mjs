import { spawn as nativeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASK_NAME = 'io.local.api-fingerprint-console.monitor';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INTERVALS = new Set([1, 2, 3, 4, 6, 8, 12, 24]);
const SAFE_ERROR = 'Windows 排程操作失败；请检查当前用户权限和 Python/Node 运行环境。';
const MAX_OUTPUT = 65_536;

function absolute(value) {
  if (typeof value !== 'string' || !value || !path.win32.isAbsolute(value)
      || !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/iu.test(value)
      || /^\\\\[?.]\\/u.test(value) || path.win32.normalize(value) !== value
      || /[\p{Cc}"]/u.test(value) || value.slice(2).includes(':')) {
    throw new Error('Windows 排程路径必须是规范的绝对路径，且不能包含控制字符或双引号。');
  }
  return value;
}

function settings(options = {}) {
  const root = absolute(options.root ?? ROOT);
  const nodePath = absolute(options.nodePath ?? process.execPath);
  const pythonPath = absolute(options.pythonPath);
  if (path.win32.basename(pythonPath).toLowerCase() !== 'python.exe'
      || path.win32.basename(nodePath).toLowerCase() !== 'node.exe') {
    throw new Error('Windows 排程需要绝对路径的 python.exe 和 node.exe。');
  }
  const dataDir = absolute(options.dataDir ?? process.env.CONSOLE_DATA_DIR ?? path.win32.join(root, 'data'));
  const intervalHours = options.intervalHours ?? options.schedule?.intervalHours ?? 3;
  const minute = options.minute ?? options.schedule?.minute ?? 59;
  if (!INTERVALS.has(intervalHours) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('排程间隔或分钟无效。');
  }
  const powershell = path.win32.join(absolute(process.env.SystemRoot ?? 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return { ...options, root, nodePath, pythonPath, dataDir, intervalHours, minute, powershell };
}

function xml(value) {
  return String(value).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

// Windows CRT argv quoting: a terminal backslash must be doubled before the quote.
function quote(value) { return `"${value.replace(/(\\+)$/u, '$1$1')}"`; }
// Do not catch up missed events: a historical clock-aligned boundary must never
// cause monitoring to run just because the user registered/enabled the task.
const XML_TEMPLATE = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>API Fingerprint Console scheduled monitoring</Description></RegistrationInfo>
  <Triggers>@@TRIGGERS@@</Triggers>
  <Principals><Principal id="CurrentUser"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>false</StartWhenAvailable><AllowStartOnDemand>false</AllowStartOnDemand><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="CurrentUser"><Exec><Command>@@PYTHON@@</Command><Arguments>@@ARGUMENTS@@</Arguments><WorkingDirectory>@@ROOT@@</WorkingDirectory></Exec></Actions>
</Task>`;

/** Pure task XML builder; the current user's SID is assigned by the static COM script. */
export function buildTaskXml(options = {}) {
  const o = settings(options);
  const triggers = [];
  for (let hour = 0; hour < 24; hour += o.intervalHours) {
    triggers.push(`<CalendarTrigger><StartBoundary>2000-01-01T${String(hour).padStart(2, '0')}:${String(o.minute).padStart(2, '0')}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`);
  }
  const argumentsValue = `${quote(path.win32.join(o.root, 'job.py'))} --scheduled --node ${quote(o.nodePath)} --data-dir ${quote(o.dataDir)}`;
  const values = { TRIGGERS: triggers.join(''), PYTHON: xml(o.pythonPath), ARGUMENTS: xml(argumentsValue), ROOT: xml(o.root) };
  // A single replacement pass keeps literal placeholder-like user path text intact.
  return XML_TEMPLATE.replace(/@@(TRIGGERS|PYTHON|ARGUMENTS|ROOT)@@/gu, (_match, key) => values[key]);
}

// Static code only. No filesystem path, XML, argument, credential, or operation from
// the caller is interpolated into PowerShell source. All input arrives via stdin.
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Assert-Path([string]$value) {
  if ([string]::IsNullOrEmpty($value) -or $value -match '[\p{Cc}"]' -or
      $value -notmatch '^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or
      $value -match '^\\\\[?.]\\' -or $value.Substring(2).Contains(':') -or
      $value -match '(?:^|\\)\.{1,2}(?:\\|$)' -or $value.Contains('/') -or
      $value -match '(?<!^)\\\\') { throw 'Invalid path' }
}
function Escape-Xml([string]$value) { return [System.Security.SecurityElement]::Escape($value) }
function Quote-Argument([string]$value) { return '"' + [regex]::Replace($value, '(\\+)$', '$1$1') + '"' }
function Assert-Owner($task, [string]$sid) {
  $owner = [string]$task.Definition.Principal.UserId
  if ($owner -ne $sid) {
    $account = New-Object System.Security.Principal.NTAccount($owner)
    if ($account.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Foreign task' }
  }
}
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $allowed = @('operation','root','nodePath','pythonPath','dataDir','intervalHours','minute')
  foreach ($key in $inputData.PSObject.Properties.Name) { if ($key -cnotin $allowed) { throw 'Invalid input' } }
  if ($inputData.operation -isnot [string] -or $inputData.operation -cnotin @('status','enable','disable')) { throw 'Invalid operation' }
  foreach ($key in @('root','nodePath','pythonPath','dataDir')) { Assert-Path $inputData.$key }
  if ([System.IO.Path]::GetFileName($inputData.pythonPath) -ine 'python.exe' -or
      [System.IO.Path]::GetFileName($inputData.nodePath) -ine 'node.exe') { throw 'Invalid executable' }
  if ($inputData.intervalHours -isnot [int] -or $inputData.intervalHours -notin @(1,2,3,4,6,8,12,24) -or
      $inputData.minute -isnot [int] -or $inputData.minute -lt 0 -or $inputData.minute -gt 59) { throw 'Invalid schedule' }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $folder = $service.GetFolder('\')
  $taskName = 'io.local.api-fingerprint-console.monitor'
  $task = $null
  try { $task = $folder.GetTask($taskName) } catch {
    $missing = $false
    $failure = $_.Exception
    while ($null -ne $failure) {
      if ($failure.HResult -eq -2147024894 -or $failure.HResult -eq -2147216625) { $missing = $true }
      $failure = $failure.InnerException
    }
    if (-not $missing) { throw }
  }
  if ($null -ne $task) { Assert-Owner $task $sid }
  if ($inputData.operation -ceq 'enable') {
    foreach ($file in @($inputData.pythonPath, $inputData.nodePath, [System.IO.Path]::Combine($inputData.root, 'job.py'))) {
      if (-not [System.IO.File]::Exists($file)) { throw 'Missing runtime' }
    }
    if (-not [System.IO.Directory]::Exists($inputData.root)) { throw 'Missing root' }
    [void][System.IO.Directory]::CreateDirectory($inputData.dataDir)
    $triggers = ''
    for ($hour = 0; $hour -lt 24; $hour += $inputData.intervalHours) {
      $boundary = '2000-01-01T{0:00}:{1:00}:00' -f $hour, $inputData.minute
      $triggers += '<CalendarTrigger><StartBoundary>' + $boundary + '</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>'
    }
    $arguments = (Quote-Argument ([System.IO.Path]::Combine($inputData.root, 'job.py'))) + ' --scheduled --node ' + (Quote-Argument $inputData.nodePath) + ' --data-dir ' + (Quote-Argument $inputData.dataDir)
    $values = @{ TRIGGERS = $triggers; PYTHON = (Escape-Xml $inputData.pythonPath); ARGUMENTS = (Escape-Xml $arguments); ROOT = (Escape-Xml $inputData.root) }
    $template = @'
` + XML_TEMPLATE + String.raw`
'@
    $render = [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $values[$match.Groups[1].Value] }
    $taskXml = [regex]::Replace($template, '@@(TRIGGERS|PYTHON|ARGUMENTS|ROOT)@@', $render)
    $definition = $service.NewTask(0)
    $definition.XmlText = $taskXml
    $definition.Principal.UserId = $sid
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    # TASK_CREATE_OR_UPDATE=6, TASK_LOGON_INTERACTIVE_TOKEN=3; no password.
    # The definition contains only daily calendar triggers, never a registration trigger.
    $task = $folder.RegisterTaskDefinition($taskName, $definition, 6, $sid, $null, 3, $null)
  } elseif ($inputData.operation -ceq 'disable' -and $null -ne $task) {
    $task.Enabled = $false
  }
  $installed = $null -ne $task
  $enabled = $installed -and [bool]$task.Enabled
  $running = $installed -and $task.State -eq 4
  $nextRunAt = $null
  $workingDirectory = $null
  if ($installed) {
    $actions = $task.Definition.Actions
    if ($actions.Count -eq 1 -and $actions.Item(1).Type -eq 0) { $workingDirectory = [string]$actions.Item(1).WorkingDirectory }
    if ($enabled -and $task.NextRunTime.Year -gt 2000) { $nextRunAt = $task.NextRunTime.ToUniversalTime().ToString('o') }
  }
  @{ installed = [bool]$installed; enabled = [bool]$enabled; running = [bool]$running; nextRunAt = $nextRunAt; workingDirectory = $workingDirectory } | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('Schedule operation failed.'); exit 1 }
`;
const ENCODED_COMMAND = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');

function command(o, operation) {
  const input = JSON.stringify({ operation, root: o.root, nodePath: o.nodePath, pythonPath: o.pythonPath,
    dataDir: o.dataDir, intervalHours: o.intervalHours, minute: o.minute });
  const timeout = Number.isInteger(o.timeoutMs) && o.timeoutMs > 0 ? Math.min(o.timeoutMs, 30_000) : 30_000;
  return new Promise((resolve, reject) => {
    let child;
    let finished = false;
    let stdout = '';
    const complete = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(new Error(SAFE_ERROR));
      else {
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/u, ''))); }
        catch { reject(new Error(SAFE_ERROR)); }
      }
    };
    const abort = () => {
      if (finished) return;
      complete(new Error(SAFE_ERROR));
      try { child?.kill?.('SIGKILL'); } catch { /* Never expose child errors. */ }
    };
    const timer = setTimeout(abort, timeout);
    try {
      child = (o.spawnFn ?? nativeSpawn)(o.powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_COMMAND],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', abort);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT) abort();
      });
      child.stderr.resume(); // Drain, but never retain or expose stderr.
      child.on('close', (code) => complete(code === 0 ? null : new Error(SAFE_ERROR)));
      child.stdout.on('error', abort);
      child.stderr.on('error', abort);
      child.stdin.on('error', abort);
      child.stdin.end(input, 'utf8');
    } catch { abort(); }
  });
}

function emptyStatus(message) {
  return { installed: false, enabled: false, running: false, nextRunAt: null, runtimeOutdated: false, message };
}

function publicStatus(raw, o) {
  if (!raw || ['installed', 'enabled', 'running'].some((key) => typeof raw[key] !== 'boolean')
      || (!raw.installed && (raw.enabled || raw.running))
      || (raw.workingDirectory !== null && typeof raw.workingDirectory !== 'string')
      || (raw.nextRunAt !== null && (typeof raw.nextRunAt !== 'string' || !Number.isFinite(Date.parse(raw.nextRunAt))))) {
    throw new Error(SAFE_ERROR);
  }
  const runtimeOutdated = raw.installed && (typeof raw.workingDirectory !== 'string'
    || raw.workingDirectory.toLowerCase() !== o.root.toLowerCase());
  return {
    installed: raw.installed, enabled: raw.enabled, running: raw.running,
    nextRunAt: raw.enabled && raw.nextRunAt ? new Date(raw.nextRunAt).toISOString() : null,
    runtimeOutdated,
    message: raw.enabled ? 'Windows 原生定时监测已启用；仅当前用户登录时运行，不会立即执行。'
      : raw.installed ? 'Windows 原生定时监测已停用。' : '尚未安装 Windows 原生排程。',
  };
}

/** Read-only COM query; no task registration, run, enable or disable occurs here. */
export async function scheduleStatus(options = {}) {
  try {
    const o = settings(options);
    return publicStatus(await command(o, 'status'), o);
  } catch { return emptyStatus('无法查询 Windows 排程状态；请检查配置路径和当前用户权限。'); }
}

export async function enableSchedule(options = {}) {
  const o = settings(options);
  return publicStatus(await command(o, 'enable'), o);
}

/** Retain the task, change only this product's Enabled flag, and never stop running work. */
export async function disableSchedule(options = {}) {
  const o = settings(options);
  return publicStatus(await command(o, 'disable'), o);
}

// Offline injection: spawnFn(executable, argv, { shell:false, windowsHide:true,
// stdio:['pipe','pipe','pipe'] }) returns an EventEmitter child with stdin/stdout/
// stderr streams. stdin receives UTF-8 JSON; argv always contains identical static
// UTF-16LE encoded PowerShell source. No child output is logged or returned raw.
