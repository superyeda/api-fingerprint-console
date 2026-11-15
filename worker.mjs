import { Store, UserError } from './store.mjs';
import { runBatch } from './runner.mjs';

export async function worker(args = process.argv.slice(2)) {
  process.umask(0o077);
  const store = await new Store().init();
  if (args.length === 1 && args[0] === '--check') {
    const config = await store.config();
    console.log(JSON.stringify({ status: 'configuration_checked', requestsSent: 0, endpoints: config.endpoints.map(e => ({ name: e.name, model: e.model, effort: e.effort, keys: e.keys.map(k => ({ alias: k.alias, enabled: k.enabled, credentialAvailable: k.hasSecret })) })) }, null, 2));
    return 0;
  }
  const selection = {};
  let scheduled = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scheduled') scheduled = true;
    else if (args[i] === '--manual') scheduled = false;
    else if (['--key', '--endpoint'].includes(args[i]) && /^[a-z0-9-]{1,64}$/.test(args[i + 1] || '')) selection[args[i++] === '--key' ? 'keyId' : 'endpointId'] = args[i];
    else throw new UserError('执行参数无效。');
  }
  const batch = await runBatch(store, { scheduled, selection });
  console.log(JSON.stringify({ status: 'batch', ...batch }, null, 2));
  return batch.results.some(r => r.status === 'technical_error') ? 2 : 0;
}
try { process.exitCode = await worker(); }
catch { console.log(JSON.stringify({ status: 'technical_error', reason: '巡检执行或存储异常；未输出原始错误，未自动重试。' })); process.exitCode = 2; }
