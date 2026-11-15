import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LABEL, buildPlist, scheduleStatus, enableSchedule, disableSchedule } from './scheduler.mjs';

async function fixture(t) {
  const temporaryParent = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temporaryParent, 'fingerprint-scheduler-test-'));
  t.after(async () => {
    assert.equal(path.dirname(base), temporaryParent);
    assert.ok(path.basename(base).startsWith('fingerprint-scheduler-test-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'product');
  const home = path.join(base, 'home');
  const dataDir = path.join(base, 'data');
  await fs.mkdir(root);
  await fs.mkdir(home);
  await fs.writeFile(path.join(root, 'job.py'), '# synthetic non-executed fixture\n');
  const nodePath = path.join(root, 'node executable');
  const pythonPath = path.join(root, 'python executable');
  await fs.writeFile(nodePath, 'synthetic');
  await fs.writeFile(pythonPath, 'synthetic');
  return { base, root, home, dataDir, nodePath, pythonPath, platform: 'darwin', uid: 501, intervalHours: 3, minute: 59 };
}

function mockLaunchd({ loaded = false, disabled = false, running = false, fail, stderr = 'RAW_SECRET_OUTPUT' } = {}) {
  const calls = [];
  const state = { loaded, disabled, running };
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args: [...args], options: { ...options } });
    assert.ok(file === '/bin/launchctl' || file === '/usr/bin/plutil', 'all subprocesses are mocked');
    assert.equal(options.shell, false);
    assert.ok(options.timeout <= 30_000);
    let error;
    let stdout = '';
    if (fail?.(file, args)) error = Object.assign(new Error(stderr), { code: 5 });
    else if (file === '/usr/bin/plutil') assert.equal(args[0], '-lint');
    else {
      const action = args[0];
      if (action === 'print-disabled') stdout = `{\n "${LABEL}" => ${state.disabled}\n "some.other.product" => true\n}`;
      else if (action === 'print') {
        if (!state.loaded) error = Object.assign(new Error(stderr), { code: 113 });
        else stdout = `gui/501/${LABEL} = {\n state = ${state.running ? 'running' : 'waiting'}\n}`;
      } else if (action === 'enable') state.disabled = false;
      else if (action === 'disable') state.disabled = true;
      else if (action === 'bootstrap') {
        assert.equal(state.disabled, false);
        state.loaded = true;
        state.running = false;
      } else if (action === 'bootout') { state.loaded = false; state.running = false; }
      else assert.fail(`unexpected child action: ${action}`);
      if (!['print-disabled', 'bootstrap'].includes(action)) assert.equal(args[1], `gui/501/${LABEL}`);
    }
    queueMicrotask(() => callback(error, stdout, stderr));
    return { kill() { assert.fail('normal mock should not time out'); } };
  };
  return { execFile, calls, state };
}

const pureOptions = {
  root: '/synthetic/product & <tag> "quote" \'apostrophe\'',
  home: '/synthetic/home', nodePath: '/synthetic/bin/node & x',
  pythonPath: '/synthetic/bin/python < y', dataDir: '/synthetic/data & z',
  uid: 501, intervalHours: 3, minute: 59,
};

test('plist is standalone, escaped XML, argument-array based, and never RunAtLoad', () => {
  const xml = buildPlist(pureOptions);
  assert.match(xml, /<key>Label<\/key><string>io\.local\.api-fingerprint-console\.monitor<\/string>/u);
  assert.match(xml, /product &amp; &lt;tag&gt; &quot;quote&quot; &apos;apostrophe&apos;\/job\.py/u);
  assert.match(xml, /<string>\/synthetic\/bin\/python &lt; y<\/string>/u);
  assert.match(xml, /<string>--scheduled<\/string>/u);
  assert.match(xml, /<key>RunAtLoad<\/key><false\/>/u);
  assert.match(xml, /<key>Umask<\/key><integer>63<\/integer>/u);
  assert.match(xml, /<key>NODE_EXECUTABLE<\/key>/u);
  assert.match(xml, /<key>CONSOLE_DATA_DIR<\/key>/u);
  assert.match(xml, /data &amp; z\/logs\/scheduler\.stdout\.log/u);
  assert.doesNotMatch(xml, /DSH|Agent|kickstart|\/bin\/sh|api[_-]?key/iu);
  assert.deepEqual([...xml.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer>/gu)].map((m) => Number(m[1])), [0, 3, 6, 9, 12, 15, 18, 21]);
});

test('all accepted intervals generate the expected calendar and settings aliases work', () => {
  for (const intervalHours of [1, 2, 3, 4, 6, 8, 12, 24]) {
    const xml = buildPlist({ ...pureOptions, intervalHours, minute: 0 });
    assert.equal([...xml.matchAll(/<key>Hour<\/key>/gu)].length, 24 / intervalHours);
    assert.match(xml, /<key>Minute<\/key><integer>0<\/integer>/u);
  }
  assert.match(buildPlist({ ...pureOptions, intervalHours: undefined, minute: undefined, schedule: { intervalHours: 24, minute: 7 } }), /<key>Minute<\/key><integer>7<\/integer>/u);
});

test('reject nonabsolute, traversal, control-character paths and invalid schedules', () => {
  for (const key of ['root', 'nodePath', 'pythonPath', 'dataDir', 'home']) {
    for (const value of ['relative/path', '/a/../b', '/a/./b', '/bad\npath', '/bad\0path']) {
      assert.throws(() => buildPlist({ ...pureOptions, [key]: value }), /绝对路径/u);
    }
  }
  for (const intervalHours of [0, 5, 25, '3']) assert.throws(() => buildPlist({ ...pureOptions, intervalHours }), /无效/u);
  for (const minute of [-1, 60, 1.5, '59']) assert.throws(() => buildPlist({ ...pureOptions, minute }), /无效/u);
});

test('enable lints then enables/bootstrap own label, file mode600, no immediate run', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd({ disabled: true });
  const status = await enableSchedule({ ...o, execFile: mock.execFile });
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.running, false);
  assert.ok(status.nextRunAt);
  const plist = path.join(o.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  assert.equal((await fs.stat(plist)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(o.dataDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(o.dataDir, 'logs'))).mode & 0o777, 0o700);
  assert.match(await fs.readFile(plist, 'utf8'), /<key>RunAtLoad<\/key><false\/>/u);
  assert.equal(mock.calls[0].file, '/usr/bin/plutil');
  const actions = mock.calls.map((call) => call.args[0]);
  assert.ok(actions.indexOf('enable') < actions.indexOf('bootstrap'));
  assert.ok(!actions.includes('kickstart'));
  assert.ok(!actions.includes('bootout'));
  assert.deepEqual(await fs.readdir(path.dirname(plist)), [`${LABEL}.plist`]);
});

test('re-enable only reloads own loaded label and never kickstarts', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd({ loaded: true });
  const result = await enableSchedule({ ...o, execFileFn: mock.execFile, intervalHours: 6, minute: 12 });
  assert.equal(result.enabled, true);
  const changes = mock.calls.filter((c) => ['bootout', 'enable', 'bootstrap'].includes(c.args[0]));
  assert.deepEqual(changes.map((c) => c.args[0]), ['bootout', 'enable', 'bootstrap']);
  assert.equal(changes[0].args[1], `gui/501/${LABEL}`);
  assert.equal(changes[2].args[1], 'gui/501');
});

test('disable persists launchctl override before bootout, keeps plist, survives simulated login', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd();
  await enableSchedule({ ...o, execFile: mock.execFile });
  mock.calls.length = 0;
  const disabled = await disableSchedule({ ...o, execFile: mock.execFile });
  assert.deepEqual({ installed: disabled.installed, enabled: disabled.enabled, running: disabled.running, nextRunAt: disabled.nextRunAt }, { installed: true, enabled: false, running: false, nextRunAt: null });
  assert.match(disabled.message, /下次登录/u);
  const actions = mock.calls.map((c) => c.args[0]);
  assert.ok(actions.indexOf('disable') < actions.indexOf('bootout'));
  assert.equal(mock.state.disabled, true);
  mock.state.loaded = !mock.state.disabled; // launchd respects the persistent override on login.
  const afterLogin = await scheduleStatus({ ...o, execFile: mock.execFile });
  assert.equal(afterLogin.installed, true);
  assert.equal(afterLogin.enabled, false);
  assert.equal(afterLogin.running, false);
  await enableSchedule({ ...o, execFile: mock.execFile });
  assert.equal(mock.state.disabled, false);
  assert.equal(mock.state.loaded, true);
});

test('status distinguishes absent, installed-unloaded, loaded-waiting, running, and override-disabled', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd();
  assert.equal((await scheduleStatus({ ...o, execFile: mock.execFile })).installed, false);
  await enableSchedule({ ...o, execFile: mock.execFile });
  mock.state.loaded = false;
  assert.equal((await scheduleStatus({ ...o, execFile: mock.execFile })).enabled, false);
  mock.state.loaded = true;
  mock.state.running = true;
  const running = await scheduleStatus({ ...o, execFile: mock.execFile });
  assert.equal(running.enabled, true);
  assert.equal(running.running, true);
  mock.state.disabled = true;
  const overridden = await scheduleStatus({ ...o, execFile: mock.execFile });
  assert.equal(overridden.installed, true);
  assert.equal(overridden.enabled, false);
  assert.equal(overridden.running, true); // a failed previous unload must remain visible.
  assert.equal(overridden.nextRunAt, null);
});

test('nextRunAt uses actual installed schedule, not default options', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd();
  await enableSchedule({ ...o, execFile: mock.execFile, intervalHours: 6, minute: 12 });
  const now = new Date(2026, 0, 2, 6, 12, 0);
  const status = await scheduleStatus({ ...o, execFile: mock.execFile, now });
  assert.equal(status.nextRunAt, new Date(2026, 0, 2, 12, 12, 0).toISOString());
});

test('Mac status detects an installed old runtime without rewriting or reloading it', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd();
  await enableSchedule({ ...o, execFile: mock.execFile });
  const plist = path.join(o.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const original = await fs.readFile(plist, 'utf8');
  assert.equal((await scheduleStatus({ ...o, execFile: mock.execFile })).runtimeOutdated, false);
  mock.calls.length = 0;
  const status = await scheduleStatus({ ...o, root: path.join(o.base, 'new-product'), execFile: mock.execFile });
  assert.equal(status.installed, true);
  assert.equal(status.enabled, true);
  assert.equal(status.runtimeOutdated, true);
  assert.deepEqual(mock.calls.map((call) => call.args[0]), ['print-disabled', 'print']);
  assert.equal(await fs.readFile(plist, 'utf8'), original);
});

test('Mac detects either stale job.py or WorkingDirectory, including escaped paths', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd({ loaded: true });
  const agents = path.join(o.home, 'Library', 'LaunchAgents');
  await fs.mkdir(agents, { recursive: true });
  const plist = path.join(agents, `${LABEL}.plist`);
  const source = buildPlist(o);
  for (const body of [
    source.replace(`<string>${path.join(o.root, 'job.py')}</string>`, '<string>/old/job.py</string>'),
    source.replace(`<key>WorkingDirectory</key><string>${o.root}</string>`, '<key>WorkingDirectory</key><string>/old</string>'),
  ]) {
    await fs.writeFile(plist, body);
    assert.equal((await scheduleStatus({ ...o, execFile: mock.execFile })).runtimeOutdated, true);
    assert.equal(await fs.readFile(plist, 'utf8'), body);
  }
  const root = `${o.root} & <tag> \"quote\" 'apostrophe'`;
  await fs.writeFile(plist, buildPlist({ ...o, root }));
  const status = await scheduleStatus({ ...o, root, execFile: mock.execFile });
  assert.equal(status.runtimeOutdated, false);
  assert.ok(mock.calls.every((call) => ['print-disabled', 'print'].includes(call.args[0])));
});

test('non-macOS operations reject with no child calls', async (t) => {
  const o = await fixture(t);
  const execFile = () => assert.fail('must never spawn');
  assert.equal((await scheduleStatus({ ...o, platform: 'linux', execFile })).enabled, false);
  await assert.rejects(enableSchedule({ ...o, platform: 'linux', execFile }), /macOS/u);
  await assert.rejects(disableSchedule({ ...o, platform: 'linux', execFile }), /macOS/u);
});

test('reject symlink LaunchAgents, parent Library, plist, data, logs, and log files before spawning', async (t) => {
  for (const type of ['agents', 'library', 'plist', 'data', 'logs', 'logfile']) {
    await t.test(type, async (sub) => {
      const o = await fixture(sub);
      const elsewhere = path.join(o.base, 'elsewhere');
      await fs.mkdir(elsewhere);
      const agents = path.join(o.home, 'Library', 'LaunchAgents');
      if (type === 'library') await fs.symlink(elsewhere, path.join(o.home, 'Library'));
      else if (type === 'agents') {
        await fs.mkdir(path.dirname(agents));
        await fs.symlink(elsewhere, agents);
      } else if (type === 'plist') {
        await fs.mkdir(agents, { recursive: true });
        const otherFile = path.join(elsewhere, 'other.plist');
        await fs.writeFile(otherFile, 'do not change');
        await fs.symlink(otherFile, path.join(agents, `${LABEL}.plist`));
      } else if (type === 'data') await fs.symlink(elsewhere, o.dataDir);
      else if (type === 'logs') {
        await fs.mkdir(o.dataDir);
        await fs.symlink(elsewhere, path.join(o.dataDir, 'logs'));
      } else {
        await fs.mkdir(path.join(o.dataDir, 'logs'), { recursive: true });
        const otherFile = path.join(elsewhere, 'other.log');
        await fs.writeFile(otherFile, 'do not change');
        await fs.symlink(otherFile, path.join(o.dataDir, 'logs', 'scheduler.stdout.log'));
      }
      await assert.rejects(enableSchedule({ ...o, execFile: () => assert.fail('unsafe paths cannot spawn') }), /排程操作失败/u);
      if (type === 'plist') assert.equal(await fs.readFile(path.join(elsewhere, 'other.plist'), 'utf8'), 'do not change');
    });
  }
});

test('disable rejects a symlink plist without touching launchctl', async (t) => {
  const o = await fixture(t);
  const agents = path.join(o.home, 'Library', 'LaunchAgents');
  await fs.mkdir(agents, { recursive: true });
  await fs.symlink(path.join(o.root, 'job.py'), path.join(agents, `${LABEL}.plist`));
  await assert.rejects(disableSchedule({ ...o, execFile: () => assert.fail('no children') }), /排程操作失败/u);
  const status = await scheduleStatus({ ...o, execFile: () => assert.fail('no children') });
  assert.equal(status.enabled, false);
  assert.match(status.message, /不安全/u);
});

test('lint failure is sanitized, no install/bootstrap occurs, staging file is removed', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd({ fail: (file) => file === '/usr/bin/plutil', stderr: 'sk-SYNTHETIC123 raw response password' });
  await assert.rejects(enableSchedule({ ...o, execFile: mock.execFile }), (error) => {
    assert.doesNotMatch(error.message, /SYNTHETIC|response|password/u);
    return true;
  });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(await fs.readdir(path.join(o.home, 'Library', 'LaunchAgents')), []);
});

test('failed persistent disable does not bootout, and errors never echo child output', async (t) => {
  const o = await fixture(t);
  const mock = mockLaunchd({ loaded: true, fail: (_file, args) => args[0] === 'disable' });
  await assert.rejects(disableSchedule({ ...o, execFile: mock.execFile }), (error) => {
    assert.doesNotMatch(error.message, /RAW_SECRET_OUTPUT/u);
    return true;
  });
  assert.deepEqual(mock.calls.map((c) => c.args[0]), ['disable']);
});

test('query failures are safe and promise-style execFile injection is supported', async (t) => {
  const o = await fixture(t);
  const status = await scheduleStatus({ ...o, execFile: async () => { throw new Error('PRIVATE_RAW_BODY'); } });
  assert.equal(status.enabled, false);
  assert.doesNotMatch(status.message, /PRIVATE_RAW_BODY/u);
  assert.match(status.message, /无法查询/u);
});

test('hung child times out once, is killed, and never retries', async (t) => {
  const o = await fixture(t);
  let calls = 0;
  let kills = 0;
  await assert.rejects(enableSchedule({ ...o, timeoutMs: 10, execFile: (_file, _args, opts) => {
    calls += 1;
    assert.equal(opts.timeout, 10);
    return { kill(signal) { assert.equal(signal, 'SIGKILL'); kills += 1; } };
  } }), /排程操作失败/u);
  assert.equal(calls, 1);
  assert.equal(kills, 1);
});
