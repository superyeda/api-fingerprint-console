import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { protectVault, unprotectVault, CredentialProtectionError } from './credentials.mjs';

const API_KEY='synthetic-credential-value';
const DEVICE_KEY='synthetic-device-key';
const vault={config:{endpoints:[]},secrets:{id:API_KEY},notificationSecrets:{barkDeviceKey:DEVICE_KEY}};
const CIPHER=Buffer.from('opaque fixture cipher data').toString('base64');
function mock(output,{exitCode=0,hang=false,split=false}={}) {
  const record={calls:0,input:null,args:null,killed:false};
  const spawnFn=(command,args,options)=>{
    record.calls++;record.command=command;record.args=args;record.options=options;
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();
    child.kill=()=>{record.killed=true;child.emit('close',1);};
    child.stdin.end=input=>{
      record.input=input;
      if(hang)return;
      queueMicrotask(()=>{ const data=Buffer.from(output);if(split){for(let i=0;i<data.length;i++)child.stdout.emit('data',data.subarray(i,i+1));}else child.stdout.emit('data',data);child.emit('close',exitCode); });
    };
    return child;
  };
  return {spawnFn,record};
}

test('POSIX keeps permission-protected private vault and never launches PowerShell',async()=>{
  let calls=0;const result=await protectVault(vault,{platform:'darwin',spawnFn:()=>{calls++;}});
  assert.deepEqual(result,vault);assert.equal(calls,0);assert.notEqual(result,vault);
});
test('Windows writes DPAPI ciphertext, not plaintext; credentials only pass over stdin, never argv',async()=>{
  const {spawnFn,record}=mock(CIPHER);
  const result=await protectVault(vault,{platform:'win32',spawnFn});
  assert.equal(result.protectedSecrets.kind,'windows-dpapi-current-user');assert.equal(result.protectedSecrets.payload,CIPHER);
  assert.equal('secrets' in result,false);assert.equal('notificationSecrets' in result,false);
  for(const value of [API_KEY,DEVICE_KEY]){assert.equal(JSON.stringify(result).includes(value),false);assert.equal(record.args.join(' ').includes(value),false);assert.ok(record.input.includes(value));}
  assert.equal(record.options.shell,false);assert.equal(record.options.windowsHide,true);assert.ok(record.args.includes('-EncodedCommand'));assert.equal(record.calls,1);
});
test('Windows decrypts in memory, supports split Unicode and never returns protected blob as API Key',async()=>{
  const value={...vault,secrets:{id:'合成测试值-not-real'}};
  const {spawnFn,record}=mock(JSON.stringify({secrets:value.secrets,notificationSecrets:value.notificationSecrets}),{split:true});
  const result=await unprotectVault({config:value.config,protectedSecrets:{kind:'windows-dpapi-current-user',payload:CIPHER}},{platform:'win32',spawnFn});
  assert.equal(result.secrets.id,value.secrets.id);assert.equal(record.input,CIPHER);assert.equal('protectedSecrets' in result,false);
});
test('wrong platform/protection type fails closed without attempting a child',async()=>{
  let calls=0;const spawnFn=()=>{calls++;};
  await assert.rejects(unprotectVault({protectedSecrets:{kind:'windows-dpapi-current-user',payload:CIPHER}},{platform:'darwin',spawnFn}),CredentialProtectionError);
  await assert.rejects(unprotectVault({protectedSecrets:{kind:'other',payload:CIPHER}},{platform:'win32',spawnFn}),CredentialProtectionError);
  assert.equal(calls,0);
});
test('nonzero child, invalid cipher, malformed plaintext and startup failures never echo raw secret values',async()=>{
  for(const [output,exitCode] of [[API_KEY,1],['not valid base64!',0]]){
    const {spawnFn}=mock(output,{exitCode});
    await assert.rejects(protectVault(vault,{platform:'win32',spawnFn}),e=>e instanceof CredentialProtectionError&&!e.message.includes(API_KEY));
  }
  const {spawnFn}=mock('not JSON '+API_KEY);
  await assert.rejects(unprotectVault({config:{},protectedSecrets:{kind:'windows-dpapi-current-user',payload:CIPHER}},{platform:'win32',spawnFn}),CredentialProtectionError);
  await assert.rejects(protectVault(vault,{platform:'win32',spawnFn:()=>{throw Error(API_KEY);}}),e=>!e.message.includes(API_KEY));
});
test('hanging protection process is killed once with no retries',async()=>{
  const {spawnFn,record}=mock('',{hang:true});
  await assert.rejects(protectVault(vault,{platform:'win32',spawnFn,timeoutMs:5}),CredentialProtectionError);
  assert.equal(record.killed,true);assert.equal(record.calls,1);
});
