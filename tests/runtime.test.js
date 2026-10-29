'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const path='../src/Runtime.js',R=fs.existsSync(require('node:path').join(__dirname,path))?require(path):{};
const props=(seed={})=>{const values={...seed};return {values,getProperties:()=>({...values}),getProperty:k=>values[k]??null,setProperty(k,v){values[k]=v;return this;},deleteProperty(k){delete values[k];return this;}};};
test('migration preserves recovery state and never resurrects stale approvals on retry',()=>{
  const source=props({'GFM:pending':'{"stage":"CREATED"}','GFM:cleanup':'{"oldId":"x"}','GFM:importComplete':'{"count":108}','GFM:preview':'{}','GFM:prepared':'{}'}),target=props();
  R.migrate({source,target,bookId:'book'});
  assert.equal(target.values['GFM:pending'],source.values['GFM:pending']);assert.equal(target.values['GFM:cleanup'],source.values['GFM:cleanup']);assert.equal(target.values['GFM:importComplete'],source.values['GFM:importComplete']);
  assert.equal(target.getProperty('GFM:prepared'),null);assert.equal(target.getProperty('GFM:preview'),null);assert.equal(target.getProperty('GFM_SPREADSHEET_ID'),'book');
  target.deleteProperty('GFM:pending');R.migrate({source,target,bookId:'book'});assert.equal(target.getProperty('GFM:pending'),null);assert.ok(source.getProperty('GFM:pending'));
});
test('migration refuses conflicting state and another spreadsheet',()=>{
  const source=props({'GFM:pending':'{"a":1}'}),target=props({'GFM:pending':'{"a":2}'});
  assert.throws(()=>R.migrate({source,target,bookId:'book'}),/衝突/);assert.equal(target.getProperty('GFM_MIGRATED'),null);
  assert.throws(()=>R.migrate({source:props(),target:props({'GFM_SPREADSHEET_ID':'other'}),bookId:'book'}),/別の/);
});
test('runtime refuses non-owner and releases its shared lock on failure',()=>{
  let released=0,acquired=0;const d={book:{getOwner:()=>({getEmail:()=> 'owner@example.com'})},email:'other@example.com'};
  assert.throws(()=>R.create(d),/所有者/);
  const runtime=R.create({...d,email:'owner@example.com',props:props(),store:{},gmail:{},hash:x=>x,uuid:()=>'',lock:{tryLock(){acquired++;return true;},releaseLock(){released++;}}});
  assert.throws(()=>runtime.withLock(()=>{throw new Error('fault');}),/fault/);assert.equal(acquired,1);assert.equal(released,1);
});
test('lock contention has a safe machine-readable busy code',()=>{
 const runtime=R.create({book:{getOwner:()=>({getEmail:()=> 'owner@example.com'})},email:'owner@example.com',props:props(),store:{},gmail:{},hash:x=>x,uuid:()=>'',lock:{tryLock:()=>false,releaseLock(){throw Error('not acquired');}}});
 assert.throws(()=>runtime.withLock(()=>{}),e=>e.code==='GFM_BUSY');
});
