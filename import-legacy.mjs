import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { Store, endpointFields, UserError } from './store.mjs';

// One-time migration of URL metadata and the separately saved zkj key only.
// NEVER reads Harness .credentials.yaml. Runtime has no dependency on Harness.
export async function importLegacy(legacyRoot, store) {
  if ((await store.config()).endpoints.length) throw new UserError('新产品已有配置，不会自动覆盖。');
  const legacy = JSON.parse(await readFile(join(legacyRoot,'config.json'),'utf8'));
  const profile = parse(await readFile(legacy.profilePath,'utf8'));
  const provider = profile.find(e=>e.id==='llm-pi-ai')?.config?.providers?.[legacy.providerId];
  if (!provider?.baseURL) throw new UserError('无法取得原接口地址，请在产品页面手动添加。');
  const fields = endpointFields({ name:'原 CPR 接口', baseUrl:provider.baseURL, model:legacy.model, api:legacy.api, effort:legacy.effort, expectedCandidateIds:legacy.expectedCandidateIds, expectedCandidateNames:legacy.expectedCandidateNames });
  const endpoint = { id:randomUUID(), ...fields, keys:[] };
  const secrets = {};
  for (const alias of ['mqs','zkj']) {
    const key = { id:randomUUID(), alias, enabled:false, credentialVersion:randomUUID() };
    if (alias === 'zkj') {
      const location = join(legacyRoot,'.secrets','zkj.key');
      try {
        const directory = await lstat(join(legacyRoot,'.secrets'));
        const metadata = await lstat(location);
        if (!directory.isDirectory() || directory.isSymbolicLink() || metadata.isSymbolicLink() || (directory.mode & 0o077) || (metadata.mode & 0o077)) throw new Error('Unsafe credential path');
        const secret = (await readFile(location,'utf8')).trim();
        if (!secret || /\s/.test(secret)) throw new Error('Invalid credential');
        secrets[key.id] = secret; key.enabled = true;
      } catch (error) { if (error.code !== 'ENOENT') throw new UserError('zkj 独立凭据未能安全迁移，请在页面重新录入。'); }
    }
    endpoint.keys.push(key);
  }
  await store.edit(v=>{ v.config.endpoints=[endpoint]; v.secrets=secrets; v.config.schedule={intervalHours:3,minute:59}; v.config.legacyMonitor={present:true}; });
  return { imported:true, aliases:endpoint.keys.map(k=>({alias:k.alias,enabled:k.enabled,credentialAvailable:Boolean(secrets[k.id])})), requestsSent:0 };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const store=await new Store().init();
    const source=resolve(process.argv[2] || join('..','api-hourly-monitor'));
    console.log(JSON.stringify(await importLegacy(source,store),null,2));
  } catch(error) { console.log(JSON.stringify({error:error instanceof UserError?error.message:'迁移未完成；未输出凭据或原始错误。'})); process.exitCode=2; }
}
