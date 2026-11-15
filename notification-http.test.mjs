import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultNotifications, normalizeNotifications, publicNotifications, updateNotifications, notificationRequest, exportedNotifications, NotificationConfigError } from './notification-config.mjs';
import { sendNotification, sendHttpNotification, TEST_NOTIFICATION_MESSAGE } from './notify.mjs';

const BARK = 'synthetic-bark-device-key';
const HOOK = 'https://hooks.offline.invalid/private-path?token=synthetic-query-token';
const TOKEN = 'synthetic-webhook-bearer';
function bark(enabled=true) { return { ...defaultNotifications(), enabled }; }
function webhook(format='json') { return { ...defaultNotifications(), enabled:true, channel:'webhook', webhook:{format} }; }
function fakeFetch(reply, captures=[]) { return async(url,options)=>{ captures.push({url,options}); return reply(); }; }
const okBark=()=>new Response(JSON.stringify({code:200,message:'success'}),{status:200,headers:{'Content-Type':'application/json'}});

test('fresh notification setup is portable Bark disabled; v1 local command preserves behavior',()=>{
  assert.equal(defaultNotifications().channel,'bark'); assert.equal(defaultNotifications().enabled,false);
  assert.equal(normalizeNotifications({enabled:true}).channel,'local_command');
  assert.equal(normalizeNotifications({enabled:true}).enabled,true);
});
test('public notification state/export expose only credential-presence flags, never URLs/tokens',()=>{
  const {config,secrets}=updateNotifications(defaultNotifications(),{channel:'webhook',enabled:true,credentials:{webhookUrl:HOOK,webhookToken:TOKEN,barkDeviceKey:BARK}},{});
  const exposed=publicNotifications(config,secrets); const exported=exportedNotifications(exposed);
  for(const v of [exposed,exported]) for(const s of [BARK,HOOK,TOKEN]) assert.equal(JSON.stringify(v).includes(s),false);
  assert.equal(exposed.hasWebhookUrl,true); assert.equal(exposed.hasBarkKey,true); assert.equal(exported.enabled,false); assert.equal('hasWebhookUrl' in exported,false);
});
test('blank fields preserve credentials; clear is explicit and invalid field names rejected',()=>{
  const previous={webhookUrl:HOOK,webhookToken:TOKEN,barkDeviceKey:BARK};
  let n=updateNotifications(webhook(),{credentials:{webhookUrl:'',webhookToken:''}},previous);
  assert.deepEqual(n.secrets,previous);
  n=updateNotifications(webhook(),{enabled:false,clearSecrets:['webhookUrl','webhookToken']},previous);
  assert.equal(n.secrets.webhookUrl,undefined); assert.equal(n.secrets.barkDeviceKey,BARK);
  assert.throws(()=>updateNotifications(bark(),{clearSecrets:['__proto__']},{}),NotificationConfigError);
});
test('Bark origin and device Key are deliberately separate; full push URL cannot enter public server field',()=>{
  for(const url of ['https://api.day.app/ACTUAL_KEY','https://api.day.app/push','https://user:password@api.day.app','https://api.day.app?token=secret']) assert.throws(()=>updateNotifications(defaultNotifications(),{bark:{serverUrl:url}},{}),NotificationConfigError);
  assert.throws(()=>updateNotifications(defaultNotifications(),{credentials:{barkDeviceKey:'https://api.day.app/key'}},{}),NotificationConfigError);
  const n=updateNotifications(defaultNotifications(),{enabled:true,credentials:{barkDeviceKey:BARK}},{});
  const req=notificationRequest(n.config,n.secrets,TEST_NOTIFICATION_MESSAGE);
  assert.equal(req.url,'https://api.day.app/push'); assert.equal(req.payload.device_key,BARK);
  assert.equal(req.url.includes(BARK),false); assert.equal(req.headers.Authorization,undefined);
});
test('HTTP requires explicit insecure consent; invalid schemes/auth fragments and header injections fail closed',()=>{
  assert.throws(()=>updateNotifications(defaultNotifications(),{bark:{serverUrl:'http://localhost:8000'}},{}),NotificationConfigError);
  const n=updateNotifications(defaultNotifications(),{allowInsecure:true,bark:{serverUrl:'http://localhost:8000'}},{});
  assert.equal(n.config.allowInsecure,true);
  for(const url of ['file:///secret','javascript:alert(1)','https://u:p@offline.invalid/path','https://offline.invalid/#secret']) assert.throws(()=>updateNotifications(webhook(),{credentials:{webhookUrl:url}},{}),NotificationConfigError);
  assert.throws(()=>updateNotifications(webhook(),{credentials:{webhookUrl:HOOK,webhookToken:'bad\r\nHeader:value'}},{}),NotificationConfigError);
});
test('enabled selected channel needs its own credential; another channel never supplies fallback credentials',()=>{
  assert.throws(()=>updateNotifications(defaultNotifications(),{enabled:true},{webhookUrl:HOOK}),NotificationConfigError);
  assert.throws(()=>updateNotifications(defaultNotifications(),{enabled:true,channel:'webhook'},{barkDeviceKey:BARK}),NotificationConfigError);
});
test('Bark POST sends JSON device_key, no model Key, cookies, redirect following, or external command',async()=>{
  const captures=[];
  const result=await sendNotification({}, {config:bark(),secrets:{barkDeviceKey:BARK},message:TEST_NOTIFICATION_MESSAGE,fetchFn:fakeFetch(okBark,captures),spawnFn:()=>{throw Error('not allowed');}});
  assert.equal(result.status,'accepted'); assert.equal(captures.length,1);
  const req=captures[0]; assert.equal(req.url,'https://api.day.app/push'); assert.equal(req.options.method,'POST'); assert.equal(req.options.redirect,'manual'); assert.equal(req.options.credentials,'omit');
  assert.equal(JSON.parse(req.options.body).device_key,BARK); assert.equal(JSON.parse(req.options.body).body,TEST_NOTIFICATION_MESSAGE.body);
});
test('webhook URL and bearer are used only in backend request; each common payload format is correct',async()=>{
  for(const format of ['json','slack','wecom','dingtalk']) {
    const captures=[];
    const reply=['wecom','dingtalk'].includes(format)?()=>new Response('{"errcode":0}',{status:200}):()=>new Response('ok',{status:200});
    const result=await sendNotification({}, {config:webhook(format),secrets:{webhookUrl:HOOK,webhookToken:TOKEN},message:TEST_NOTIFICATION_MESSAGE,fetchFn:fakeFetch(reply,captures)});
    assert.equal(result.status,'accepted'); assert.equal(captures[0].url,HOOK); assert.equal(captures[0].options.headers.Authorization,'Bearer '+TOKEN);
    const payload=JSON.parse(captures[0].options.body);
    if(format==='json') assert.equal(payload.event,'api_fingerprint');
    else if(format==='slack') assert.match(payload.text,/通知配置测试/);
    else {assert.equal(payload.msgtype,'text');assert.match(payload.text.content,/未调用模型/);}
    for(const s of [HOOK,TOKEN]) assert.equal(JSON.stringify(result).includes(s),false);
  }
});
test('disabled automatic notifications never send, explicit test can send saved config without model call',async()=>{
  let calls=0; const fetchFn=async()=>{calls++;return okBark();};
  assert.equal((await sendNotification({}, {config:bark(false),secrets:{barkDeviceKey:BARK},fetchFn})).status,'disabled'); assert.equal(calls,0);
  assert.equal((await sendNotification({}, {config:bark(false),secrets:{barkDeviceKey:BARK},fetchFn,test:true,message:TEST_NOTIFICATION_MESSAGE})).status,'accepted'); assert.equal(calls,1);
});
test('missing config, authentication, redirects, remote rejection, invalid JSON and network failures are bounded safe statuses',async()=>{
  const cases=[
    [()=>new Response('secret '+BARK,{status:401}),'authentication'],
    [()=>new Response('',{status:302,headers:{Location:'https://attacker.invalid/'+BARK}}),'redirect_blocked'],
    [()=>new Response(JSON.stringify({code:500,message:BARK}),{status:200}),'remote_rejected'],
    [()=>new Response('<html>'+BARK+'</html>',{status:200}),'invalid_response'],
    [()=>{throw Error('TLS or network '+BARK);},'network'],
  ];
  for(const [reply,reason] of cases){ const calls=[];const r=await sendNotification({}, {config:bark(),secrets:{barkDeviceKey:BARK},fetchFn:fakeFetch(reply,calls)});assert.equal(r.status,'failed');assert.equal(r.reasonCode,reason);assert.equal(calls.length,1);assert.equal(JSON.stringify(r).includes(BARK),false); }
  let requests=0; const r=await sendNotification({}, {config:bark(),secrets:{},fetchFn:()=>{requests++;}}); assert.equal(r.status,'unavailable');assert.equal(requests,0);
});
test('HTTP timeout aborts one request with no retries even if mock fetch ignores abort',async()=>{
  let calls=0;let signal;
  const r=await sendNotification({}, {config:bark(),secrets:{barkDeviceKey:BARK},timeoutMs:5,fetchFn:async(_url,options)=>{calls++;signal=options.signal;return new Promise(()=>{});}});
  assert.equal(r.status,'failed'); assert.equal(r.reasonCode,'timeout'); assert.equal(signal.aborted,true); assert.equal(calls,1);
});
test('oversized Bark response is rejected without exposing echoed device Key',async()=>{
  const r=await sendNotification({}, {config:bark(),secrets:{barkDeviceKey:BARK},fetchFn:async()=>new Response(JSON.stringify({code:200,message:BARK+'a'.repeat(17000)}),{status:200})});
  assert.equal(r.status,'failed'); assert.equal(r.reasonCode,'invalid_response'); assert.equal(JSON.stringify(r).includes(BARK),false);
});
test('legacy compatibility channel does not pretend to work on Windows',async()=>{
  const r=await sendNotification({}, {config:{enabled:true,channel:'local_command'},platform:'win32',spawnFn:()=>{throw Error('must not spawn');}});
  assert.equal(r.status,'unavailable'); assert.equal(r.reasonCode,'unsupported_platform');
});
