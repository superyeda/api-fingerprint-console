import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDataDir,platformInfo,pythonExecutable} from './platform.mjs';

test('platform data directories use Application Support, LocalAppData or explicit Linux fallback',()=>{
  assert.equal(defaultDataDir({platform:'darwin',home:'/Users/test',env:{}}),'/Users/test/Library/Application Support/API Fingerprint Console/data');
  assert.equal(defaultDataDir({platform:'win32',home:'C:\\Users\\test',env:{LOCALAPPDATA:'D:\\Local Apps'}}),'D:\\Local Apps\\API Fingerprint Console\\data');
  assert.equal(defaultDataDir({platform:'win32',home:'C:\\Users\\test',env:{}}),'C:\\Users\\test\\AppData\\Local\\API Fingerprint Console\\data');
  assert.equal(defaultDataDir({platform:'linux',home:'/home/test',env:{}}),'/home/test/.local/share/API Fingerprint Console/data');
});
test('platform metadata identifies Windows mock validation boundary and unsupported Linux scheduling',()=>{
  const windows=platformInfo({platform:'win32'});assert.equal(windows.scheduler,'任务计划程序');assert.match(windows.windowsValidation,/未进行实机验收/);assert.match(windows.secretsProtection,/DPAPI/);
  assert.equal(platformInfo({platform:'darwin'}).scheduler,'launchd');assert.equal(platformInfo({platform:'linux'}).nativeSchedulingSupported,false);
});
test('launcher-provided absolute Python path needs no discovery process on either platform',async()=>{
  let calls=0;const execFile=()=>{calls++;throw Error('must not execute');};
  assert.equal(await pythonExecutable({platform:'win32',env:{PYTHON_EXECUTABLE:'C:\\Python312\\python.exe'},execFile}),'C:\\Python312\\python.exe');
  assert.equal(await pythonExecutable({platform:'darwin',env:{PYTHON_EXECUTABLE:'/usr/bin/python3'},execFile}),'/usr/bin/python3');assert.equal(calls,0);
});
test('relative/traversal/control-character Python overrides are rejected without echo or discovery',async()=>{
  for(const value of ['python.exe','C:\\Python\\..\\python.exe','C:\\Python\\bad\nname.exe']){
    let calls=0;await assert.rejects(pythonExecutable({platform:'win32',env:{PYTHON_EXECUTABLE:value},execFile:()=>{calls++;}}),e=>!e.message.includes(value));assert.equal(calls,0);
  }
});
test('Windows fixed py query discovers actual absolute executable with argument-array safety',async()=>{
  const captures=[];
  const path=await pythonExecutable({platform:'win32',env:{},execFile:(file,args,options,done)=>{captures.push({file,args,options});done(null,'C:\\Users\\测试\\Python\\python.exe\r\n');return {kill(){}};}});
  assert.equal(path,'C:\\Users\\测试\\Python\\python.exe');assert.equal(captures.length,1);assert.equal(captures[0].file,'py.exe');assert.equal(captures[0].options.shell,false);assert.deepEqual(captures[0].args,['-3','-c','import sys; print(sys.executable)']);
});
test('Windows discovery failures are safe, bounded candidates with no original errors returned',async()=>{
  let calls=0;await assert.rejects(pythonExecutable({platform:'win32',env:{},execFile:(_file,_args,_options,done)=>{calls++;done(Error('private original failure'));return {kill(){}};}}),e=>!e.message.includes('private original failure'));assert.equal(calls,2);
});
