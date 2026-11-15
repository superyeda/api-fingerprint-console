import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Store } from './store.mjs';
import { createApp } from './server.mjs';

const DEVICE='synthetic-notification-device-key';
const HOOK='https://hooks.offline.invalid/private?token=synthetic-hook-token';
const TOKEN='synthetic-auth-token';
const MODEL='synthetic-model-api-key';
async function appFixture(t,options={}) {
  const dir=await mkdtemp(join(tmpdir(),'fingerprint-notification-api-'));
  t.after(async()=>{const exact=resolve(dir);assert.equal(dirname(exact),resolve(tmpdir()));assert.ok(basename(exact).startsWith('fingerprint-notification-api-'));await rm(exact,{recursive:true,force:true});});
  const store=await new Store(dir).init();
  const endpoint=await store.addEndpoint({name:'合成测试接口',baseUrl:'https://model.offline.invalid/v1'});
  await store.addKey(endpoint.id,{alias:'mqs',secret:MODEL});
  let modelRuns=0;const sends=[];
  const scheduler={scheduleStatus:async()=>({installed:false,enabled:false,running:false,nextRunAt:null}),enableSchedule:async()=>{throw Error('not allowed');},disableSchedule:async()=>{throw Error('not allowed');}};
  const app=await createApp({store,scheduler,startJob:async()=>{modelRuns++;},notificationSender:options.notificationSender || (async(batch,config)=>{sends.push({batch,config});return {status:'accepted',channel:config.config.channel};}),...options});
  const url=await app.listen(0);t.after(()=>app.close());
  const response=await fetch(url+'/api/session');const cookie=response.headers.get('set-cookie').split(';')[0];const {csrfToken}=await response.json();
  const request=(path,method='GET',body,extra={})=>fetch(url+path,{method,headers:{Cookie:cookie,...(method==='GET'?{}:{Origin:url,'X-CSRF-Token':csrfToken,'Content-Type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const saveBark=()=>request('/api/notifications','POST',{enabled:false,channel:'bark',credentials:{barkDeviceKey:DEVICE}});
  return {store,url,request,saveBark,sends,modelRuns:()=>modelRuns};
}

test('notification form/tutorial are served; fresh portable configuration is disabled and not secretly ready',async t=>{
  const {request}=await appFixture(t);
  const state=await (await request('/api/state')).json();
  assert.equal(state.config.notifications.channel,'bark');assert.equal(state.config.notifications.enabled,false);assert.equal(state.notificationAvailable,false);
  assert.equal(state.lastTestNotification,null);assert.equal(state.platform.id,process.platform);
  const html=await (await request('/')).text();assert.match(html,/通知配置教程/);assert.match(html,/Bark/);assert.match(html,/Webhook/);
});
test('saving notification credentials never sends or starts model detection and never echoes values',async t=>{
  const f=await appFixture(t);const response=await f.request('/api/notifications','POST',{enabled:true,channel:'webhook',credentials:{barkDeviceKey:DEVICE,webhookUrl:HOOK,webhookToken:TOKEN}});
  assert.equal(response.status,200);const reply=await response.json();assert.equal(reply.notifications.hasWebhookUrl,true);
  assert.equal(f.sends.length,0);assert.equal(f.modelRuns(),0);
  for(const route of ['/api/state','/api/export']){const text=await(await f.request(route)).text();for(const secret of [DEVICE,HOOK,TOKEN,MODEL])assert.equal(text.includes(secret),false);}
  const exported=await(await f.request('/api/export')).json();assert.equal(exported.notifications.enabled,false);assert.equal('hasBarkKey' in exported.notifications,false);
});
test('notification test requires explicit confirmation and saved credentials before sending',async t=>{
  const f=await appFixture(t);
  assert.equal((await f.request('/api/notifications/test','POST',{})).status,400);
  assert.equal((await f.request('/api/notifications/test','POST',{confirmed:true})).status,400);
  assert.equal(f.sends.length,0);assert.equal(f.modelRuns(),0);
  assert.equal((await f.saveBark()).status,200);
  assert.equal((await f.request('/api/notifications/test','POST',{confirmed:true})).status,200);
  assert.equal(f.sends.length,1);assert.equal(f.modelRuns(),0);
});
test('test uses saved channel, even disabled automatic mode; ignores caller-supplied destination and sends no model Key',async t=>{
  const f=await appFixture(t);await f.saveBark();
  const response=await f.request('/api/notifications/test','POST',{confirmed:true,url:'https://attacker.invalid',credentials:{barkDeviceKey:'attacker'}});
  const body=await response.json();assert.equal(body.notification.status,'accepted');assert.equal(f.sends[0].config.test,true);
  assert.equal(f.sends[0].config.config.enabled,false);assert.equal(f.sends[0].config.secrets.barkDeviceKey,DEVICE);
  assert.equal(JSON.stringify(f.sends[0].config.secrets).includes(MODEL),false);assert.equal(JSON.stringify(body).includes(DEVICE),false);assert.equal(f.modelRuns(),0);
});
test('manual test record is separate from detection notification/history/reports',async t=>{
  const f=await appFixture(t);await f.saveBark();
  const oldTime='2026-11-15T00:00:00Z';await f.store.atomic('last-batch.json',{finishedAt:oldTime,notification:{status:'accepted',channel:'webhook'}});
  await f.request('/api/notifications/test','POST',{confirmed:true});
  const state=await(await f.request('/api/state')).json();
  assert.equal(state.lastNotification.channel,'webhook');assert.equal(state.lastNotification.finishedAt,oldTime);
  assert.equal(state.lastTestNotification.channel,'bark');assert.equal(state.lastTestNotification.status,'accepted');
  assert.deepEqual(await f.store.history(),[]);assert.deepEqual(await f.store.results(),[]);assert.equal(f.modelRuns(),0);
});
test('manual test cooldown prevents a second request without a second push',async t=>{
  const f=await appFixture(t);await f.saveBark();
  assert.equal((await f.request('/api/notifications/test','POST',{confirmed:true})).status,200);
  assert.equal((await f.request('/api/notifications/test','POST',{confirmed:true})).status,429);
  assert.equal(f.sends.length,1);
});
test('pending tests are locked before async reads so two tabs cannot send twice',async t=>{
  let release,markStarted;const started=new Promise(ok=>{markStarted=ok;});let calls=0;
  const f=await appFixture(t,{notificationSender:async()=>{calls++;markStarted();return new Promise(ok=>{release=()=>ok({status:'accepted'});});}});
  await f.saveBark();const first=f.request('/api/notifications/test','POST',{confirmed:true});await started;
  assert.equal((await f.request('/api/notifications/test','POST',{confirmed:true})).status,409);assert.equal(calls,1);
  release();assert.equal((await first).status,200);
});
test('invalid Bark full URL or secret input produces a safe error and no partial config mutation',async t=>{
  const f=await appFixture(t);await f.saveBark();
  const response=await f.request('/api/notifications','POST',{bark:{serverUrl:'https://api.day.app/'+DEVICE}});
  assert.equal(response.status,400);assert.equal((await response.text()).includes(DEVICE),false);
  const c=(await(await f.request('/api/state')).json()).config.notifications;
  assert.equal(c.bark.serverUrl,'https://api.day.app');assert.equal(c.hasBarkKey,true);assert.equal(f.sends.length,0);
});
test('blank save preserves Key; explicit clear affects only notification credential and never model Key',async t=>{
  const f=await appFixture(t);await f.saveBark();
  assert.equal((await f.request('/api/notifications','POST',{credentials:{barkDeviceKey:''}})).status,200);
  assert.equal((await f.store.privateSnapshot()).notificationSecrets.barkDeviceKey,DEVICE);
  assert.equal((await f.request('/api/notifications','POST',{enabled:false,clearSecrets:['barkDeviceKey']})).status,200);
  const v=await f.store.privateSnapshot();assert.equal(v.notificationSecrets.barkDeviceKey,undefined);assert.ok(Object.values(v.secrets).includes(MODEL));
});
test('notification API shares CSRF/origin protection, so arbitrary websites cannot save or test',async t=>{
  const f=await appFixture(t);await f.saveBark();
  assert.equal((await f.request('/api/notifications','POST',{enabled:true},{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.request('/api/notifications/test','POST',{confirmed:true},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal(f.sends.length,0);
});
test('non-secret configuration import clears both kinds of credentials and never auto-tests',async t=>{
  const f=await appFixture(t);await f.saveBark();const exported=await(await f.request('/api/export')).json();
  exported.notifications.credentials={barkDeviceKey:'malicious-import'};
  const reply=await f.request('/api/import','POST',exported);assert.equal(reply.status,200);
  const v=await f.store.privateSnapshot();assert.deepEqual(v.secrets,{});assert.deepEqual(v.notificationSecrets,{});assert.equal(v.config.notifications.enabled,false);assert.equal(f.sends.length,0);assert.equal(f.modelRuns(),0);
});
test('test sender exceptions and extra fields cannot leak credentials in HTTP response or saved record',async t=>{
  const f=await appFixture(t,{notificationSender:async()=>({status:'failed',reasonCode:'network',raw:DEVICE,token:TOKEN,httpStatus:'secret',channel:HOOK})});await f.saveBark();
  const response=await f.request('/api/notifications/test','POST',{confirmed:true});const text=await response.text();
  for(const secret of [DEVICE,TOKEN,HOOK])assert.equal(text.includes(secret),false);
  const record=await readFile(f.store.path('last-test-notification.json'),'utf8');for(const secret of [DEVICE,TOKEN,HOOK])assert.equal(record.includes(secret),false);
});
test('enabled old-runtime task must be explicitly upgraded or disabled before changing notification delivery',async t=>{
  let taskChanges=0;
  const scheduler={scheduleStatus:async()=>({installed:true,enabled:true,running:false,runtimeOutdated:true}),enableSchedule:async()=>{taskChanges++;},disableSchedule:async()=>{taskChanges++;}};
  const f=await appFixture(t,{scheduler});
  assert.equal((await f.saveBark()).status,409);assert.equal(taskChanges,0);assert.equal(f.sends.length,0);
  assert.deepEqual((await f.store.privateSnapshot()).notificationSecrets,{});
  const html=await(await f.request('/')).text();assert.match(html,/通知配置教程/);
});
