import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, defaultVault } from './store.mjs';
import { CredentialProtectionError } from './credentials.mjs';

const MODEL='synthetic-windows-model-key';
const DEVICE='synthetic-windows-device-key';
// This is intentionally a reversible fixture, NOT a replacement encryption
// implementation. Only the static native DPAPI process contract is simulated.
function mockDpapi() {
  const record={calls:0,failProtect:false,args:[]};
  const spawnFn=(_command,args)=>{
    record.calls++;record.args.push(args);
    const protect=Buffer.from(args.at(-1),'base64').toString('utf16le').includes('::Protect(');
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.kill=()=>{};
    child.stdin.end=input=>queueMicrotask(()=>{
      if(protect&&record.failProtect){child.stdout.emit('data',Buffer.from(MODEL));child.emit('close',1);return;}
      child.stdout.emit('data',Buffer.from(protect?Buffer.from(input).toString('base64'):Buffer.from(input,'base64').toString('utf8')));
      child.emit('close',0);
    });
    return child;
  };
  return {spawnFn,record};
}
async function directory(t) {
  const dir=await mkdtemp(join(tmpdir(),'fingerprint-vault-test-'));
  t.after(async()=>{const exact=resolve(dir);assert.equal(dirname(exact),resolve(tmpdir()));assert.ok(basename(exact).startsWith('fingerprint-vault-test-'));await rm(exact,{recursive:true,force:true});});
  return dir;
}
test('Windows Store serializes only protected secrets, while safe public state has presence flags',async t=>{
  const dir=await directory(t);const mock=mockDpapi();const store=await new Store(dir,{platform:'win32',protectionSpawnFn:mock.spawnFn}).init();
  const endpoint=await store.addEndpoint({name:'Windows fixture',baseUrl:'https://offline.invalid'});
  const key=await store.addKey(endpoint.id,{alias:'mqs',secret:MODEL});
  await store.notifications({enabled:true,channel:'bark',credentials:{barkDeviceKey:DEVICE}});
  const raw=await readFile(join(dir,'vault.json'),'utf8');const json=JSON.parse(raw);
  assert.equal(json.protectedSecrets.kind,'windows-dpapi-current-user');assert.equal('secrets' in json,false);assert.equal('notificationSecrets' in json,false);
  for(const v of [raw,JSON.stringify(await store.config()),JSON.stringify(await store.exportConfig()),JSON.stringify(mock.record.args)])for(const s of [MODEL,DEVICE])assert.equal(v.includes(s),false);
  const privateState=await store.privateSnapshot();assert.equal(privateState.secrets[key.id],MODEL);assert.equal(privateState.notificationSecrets.barkDeviceKey,DEVICE);
  assert.equal((await store.config()).notifications.hasBarkKey,true);
});
test('DPAPI failure aborts the atomic write and does not erase old credentials/config',async t=>{
  const dir=await directory(t);const mock=mockDpapi();const store=await new Store(dir,{platform:'win32',protectionSpawnFn:mock.spawnFn}).init();
  const endpoint=await store.addEndpoint({name:'fixture',baseUrl:'https://offline.invalid'});
  const key=await store.addKey(endpoint.id,{alias:'mqs',secret:MODEL});const before=await readFile(join(dir,'vault.json'),'utf8');
  mock.record.failProtect=true;
  await assert.rejects(store.updateKey(key.id,{secret:'new-synthetic-value'}),CredentialProtectionError);
  assert.equal(await readFile(join(dir,'vault.json'),'utf8'),before);
  mock.record.failProtect=false;assert.equal((await store.privateSnapshot()).secrets[key.id],MODEL);
});
test('existing Windows plaintext v1 vault migrates once without resetting model credentials or notification behavior',async t=>{
  const dir=await directory(t);const legacy=defaultVault();legacy.config.notifications={enabled:true};legacy.secrets={legacy:MODEL};delete legacy.notificationSecrets;
  await writeFile(join(dir,'vault.json'),JSON.stringify(legacy),{mode:0o600});
  const mock=mockDpapi();const store=await new Store(dir,{platform:'win32',protectionSpawnFn:mock.spawnFn}).init();
  const raw=JSON.parse(await readFile(join(dir,'vault.json'),'utf8'));assert.ok(raw.protectedSecrets);assert.equal('secrets' in raw,false);
  const v=await store.privateSnapshot();assert.equal(v.secrets.legacy,MODEL);assert.equal(v.config.notifications.channel,'local_command');assert.equal(v.config.notifications.enabled,true);
});
test('DPAPI data moved to another platform fails closed and is never overwritten with defaults',async t=>{
  const dir=await directory(t);const raw=JSON.stringify({config:defaultVault().config,protectedSecrets:{kind:'windows-dpapi-current-user',payload:'Zml4dHVyZQ=='}});
  await writeFile(join(dir,'vault.json'),raw,{mode:0o600});
  await assert.rejects(new Store(dir,{platform:'darwin'}).init(),CredentialProtectionError);
  assert.equal(await readFile(join(dir,'vault.json'),'utf8'),raw);
});
