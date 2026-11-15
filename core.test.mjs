import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { Store, UserError, publicConfig, endpointFields } from './store.mjs';
import { runBatch, classify, configKey, streak, due } from './runner.mjs';
import { createApp } from './server.mjs';

const SYNTHETIC = 'synthetic-secret-for-offline-tests-only';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'fingerprint-test-'));
  t.after(async()=> { const exact=resolve(dir); assert.equal(dirname(exact),resolve(tmpdir())); assert.ok(basename(exact).startsWith('fingerprint-test-')); await rm(exact,{recursive:true,force:true}); });
  return new Store(dir).init();
}
async function configured(t) {
  const store=await fixture(t);
  const endpoint=await store.addEndpoint({name:'测试接口',baseUrl:'https://offline.invalid/v1'});
  const first=await store.addKey(endpoint.id,{alias:'mqs',secret:SYNTHETIC});
  const second=await store.addKey(endpoint.id,{alias:'zkj',secret:SYNTHETIC+'-2'});
  return {store,endpoint,first,second};
}
function result(prediction='gpt-6-astra',probability=0.98) {
  return {samples:[{text:'1, 7, 15, 44'},{text:'1,2'},{text:'3,4'}],analysis:{decision:'scored',used_outputs:3,probability_status:'reference_calibrated',probability,prediction,prediction_name:prediction==='gpt-6-astra'?'gpt-6-astra/6.1-sol':prediction,model_version:'fixture-v1'}};
}
const noNotification = async()=>({status:'disabled'});
function detector(log=[],factory=()=>result()) { return async()=>({builtAt:'fixture',detect:async config=>{ log.push({aliasKey:config.apiKey,baseUrl:config.baseUrl,model:config.model,effort:config.effort,count:config.count}); return factory(config); }}); }

test('fresh store and private file modes; no endpoints or scheduler enabled automatically',async t=>{
  const store=await fixture(t); const c=await store.config(); assert.deepEqual(c.endpoints,[]);
  assert.equal((await lstat(store.dir)).mode&0o777,0o700); assert.equal((await lstat(store.path('vault.json'))).mode&0o777,0o600);
});
test('one URL accepts multiple named credentials; public state and export never contain Key values',async t=>{
  const {store,endpoint}=await configured(t); const config=await store.config();
  assert.equal(config.endpoints[0].keys.length,2); assert.equal(config.endpoints[0].keys[0].hasSecret,true);
  for (const data of [config,await store.exportConfig()]) assert.equal(JSON.stringify(data).includes(SYNTHETIC),false);
  assert.equal((await store.privateSnapshot()).secrets[config.endpoints[0].keys[0].id],SYNTHETIC);
  await assert.rejects(store.addKey(endpoint.id,{alias:'MQS',secret:'other'}),UserError);
});
test('credential rotation and blank preserve; alias is independent of a secret',async t=>{
  const {store,first}=await configured(t); const before=await store.privateSnapshot();
  await store.updateKey(first.id,{alias:'主线路',secret:''}); const renamed=await store.privateSnapshot();
  assert.equal(renamed.secrets[first.id],SYNTHETIC); assert.equal(renamed.config.endpoints[0].keys[0].credentialVersion,before.config.endpoints[0].keys[0].credentialVersion);
  await store.updateKey(first.id,{secret:'synthetic-rotated'}); const after=await store.privateSnapshot();
  assert.notEqual(after.config.endpoints[0].keys[0].credentialVersion,before.config.endpoints[0].keys[0].credentialVersion);
});
test('invalid URLs / credentials rejected without echo; a missing Key stays disabled',async t=>{
  const store=await fixture(t);
  for (const url of ['javascript:alert(1)','https://u:p@offline.invalid','https://offline.invalid?key=private','file:///tmp/test']) assert.throws(()=>endpointFields({name:'test',baseUrl:url}),UserError);
  const endpoint=await store.addEndpoint({name:'empty',baseUrl:'https://offline.invalid'});
  const key=await store.addKey(endpoint.id,{alias:'待配置'}); assert.equal(key.enabled,false);
  await assert.rejects(store.updateKey(key.id,{enabled:true}),UserError);
  await assert.rejects(store.addKey(endpoint.id,{alias:'bad',secret:'has whitespace'}),UserError);
});
test('non-secret export/import creates new IDs and disabled keys with no imported secrets',async t=>{
  const {store,endpoint}=await configured(t); const exported=await store.exportConfig();
  exported.endpoints[0].keys[0].secret='malicious-imported-value';
  await store.importConfig(exported); const v=await store.privateSnapshot();
  assert.deepEqual(v.secrets,{}); assert.notEqual(v.config.endpoints[0].id,endpoint.id); assert.equal(v.config.endpoints[0].enabled,false);
  assert.ok(v.config.endpoints[0].keys.every(k=>!k.enabled));
});
test('deleting endpoint deletes associated credentials, not another endpoint',async t=>{
  const {store,endpoint}=await configured(t); const other=await store.addEndpoint({name:'other',baseUrl:'https://other.invalid'});
  const otherKey=await store.addKey(other.id,{alias:'other',secret:'synthetic-other'});
  await store.removeEndpoint(endpoint.id); const v=await store.privateSnapshot(); assert.deepEqual(Object.keys(v.secrets),[otherKey.id]);
});
test('runner uses URL/model/effort and distinct Keys with exactly 3 samples each, not an agent',async t=>{
  const {store}=await configured(t); const calls=[];
  const batch=await runBatch(store,{detectorLoader:detector(calls),notifier:noNotification});
  assert.equal(calls.length,2); assert.equal(calls[0].count,3); assert.equal(calls[0].effort,'low'); assert.equal(calls[0].baseUrl,'https://offline.invalid/v1');
  assert.notEqual(calls[0].aliasKey,calls[1].aliasKey); assert.ok(batch.results.every(r=>r.status==='match'));
  assert.equal(JSON.stringify(batch).includes(SYNTHETIC),false); assert.equal((await store.runStatus()).running,false);
});
test('technical failure in mqs does not stop zkj, produce false quality alert, or leak errors',async t=>{
  const {store}=await configured(t); const calls=[];
  const batch=await runBatch(store,{detectorLoader:detector(calls,c=>{if(c.apiKey===SYNTHETIC)throw new Error(SYNTHETIC);return result();}),notifier:noNotification});
  assert.equal(calls.length,2); assert.equal(batch.results[0].status,'technical_error'); assert.equal(batch.results[0].alert,false); assert.equal(batch.results[1].status,'match');
  assert.equal(JSON.stringify(batch).includes(SYNTHETIC),false);
  assert.equal((await readFile(store.path('history.jsonl'),'utf8')).includes(SYNTHETIC),false);
});
test('three-hour scheduled dedup is per key; recent results never cause another key to be omitted',async t=>{
  const {store,first}=await configured(t); let clock=new Date('2026-11-15T03:59:00Z'); const calls=[];
  await runBatch(store,{selection:{keyId:first.id},now:()=>clock,detectorLoader:detector(calls),notifier:noNotification});
  clock=new Date('2026-11-15T04:10:00Z');
  const batch=await runBatch(store,{scheduled:true,now:()=>clock,detectorLoader:detector(calls),notifier:noNotification});
  assert.equal(batch.results[0].status,'skipped'); assert.equal(batch.results[1].status,'match'); assert.equal(calls.length,2);
});
test('alert requires two adjacent comparable suspect rounds, never technical errors',()=>{
  const s={status:'suspect',configKey:'same',detectorVersion:'v1',topModel:'other',startedAt:'2026-11-15T06:59:00Z'};
  const p={...s,startedAt:'2026-11-15T03:59:00Z',anomalyStreak:1};
  assert.equal(streak(s,p,3),2); assert.equal(streak({...s,status:'technical_error'},p,3),0);
  assert.equal(streak(s,{...p,detectorVersion:'old'},3),1);
  assert.equal(streak(s,{...p,startedAt:'2026-11-15T00:59:00Z'},3),1);
  assert.equal(due(p,'same',Date.parse('2026-11-15T05:00:00Z'),3),false);
});
test('reference load failures do not trigger requests or automatic retries',async t=>{
  const {store}=await configured(t); let loads=0;
  const batch=await runBatch(store,{detectorLoader:async()=>{loads++;throw Error('synthetic');},notifier:noNotification});
  assert.equal(loads,1); assert.ok(batch.results.every(r=>r.status==='technical_error'&&!r.alert));
});
test('report stores only safe analysis and summary, not raw prompts or responses',async t=>{
  const {store}=await configured(t);
  const batch=await runBatch(store,{detectorLoader:detector([],()=>({...result(),raw:'DO NOT PERSIST',samples:[{text:'1,2,3,4',raw:'DO NOT PERSIST'}]})),notifier:noNotification});
  const report=await store.report(batch.results[0].reportId);
  assert.equal(JSON.stringify(report).includes('DO NOT PERSIST'),false); assert.equal(JSON.stringify(report).includes(SYNTHETIC),false);
});

async function webFixture(t) {
  const {store,...other}=await configured(t); let enabled=false; let runs=0;
  const sched={scheduleStatus:async()=>({installed:enabled,enabled,running:false,message:'offline fixture',nextRunAt:null}),enableSchedule:async()=>{enabled=true;return sched.scheduleStatus();},disableSchedule:async()=>{enabled=false;return sched.scheduleStatus();}};
  const app=await createApp({store,scheduler:sched,startJob:async()=>{runs++;}}); const url=await app.listen(0); t.after(()=>app.close());
  const response=await fetch(url+'/api/session'); const cookie=response.headers.get('set-cookie').split(';')[0]; const {csrfToken}=await response.json();
  const request=(path,method='GET',data,extra={})=>fetch(url+path,{method,headers:{Cookie:cookie,...(method==='GET'?{}:{Origin:url,'X-CSRF-Token':csrfToken,'Content-Type':'application/json'}),...extra},body:data===undefined?undefined:JSON.stringify(data)});
  return {app,store,url,cookie,csrfToken,request,getRuns:()=>runs,...other};
}
test('HTTP state/export contain no secrets and data/filesystem are never web-served',async t=>{
  const {request}=await webFixture(t);
  for(const route of ['/api/state','/api/export']) { const response=await request(route);assert.equal(response.status,200);assert.equal((await response.text()).includes(SYNTHETIC),false); }
  assert.equal((await request('/data/vault.json')).status,404);
  assert.equal((await request('/api/reports/../../vault.json')).status,404);
});
test('HTTP rejects unauthenticated reads, wrong Host, cross-site and missing CSRF/origin writes',async t=>{
  const {url,request,cookie}=await webFixture(t);
  assert.equal((await fetch(url+'/api/state')).status,401);
  const hostileStatus = await new Promise((ok,fail)=>{ const req=http.request(url+'/api/state',{headers:{Host:'evil.example',Cookie:cookie}},res=>{res.resume();ok(res.statusCode);}); req.on('error',fail);req.end(); });
  assert.equal(hostileStatus,403);
  assert.equal((await request('/api/settings','POST',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(url+'/api/settings',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
});
test('manual detection requires paid-call confirmation and never triggers on saving settings',async t=>{
  const {request,getRuns}=await webFixture(t);
  assert.equal((await request('/api/settings','POST',{notifications:{enabled:false}})).status,200); assert.equal(getRuns(),0);
  assert.equal((await request('/api/run','POST',{})).status,400); assert.equal(getRuns(),0);
  assert.equal((await request('/api/run','POST',{confirmed:true})).status,202); assert.equal(getRuns(),1);
});
test('one-click scheduling requires legacy acknowledgment; mocked install does not run detector',async t=>{
  const {store,request,getRuns}=await webFixture(t); await store.edit(v=>{v.config.legacyMonitor.present=true;});
  assert.equal((await request('/api/schedule/enable','POST',{intervalHours:3,minute:59})).status,400);
  assert.equal((await request('/api/schedule/enable','POST',{intervalHours:3,minute:59,legacyAcknowledged:true})).status,200); assert.equal(getRuns(),0);
  assert.equal((await request('/api/schedule/disable','POST',{})).status,200);
});
