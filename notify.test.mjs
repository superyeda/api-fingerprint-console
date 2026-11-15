import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { homedir } from 'node:os';
import { formatNotification, sendNotification } from './notify.mjs';

const result = {
  alias: '合成测试Key-A', requestedModel: 'gpt-6.1-sol', effort: 'low',
  startedAt: '2026-11-15T00:00:00.000Z', finishedAt: '2026-11-15T00:01:00.000Z',
  validSamples: 3, sampleCount: 3, topName: 'gpt-6-astra/6.1-sol', probability: 0.91,
  status: 'match', alert: false,
};
const batch = { startedAt: result.startedAt, finishedAt: result.finishedAt, results: [result] };

function spawnMock({ code = 0, error, hang = false, stdinError = false } = {}) {
  const calls = [];
  const children = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.body = '';
    child.kills = [];
    child.kill = (signal) => { child.kills.push(signal); child.emit('close', null, signal); };
    child.stdin = new EventEmitter();
    child.stdin.end = (body, encoding) => {
      child.body = body;
      assert.equal(encoding, 'utf8');
      queueMicrotask(() => {
        if (stdinError) child.stdin.emit('error', new Error('PRIVATE_STDIN_ERROR'));
        else if (error) child.emit('error', error);
        else if (!hang) child.emit('close', code, null);
      });
    };
    children.push(child);
    return child;
  };
  return { spawnFn, calls, children };
}

test('per-alias summary includes required fields and always preserves limitations', () => {
  const notification = formatNotification(batch);
  assert.equal(notification.title, '指纹一致');
  for (const expected of ['合成测试Key-A', '时间(本机)', 'gpt-6.1-sol', 'effort：low', '有效样本：3/3', 'gpt-6-astra/6.1-sol', '题库置信度：91.0%', '匹配参考类', '不能独立证明降质', '不等于身份真实性或能力评分', '合并参考类']) {
    assert.ok(notification.body.includes(expected), expected);
  }
  assert.ok([...notification.body].length <= 590);
});

test('only strict alert true selects manual review title, even if omitted result caused alert', () => {
  for (const alert of [false, undefined, 'true', 1, null]) {
    assert.equal(formatNotification({ results: [{ ...result, status: 'suspect', alert, anomalyStreak: 99 }] }).title, '待复核');
  }
  assert.equal(formatNotification({ results: [{ ...result, alert: true }] }).title, '连续异常，需要人工复核');
  const results = Array.from({ length: 30 }, (_, index) => ({ ...result, alias: `别名-${index}`, alert: index === 29 }));
  const notification = formatNotification({ results });
  assert.equal(notification.title, '连续异常，需要人工复核');
  assert.match(notification.body, /另有 \d+ 个 Key 未列出/u);
});

test('aggregate titles cover every status and conservatively prioritize mixed batches', () => {
  const cases = [
    [[], '无法判断'],
    [['match'], '指纹一致'],
    [['inconclusive'], '无法判断'],
    [['technical_error'], '技术错误'],
    [['skipped'], '本轮跳过'],
    [['suspect'], '待复核'],
    [['unknown'], '无法判断'],
    [[undefined], '无法判断'],
    [['match', 'skipped'], '指纹一致'],
    [['match', 'inconclusive'], '无法判断'],
    [['match', 'suspect'], '待复核'],
    [['suspect', 'technical_error', 'match'], '技术错误'],
  ];
  for (const [statuses, expected] of cases) {
    const notification = formatNotification({ results: statuses.map((status) => ({ ...result, status, alert: false })) });
    assert.equal(notification.title, expected);
    assert.doesNotMatch(notification.title, /人工复核|连续异常/u);
  }
  const omittedError = Array.from({ length: 30 }, (_, index) => ({ ...result, alias: `别名-${index}`, status: index === 29 ? 'technical_error' : 'match' }));
  const notification = formatNotification({ results: omittedError });
  assert.equal(notification.title, '技术错误');
  assert.match(notification.body, /另有 \d+ 个 Key 未列出/u);
});

test('technical errors never include raw reason, secret, raw response, or credential path', () => {
  const notification = formatNotification({ results: [{ ...result, status: 'technical_error', reason: 'SECRET_RAW_REASON sk-SYNTHETIC123 /Users/private/credentials.json', error: 'RAW_EXCEPTION', rawResponse: 'RAW_MODEL_REPLY', keyId: 'PRIVATE_KEY_ID' }] });
  assert.match(notification.body, /技术错误（请求未完成或数据不可用）/u);
  assert.doesNotMatch(notification.body, /SECRET_RAW_REASON|SYNTHETIC|credentials|RAW_EXCEPTION|RAW_MODEL_REPLY|PRIVATE_KEY_ID/u);
  assert.match(notification.body, /不能独立证明降质/u);
});

test('missing fields are explicit; invalid values do not become fake samples/confidence', () => {
  const notification = formatNotification({ results: [{}] });
  assert.match(notification.body, /【未提供】/u);
  assert.match(notification.body, /时间\(本机\)：未提供→未提供/u);
  assert.match(notification.body, /模型：未提供；effort：未提供/u);
  assert.match(notification.body, /有效样本：未提供\/未提供/u);
  assert.match(notification.body, /候选：未提供；题库置信度：未提供/u);
  assert.match(notification.body, /结论：未提供/u);
  const invalid = formatNotification({ results: [{ validSamples: -1, sampleCount: '3', probability: 1.2, startedAt: 'not-a-date', status: 'something-unknown' }] });
  assert.match(invalid.body, /结论：未知/u);
  assert.doesNotMatch(invalid.body, /120\.0%/u);
});

test('empty/malformed batches remain safe, explicit, and limited', () => {
  for (const value of [undefined, null, {}, { results: 'raw response' }, { results: [] }]) {
    const notification = formatNotification(value);
    assert.match(notification.body, /未提供各 Key 结果/u);
    assert.match(notification.body, /不能独立证明降质/u);
    assert.ok([...notification.body].length <= 590);
  }
  assert.match(formatNotification({ results: [null] }).body, /【未提供】/u);
});

test('all conclusions are mapped without copying untrusted reason', () => {
  for (const [status, text] of [['match', '匹配参考类'], ['suspect', '偏离参考类'], ['inconclusive', '证据不足'], ['skipped', '已跳过']]) {
    const notification = formatNotification({ results: [{ ...result, status, reason: 'NEVER_ECHO' }] });
    assert.ok(notification.body.includes(text));
    assert.doesNotMatch(notification.body, /NEVER_ECHO/u);
  }
});

test('many long targets stay below ~600 characters with honest omitted count', () => {
  const results = Array.from({ length: 500 }, (_, index) => ({ ...result, alias: `第${index}个${'很长别名😀'.repeat(200)}`, requestedModel: 'model'.repeat(100), topName: '候选'.repeat(100) }));
  const notification = formatNotification({ results });
  assert.ok([...notification.body].length <= 590, [...notification.body].length);
  assert.match(notification.body, /本批次 500 个 Key/u);
  const count = Number(notification.body.match(/另有 (\d+) 个 Key 未列出/u)[1]);
  const shown = [...notification.body.matchAll(/【/gu)].length;
  assert.equal(count + shown, 500);
  assert.ok(shown >= 1);
  assert.match(notification.body, /请查看本地控制台/u);
  assert.match(notification.body, /不能独立证明降质/u);
});

test('displayed fields remove controls and redact key-like values/credential paths', () => {
  const notification = formatNotification({ results: [{ ...result, alias: 'sk-SYNTHETIC123\n别名', topName: '/Users/synthetic/credentials.json', requestedModel: 'Bearer TOKEN_SYNTHETIC', effort: '\u0000low' }] });
  assert.doesNotMatch(notification.body, /sk-SYNTHETIC123|credentials\.json|TOKEN_SYNTHETIC|\u0000/u);
  assert.match(notification.body, /密钥已隐藏/u);
});

test('disabled notification never launches a child', async () => {
  const actual = await sendNotification(batch, { enabled: false, spawnFn() { assert.fail('must not spawn'); } });
  assert.deepEqual(actual, { status: 'disabled' });
});

test('default ai-notify uses argv only for title, body exclusively through stdin', async () => {
  const mock = spawnMock();
  const actual = await sendNotification(batch, { spawnFn: mock.spawnFn });
  assert.deepEqual(actual, { status: 'accepted', exitCode: 0 });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].command, path.join(homedir(), '.local', 'bin', 'ai-notify'));
  assert.deepEqual(mock.calls[0].args, ['-t', '指纹一致']);
  assert.deepEqual(mock.calls[0].options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(mock.calls[0].options.shell, false);
  assert.equal(mock.calls[0].options.timeout, 30_000);
  assert.equal(mock.children[0].body, formatNotification(batch).body);
  assert.ok(!mock.calls[0].args.includes(mock.children[0].body));
});

test('absolute command paths containing shell characters stay one executable argument', async () => {
  const mock = spawnMock();
  const commandPath = '/synthetic/path with spaces/notify; $(false)';
  assert.equal((await sendNotification(batch, { commandPath, spawnFn: mock.spawnFn })).status, 'accepted');
  assert.equal(mock.calls[0].command, commandPath);
  assert.equal(mock.calls[0].options.shell, false);
});

test('relative, traversal, or control-character commands are rejected without spawning', async () => {
  for (const commandPath of ['ai-notify', '/a/../b', '/bad\0path', '/bad\npath', '']) {
    assert.deepEqual(await sendNotification(batch, { commandPath, spawnFn() { assert.fail('must not spawn'); } }), { status: 'unavailable' });
  }
});

test('ENOENT is unavailable; child failure is generic and does not expose raw errors', async () => {
  const missing = spawnMock({ error: Object.assign(new Error('PRIVATE_SECRET_LOCATION'), { code: 'ENOENT' }) });
  assert.deepEqual(await sendNotification(batch, { spawnFn: missing.spawnFn }), { status: 'unavailable' });
  const failure = spawnMock({ error: new Error('PRIVATE_STDERR_SECRET') });
  assert.deepEqual(await sendNotification(batch, { spawnFn: failure.spawnFn }), { status: 'failed' });
  const nonzero = spawnMock({ code: 7 });
  assert.deepEqual(await sendNotification(batch, { spawnFn: nonzero.spawnFn }), { status: 'failed', exitCode: 7 });
  assert.equal(nonzero.calls.length, 1);
});

test('synchronous spawn errors are safe and signal termination is failed', async () => {
  const failure = await sendNotification(batch, { spawnFn() { throw new Error('RAW_PRIVATE_EXCEPTION'); } });
  assert.deepEqual(failure, { status: 'failed' });
  const mock = spawnMock({ code: null });
  assert.deepEqual(await sendNotification(batch, { spawnFn: mock.spawnFn }), { status: 'failed' });
});

test('stdin errors fail safely and kill the child without retries', async () => {
  const mock = spawnMock({ stdinError: true });
  assert.deepEqual(await sendNotification(batch, { spawnFn: mock.spawnFn }), { status: 'failed' });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.children[0].kills, ['SIGKILL']);
});

test('a hanging notification is killed at timeout, with no retries', async () => {
  const mock = spawnMock({ hang: true });
  const notification = await sendNotification(batch, { spawnFn: mock.spawnFn, timeoutMs: 10 });
  assert.deepEqual(notification, { status: 'failed' });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.children[0].kills, ['SIGKILL']);
  assert.equal(mock.calls[0].options.timeout, 10);
});

test('timeouts cannot exceed 30 seconds', async () => {
  const mock = spawnMock();
  await sendNotification(batch, { spawnFn: mock.spawnFn, timeoutMs: 999_999 });
  assert.equal(mock.calls[0].options.timeout, 30_000);
});

test('execFileFn callback injection sends stdin and does not echo captured stdout/stderr', async () => {
  let calls = 0;
  let input;
  const actual = await sendNotification(batch, { execFileFn(command, args, options, callback) {
    calls += 1;
    assert.equal(command, path.join(homedir(), '.local', 'bin', 'ai-notify'));
    assert.deepEqual(args, ['-t', '指纹一致']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 30_000);
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (body) => { input = body; queueMicrotask(() => callback(null, 'PRIVATE_STDOUT', 'PRIVATE_STDERR')); };
    return child;
  } });
  assert.deepEqual(actual, { status: 'accepted', exitCode: 0 });
  assert.equal(calls, 1);
  assert.equal(input, formatNotification(batch).body);
});

test('execFile alias supports errors and refuses adapters without stdin', async () => {
  const actual = await sendNotification(batch, { execFile(_command, _args, _options, callback) {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => callback(Object.assign(new Error('PRIVATE_SECRET'), { code: 4 }), '', 'PRIVATE_STDERR'));
    return child;
  } });
  assert.deepEqual(actual, { status: 'failed', exitCode: 4 });
  const invalid = await sendNotification(batch, { execFileFn() { return {}; } });
  assert.deepEqual(invalid, { status: 'failed' });
  const synchronousInvalid = await sendNotification(batch, { execFileFn(_command, _args, _options, callback) {
    callback(null, 'PRIVATE_STDOUT');
    return {};
  } });
  assert.deepEqual(synchronousInvalid, { status: 'failed' });
});

test('prototype-named statuses never become an inherited conclusion', () => {
  for (const status of ['toString', 'constructor', '__proto__']) {
    const notification = formatNotification({ results: [{ ...result, status }] });
    assert.match(notification.body, /结论：未知/u);
    assert.doesNotMatch(notification.body, /function|\[object Object\]/u);
  }
});

test('synchronous stdin exceptions kill the mock child and remain generic', async () => {
  const child = new EventEmitter();
  let killed = 0;
  child.kill = () => { killed += 1; };
  child.stdin = new EventEmitter();
  child.stdin.end = () => { throw new Error('PRIVATE_STDIN_EXCEPTION'); };
  const actual = await sendNotification(batch, { spawnFn: () => child });
  assert.deepEqual(actual, { status: 'failed' });
  assert.equal(killed, 1);
});
