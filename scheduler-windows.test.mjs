import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { TASK_NAME, buildTaskXml } from './scheduler-windows.mjs';
import { LABEL, scheduleStatus, enableSchedule, disableSchedule } from './scheduler.mjs';

const options = {
  platform: 'win32', root: 'C:\\应用 目录\\console & <tag> \'apostrophe\'',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  pythonPath: 'C:\\用户\\Python 安装\\python.exe', dataDir: 'D:\\用户数据 & cache',
  intervalHours: 3, minute: 59,
};

// Every test supplies spawnFn; no native PowerShell, schtasks, or launchctl is run.
function mockScheduler({ installed = false, enabled = false, running = false, workingDirectory,
  nextRunAt = '2026-11-16T01:59:00.0000000Z', fail = false, output, hang = false, spawnError = false } = {}) {
  const calls = [];
  const state = { installed, enabled, running, workingDirectory, nextRunAt };
  const spawnFn = (file, args, spawnOptions) => {
    const call = { file, args, spawnOptions };
    calls.push(call);
    assert.match(file, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.windowsHide, true);
    assert.deepEqual(spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(args.length, 5);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { call.killed = signal; };
    let input = '';
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { input += chunk.toString('utf8'); callback(); },
      final(callback) {
        call.input = JSON.parse(input);
        queueMicrotask(() => {
          if (spawnError) { child.emit('error', new Error('PRIVATE_SPAWN_ERROR')); return; }
          if (hang) return;
          const config = call.input;
          if (!fail) {
            if (config.operation === 'enable') {
              state.installed = true; state.enabled = true; state.workingDirectory = config.root;
            } else if (config.operation === 'disable') state.enabled = false;
            else assert.equal(config.operation, 'status');
          }
          const raw = { installed: state.installed, enabled: state.enabled, running: state.running,
            workingDirectory: state.installed ? state.workingDirectory ?? config.root : null,
            nextRunAt: state.enabled ? state.nextRunAt : null };
          child.stdout.end(output === undefined ? JSON.stringify(raw) : typeof output === 'function' ? output(raw) : output);
          child.stderr.end('RAW_PRIVATE_STDERR password synthetic');
          child.emit('close', fail ? 1 : 0);
        });
        callback();
      },
    });
    return child;
  };
  return { spawnFn, state, calls };
}

function scriptOf(call) { return Buffer.from(call.args[4], 'base64').toString('utf16le'); }

test('Windows XML uses daily local clock triggers for every allowed interval and minute', () => {
  for (const intervalHours of [1, 2, 3, 4, 6, 8, 12, 24]) {
    for (const minute of [0, 7, 59]) {
      const xml = buildTaskXml({ ...options, intervalHours, minute });
      const expected = [];
      for (let hour = 0; hour < 24; hour += intervalHours) expected.push(`2000-01-01T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
      assert.deepEqual([...xml.matchAll(/<StartBoundary>(.*?)<\/StartBoundary>/gu)].map((m) => m[1]), expected);
      assert.equal([...xml.matchAll(/<ScheduleByDay><DaysInterval>1<\/DaysInterval><\/ScheduleByDay>/gu)].length, 24 / intervalHours);
      assert.doesNotMatch(xml, /RegistrationTrigger|BootTrigger|LogonTrigger|Repetition|TimeZone/u);
    }
  }
  assert.match(buildTaskXml({ ...options, intervalHours: undefined, minute: undefined, schedule: { intervalHours: 24, minute: 7 } }), /2000-01-01T00:07:00/u);
});

test('XML escapes Unicode, spaces, metacharacters; action and least-privilege settings are fixed', () => {
  const xml = buildTaskXml(options);
  assert.match(xml, /<Command>C:\\用户\\Python 安装\\python\.exe<\/Command>/u);
  assert.match(xml, /&quot;C:\\应用 目录\\console &amp; &lt;tag&gt; &apos;apostrophe&apos;\\job\.py&quot; --scheduled --node &quot;C:\\Program Files\\nodejs\\node\.exe&quot; --data-dir &quot;D:\\用户数据 &amp; cache&quot;/u);
  assert.match(xml, /<WorkingDirectory>C:\\应用 目录\\console &amp; &lt;tag&gt; &apos;apostrophe&apos;<\/WorkingDirectory>/u);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(xml, /<StartWhenAvailable>false<\/StartWhenAvailable>/u);
  assert.match(xml, /<AllowStartOnDemand>false<\/AllowStartOnDemand>/u);
  assert.doesNotMatch(xml, /cmd\.exe|powershell\.exe|password|api[_-]?key|HighestAvailable/iu);
  const placeholders = buildTaskXml({ ...options, root: 'C:\\literal@@ROOT@@&@@PYTHON@@', dataDir: 'D:\\' });
  assert.match(placeholders, /literal@@ROOT@@&amp;@@PYTHON@@\\job\.py/u);
  assert.match(placeholders, /--data-dir &quot;D:\\\\&quot;/u);
  assert.doesNotThrow(() => buildTaskXml({ ...options, root: '\\\\server\\share\\应用 console' }));
});

test('Windows rejects noncanonical, relative, drive-relative, device, traversal and unsafe paths without spawn', async () => {
  const badPaths = ['relative\\path', 'C:relative', '\\root-relative', 'C:/forward/slash', 'C:\\a\\..\\b',
    'C:\\a\\.\\b', 'C:\\a\\\\b', 'C:\\bad\npath', 'C:\\bad\0path', 'C:\\bad\u0085path', 'C:\\bad"path',
    '\\\\?\\C:\\device', '\\\\.\\pipe\\device', 'C:\\file:stream'];
  for (const key of ['root', 'nodePath', 'pythonPath', 'dataDir']) {
    for (const value of badPaths) {
      const config = { ...options, [key]: value, spawnFn: () => assert.fail('invalid input cannot spawn') };
      assert.throws(() => buildTaskXml(config), /绝对路径/u);
      await assert.rejects(enableSchedule(config), /绝对路径/u);
      await assert.rejects(disableSchedule(config), /绝对路径/u);
      assert.equal((await scheduleStatus(config)).installed, false);
    }
  }
  for (const intervalHours of [0, 5, 25, '3']) assert.throws(() => buildTaskXml({ ...options, intervalHours }), /无效/u);
  for (const minute of [-1, 60, 1.5, '59']) assert.throws(() => buildTaskXml({ ...options, minute }), /无效/u);
  assert.throws(() => buildTaskXml({ ...options, pythonPath: 'C:\\bin\\cmd.exe' }), /python\.exe/u);
  assert.throws(() => buildTaskXml({ ...options, nodePath: 'C:\\bin\\arbitrary.exe' }), /node\.exe/u);
  assert.throws(() => buildTaskXml({ ...options, pythonPath: undefined }), /绝对路径/u);
});

test('dispatcher routes status, enable and disable using one constant encoded script and stdin JSON', async () => {
  const mock = mockScheduler();
  const config = { ...options, spawnFn: mock.spawnFn, taskName: 'some.other.task', operation: 'arbitrary' };
  const absent = await scheduleStatus(config);
  assert.deepEqual({ installed: absent.installed, enabled: absent.enabled, running: absent.running, nextRunAt: absent.nextRunAt, runtimeOutdated: absent.runtimeOutdated },
    { installed: false, enabled: false, running: false, nextRunAt: null, runtimeOutdated: false });
  const enabled = await enableSchedule(config);
  assert.equal(enabled.installed, true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.running, false);
  assert.equal(enabled.runtimeOutdated, false);
  assert.equal(enabled.nextRunAt, '2026-11-16T01:59:00.000Z');
  assert.match(enabled.message, /当前用户登录.*不会立即执行/u);
  mock.state.running = true;
  const disabled = await disableSchedule(config);
  assert.equal(disabled.installed, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.running, true); // Never stops work already running.
  assert.equal(disabled.nextRunAt, null);
  assert.deepEqual(mock.calls.map((c) => c.input.operation), ['status', 'enable', 'disable']);
  assert.equal(new Set(mock.calls.map((c) => c.args[4])).size, 1);
  for (const call of mock.calls) {
    assert.deepEqual(Object.keys(call.input).sort(), ['operation', 'root', 'nodePath', 'pythonPath', 'dataDir', 'intervalHours', 'minute'].sort());
    assert.equal(call.input.root, options.root);
    assert.equal(call.input.pythonPath, options.pythonPath);
    const script = scriptOf(call);
    for (const value of [options.root, options.nodePath, options.pythonPath, options.dataDir, 'some.other.task']) assert.ok(!script.includes(value));
  }
});

test('static PowerShell constrains operation, task identity and ownership; never shell-runs or starts a task', async () => {
  const mock = mockScheduler();
  await scheduleStatus({ ...options, spawnFn: mock.spawnFn });
  const script = scriptOf(mock.calls[0]);
  assert.equal(TASK_NAME, LABEL);
  assert.match(script, /\$taskName = 'io\.local\.api-fingerprint-console\.monitor'/u);
  assert.match(script, /@\('status','enable','disable'\)/u);
  assert.match(script, /\[Console\]::In\.ReadToEnd\(\) \| ConvertFrom-Json/u);
  assert.match(script, /New-Object -ComObject 'Schedule\.Service'/u);
  assert.match(script, /Assert-Owner \$task \$sid/u);
  assert.match(script, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/u);
  assert.match(script, /\.Principal\.LogonType = 3/u);
  assert.match(script, /\.Principal\.RunLevel = 0/u);
  assert.match(script, /RegisterTaskDefinition\(\$taskName, \$definition, 6, \$sid, \$null, 3, \$null\)/u);
  assert.match(script, /GetTask\(\$taskName\)/u);
  assert.match(script, /\$task\.Enabled = \$false/u);
  assert.match(script, /\$task\.NextRunTime\.ToUniversalTime\(\)/u);
  assert.match(script, /<StartWhenAvailable>false<\/StartWhenAvailable>/u, 'registering a historical boundary must not catch up missed runs');
  assert.doesNotMatch(script, /<StartWhenAvailable>true<\/StartWhenAvailable>|<RegistrationTrigger>/u);
  assert.doesNotMatch(script, /\.(?:Run|RunEx|Stop|DeleteTask)\s*\(|Invoke-Expression|Start-Process|schtasks|cmd\.exe|Register-ScheduledTask|RegistrationTrigger/iu);
});

test('Windows runtimeOutdated compares installed workingDirectory case-insensitively without modifying tasks', async () => {
  for (const [workingDirectory, expected] of [[options.root.toUpperCase(), false], ['C:\\old install', true], ['', true]]) {
    const mock = mockScheduler({ installed: true, enabled: true, workingDirectory });
    const status = await scheduleStatus({ ...options, spawnFn: mock.spawnFn });
    assert.equal(status.runtimeOutdated, expected);
    assert.equal(status.installed, true);
    assert.deepEqual(mock.calls.map((c) => c.input.operation), ['status']);
  }
});

test('COM query errors, spawn errors, invalid output and invalid dates are sanitized', async () => {
  const outputs = ['RAW_PRIVATE_BODY', '{"installed":true}', (raw) => JSON.stringify({ ...raw, enabled: 'true' }),
    (raw) => JSON.stringify({ ...raw, installed: false, enabled: true }),
    (raw) => JSON.stringify({ ...raw, nextRunAt: 'PRIVATE_BAD_DATE' }),
    (raw) => JSON.stringify({ ...raw, workingDirectory: 7 }), 'x'.repeat(65_537)];
  for (const input of [{ fail: true }, { spawnError: true }, ...outputs.map((output) => ({ output }))]) {
    const mock = mockScheduler({ installed: true, enabled: true, ...input });
    const config = { ...options, spawnFn: mock.spawnFn };
    const status = await scheduleStatus(config);
    assert.equal(status.enabled, false);
    assert.doesNotMatch(status.message, /PRIVATE|RAW|password/u);
    await assert.rejects(enableSchedule(config), (error) => {
      assert.doesNotMatch(error.message, /PRIVATE|RAW|password/u); return true;
    });
    await assert.rejects(disableSchedule(config), /排程操作失败/u);
  }
});

test('synchronous stdin failures terminate once and never expose raw subprocess errors', async () => {
  let kills = 0;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { kills++; child.emit('error', Error('PRIVATE_DUPLICATE_ERROR')); };
    child.stdin = new EventEmitter();
    child.stdin.end = () => { throw Error('PRIVATE_INPUT_FAILURE'); };
    return child;
  };
  await assert.rejects(enableSchedule({ ...options, spawnFn }), (error) => !error.message.includes('PRIVATE'));
  assert.equal(kills, 1);
});

test('PowerShell timeout kills the sole mocked subprocess and never retries', async () => {
  const mock = mockScheduler({ hang: true });
  await assert.rejects(enableSchedule({ ...options, timeoutMs: 10, spawnFn: mock.spawnFn }), /排程操作失败/u);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].killed, 'SIGKILL');
});

test('synchronous spawn failure is sanitized and BOM JSON output is supported', async () => {
  const status = await scheduleStatus({ ...options, spawnFn: () => { throw new Error('PRIVATE_EXCEPTION'); } });
  assert.doesNotMatch(status.message, /PRIVATE_EXCEPTION/u);
  const mock = mockScheduler({ output: (raw) => `\uFEFF${JSON.stringify(raw)}` });
  assert.equal((await scheduleStatus({ ...options, spawnFn: mock.spawnFn })).installed, false);
});
