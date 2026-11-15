import http from 'node:http';
import { readFile, access, appendFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Store, ROOT, UserError, publicConfig } from './store.mjs';
import { runnableTargets } from './runner.mjs';
import * as native from './scheduler.mjs';
import { platformInfo, pythonExecutable } from './platform.mjs';
import { notificationReady } from './notification-config.mjs';
import { sendNotification, TEST_NOTIFICATION_MESSAGE } from './notify.mjs';

export async function createApp(options = {}) {
  const store = options.store || await new Store().init();
  const scheduler = options.scheduler || native;
  const platform = options.platform || process.platform;
  const pythonPath = options.pythonPath || await pythonExecutable({ platform });
  let testPending = false;
  let lastTestStartedAt = 0;
  const session = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  let runningJob = null;
  let port = null;
  const scheduleOptions = () => ({ root: ROOT, dataDir: store.dir, nodePath: process.execPath, pythonPath, platform });
  async function status() { return scheduler.scheduleStatus(scheduleOptions()); }
  async function runStatus() { const s = await store.runStatus(); return runningJob ? { ...s, running: true } : s; }
  async function state() {
    const vault = await store.privateSnapshot();
    let notificationAvailable = notificationReady(vault.config.notifications, vault.notificationSecrets, { platform });
    if (vault.config.notifications.channel === 'local_command' && notificationAvailable) {
      try { await access(join(homedir(), '.local/bin/ai-notify'), constants.X_OK); } catch { notificationAvailable = false; }
    }
    const lastBatch = await store.read('last-batch.json', {});
    return { version: '1.1.1', platform: platformInfo({ platform }), config: publicConfig(vault), scheduler: await status(), run: await runStatus(), results: await store.results(), history: await store.history(100), notificationAvailable, lastNotification: lastBatch.notification ? { ...lastBatch.notification, channel: lastBatch.notification.channel || 'local_command', finishedAt: lastBatch.finishedAt } : null, lastTestNotification: await store.read('last-test-notification.json', null) };
  }
  async function execute(selection) {
    if (options.startJob) return options.startJob(selection);
    const args = [join(ROOT, 'job.py'), '--manual'];
    if (selection.keyId) args.push('--key', selection.keyId);
    if (selection.endpointId) args.push('--endpoint', selection.endpointId);
    // No shell. The Python wrapper owns an OS file lock shared with launchd.
    const child = spawn(pythonPath, args, { cwd: ROOT, env: { ...process.env, NODE_EXECUTABLE: process.execPath, PYTHON_EXECUTABLE: pythonPath, CONSOLE_DATA_DIR: store.dir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    runningJob = child;
    const logPath = store.path('logs/manual.log');
    // Worker output is summary-only, stderr is intentionally discarded, never HTTP/key logs.
    child.stdout.on('data', chunk => { appendFile(logPath, chunk, { mode: 0o600 }).catch(() => {}); });
    child.stderr.resume();
    child.once('error', () => { if (runningJob === child) runningJob = null; });
    child.once('close', () => { if (runningJob === child) runningJob = null; });
  }
  function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new UserError('请求必须是 JSON。',415);
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 262144) throw new UserError('请求内容过大。',413); chunks.push(chunk); }
    try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data; }
    catch { throw new UserError('JSON 格式无效。'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) throw new UserError('仅允许本机访问。',403);
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/health' && req.method === 'GET') return json(res,200,{ product:'api-fingerprint-console', version:'1.1.1' });
      const expectedOrigin = `http://${host}`;
      if (req.headers.origin && req.headers.origin !== expectedOrigin) throw new UserError('拒绝跨站请求。',403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new UserError('拒绝跨站请求。',403);
      const cookie = `afc_session=${session}; HttpOnly; SameSite=Strict; Path=/`;
      if (url.pathname === '/' && req.method === 'GET') res.setHeader('Set-Cookie', cookie);
      if (url.pathname === '/api/session' && req.method === 'GET') { res.setHeader('Set-Cookie', cookie); return json(res,200,{ csrfToken }); }
      if (!url.pathname.startsWith('/api/')) {
        const files = { '/':'index.html', '/app.js':'app.js', '/styles.css':'styles.css' };
        if (req.method !== 'GET' || !files[url.pathname]) throw new UserError('页面不存在。',404);
        const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html';
        res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-cache'});
        return res.end(await readFile(join(ROOT,'public',files[url.pathname])));
      }
      const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
      if (!cookies.includes(`afc_session=${session}`)) throw new UserError('请刷新页面后重试。',401);
      const mutation = !['GET','HEAD'].includes(req.method);
      if (mutation && (req.headers.origin !== expectedOrigin || req.headers['x-csrf-token'] !== csrfToken)) throw new UserError('安全校验失败，请刷新页面。',403);
      const path = url.pathname;
      if (path === '/api/state' && req.method === 'GET') return json(res,200,await state());
      if (path === '/api/export' && req.method === 'GET') { res.setHeader('Content-Disposition','attachment; filename="fingerprint-config.json"'); return json(res,200,await store.exportConfig()); }
      if (path.startsWith('/api/reports/') && req.method === 'GET') return json(res,200,await store.report(path.split('/').at(-1)));
      if (mutation && (/^\/api\/(endpoints|keys|import)(\/|$)/.test(path)) && (await runStatus()).running) throw new UserError('检测运行中，请待本轮完成后修改接口或 Key。',409);
      const data = mutation ? await body(req) : {};
      if (path === '/api/endpoints' && req.method === 'POST') return json(res,201,{ endpoint: await store.addEndpoint(data) });
      let match = path.match(/^\/api\/endpoints\/([a-z0-9-]+)\/keys$/);
      if (match && req.method === 'POST') return json(res,201,{ key: await store.addKey(match[1],data) });
      match = path.match(/^\/api\/endpoints\/([a-z0-9-]+)$/);
      if (match && req.method === 'PUT') return json(res,200,{ endpoint:await store.updateEndpoint(match[1],data) });
      if (match && req.method === 'DELETE') return json(res,200,await store.removeEndpoint(match[1]));
      match = path.match(/^\/api\/keys\/([a-z0-9-]+)$/);
      if (match && req.method === 'PUT') return json(res,200,{ key:await store.updateKey(match[1],data) });
      if (match && req.method === 'DELETE') return json(res,200,await store.removeKey(match[1]));
      if (path === '/api/import' && req.method === 'POST') {
        if ((await status()).enabled) throw new UserError('请先停用定时任务，再导入配置。');
        return json(res,200,{ config: await store.importConfig(data) });
      }
      if (path === '/api/notifications' && req.method === 'POST') {
        const installed = await status();
        if (installed.enabled && installed.runtimeOutdated) throw new UserError('系统定时仍使用旧运行版本。请先应用新版本到系统定时，或停用该系统任务，再保存通知通道；不会自动修改现有任务。',409);
        return json(res,200,{ notifications: await store.notifications(data) });
      }
      if (path === '/api/notifications/test' && req.method === 'POST') {
        if (data.confirmed !== true) throw new UserError('请先确认发送一条真实通知测试；不会调用模型 API。');
        if (testPending) throw new UserError('已有通知测试发送中，请勿重复提交。',409);
        if (Date.now() - lastTestStartedAt < 30000) throw new UserError('通知测试间隔至少30秒，请稍后重试。',429);
        testPending = true;
        try {
          const vault = await store.privateSnapshot();
          if (!notificationReady(vault.config.notifications,vault.notificationSecrets,{platform})) throw new UserError('请先保存所选通知通道的完整配置。');
          lastTestStartedAt = Date.now();
          let result;
          try { result = await (options.notificationSender || sendNotification)(null,{ config:vault.config.notifications, secrets:vault.notificationSecrets, test:true, enabled:true, platform, message:TEST_NOTIFICATION_MESSAGE, ...(options.notificationFetchFn ? {fetchFn:options.notificationFetchFn} : {}) }); }
          catch { result = { status:'failed', reasonCode:'network' }; }
          const statuses = ['accepted','failed','disabled','unavailable'];
          const reasons = ['configuration','authentication','http_error','redirect_blocked','remote_rejected','invalid_response','network','timeout','unsupported_platform','unavailable'];
          const notification = { status:statuses.includes(result?.status)?result.status:'failed', channel:vault.config.notifications.channel, finishedAt:new Date().toISOString(), ...(reasons.includes(result?.reasonCode)?{reasonCode:result.reasonCode}:{}), ...(Number.isInteger(result?.httpStatus)&&result.httpStatus>=100&&result.httpStatus<=599?{httpStatus:result.httpStatus}:{}) };
          await store.atomic('last-test-notification.json',notification);
          return json(res,200,{ notification });
        } finally { testPending = false; }
      }
      if (path === '/api/settings' && req.method === 'POST') {
        if (data.schedule && (await runStatus()).running) throw new UserError('检测运行中，请待完成后调整定时参数。',409);
        const previous = await store.config();
        const config = await store.settings(data);
        if (data.schedule && (await status()).enabled) {
          try { await scheduler.enableSchedule({ ...scheduleOptions(), ...config.schedule }); }
          catch { await store.settings({ schedule: previous.schedule }); throw new UserError('系统定时更新未完成，已恢复页面时间参数；请检查权限并重新启用。',500); }
        }
        return json(res,200,{ config });
      }
      if (path === '/api/run' && req.method === 'POST') {
        if (data.confirmed !== true) throw new UserError('请先确认本轮将产生 API 调用费用。');
        if ((await runStatus()).running) throw new UserError('已有检测运行，请勿重复发起。',409);
        const selection = { endpointId:data.endpointId, keyId:data.keyId };
        if (!runnableTargets(await store.privateSnapshot(),selection).length) throw new UserError('没有可检测的 Key，请先配置并启用。');
        await execute(selection); return json(res,202,{ accepted:true });
      }
      if (path === '/api/schedule/enable' && req.method === 'POST') {
        const config = await store.config();
        if (config.legacyMonitor.present && data.legacyAcknowledged !== true) throw new UserError('请先确认旧巡检任务已检查并暂停，避免重复收费。');
        if (!runnableTargets(await store.privateSnapshot()).length) throw new UserError('请先配置至少一个可用 Key。');
        if ((await runStatus()).running) throw new UserError('检测运行中，请待本轮结束后启用或重新安装定时。',409);
        const saved = await store.settings({ schedule:{ intervalHours:data.intervalHours, minute:data.minute } });
        try { return json(res,200,{ scheduler: await scheduler.enableSchedule({ ...scheduleOptions(), ...saved.schedule }) }); }
        catch { await store.settings({ schedule: config.schedule }); throw new UserError('系统定时未能启用，已恢复页面时间参数；请检查权限后重试。',500); }
      }
      if (path === '/api/schedule/disable' && req.method === 'POST') return json(res,200,{ scheduler:await scheduler.disableSchedule(scheduleOptions()) });
      throw new UserError('接口不存在。',404);
    } catch (error) {
      if (!res.headersSent) json(res,error instanceof UserError ? error.status : 500,{ error:error instanceof UserError ? error.message : '操作未完成，请检查本机环境；不会输出凭据或原始错误。' });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server, store,
    async listen(selectedPort = 47831) {
      await new Promise((ok,fail) => { server.once('error',fail); server.listen(selectedPort,'127.0.0.1',ok); });
      port = server.address().port;
      return `http://127.0.0.1:${port}`;
    },
    async close() { server.closeAllConnections(); await new Promise(ok=>server.close(ok)); }
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const app = await createApp();
    const url = await app.listen(Number(process.env.CONSOLE_PORT || 47831));
    console.log(`API Fingerprint Console ready: ${url}`);
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal,async()=>{ await app.close(); process.exit(0); });
  } catch { console.error('启动失败：端口被占用，或本机数据/依赖不可用。未输出原始错误。'); process.exitCode=1; }
}
