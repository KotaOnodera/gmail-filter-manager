'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),C=require('../src/Core'),S=require('../src/Sync'),{harness,key,hash}=require('./helpers');
const W=fs.existsSync(path.join(__dirname,'../src/Web.js'))?require('../src/Web'):{};
function fixture(){const h=harness();h.deps.store.updateEditable=(k,p)=>Object.assign(h.rows.find(r=>r.RuleKey===k),p);h.deps.store.readHistory=(offset,limit)=>({items:h.history.slice().reverse().slice(offset,offset+limit),total:h.history.length});const d={...h.deps,bookId:'book',withLock:fn=>fn(),controller:S.create(h.deps),version:r=>hash(C.stable(C.config([r])))};return {...h,web:W.create(d)};}
test('web requires server approval token, rejects stale state and consumes one successful apply',()=>{
  const f=fixture();f.rows[0].Subject='changed';const pv=f.web.dispatch('preview',{});const prepared=f.web.dispatch('prepare',{runId:pv.runId});
  assert.ok(prepared.token);assert.equal(f.writes.length,0);
  assert.throws(()=>f.web.dispatch('apply',{token:'forged',approved:true}),/確認/);
  f.rows[0].Subject='newer';assert.throws(()=>f.web.dispatch('apply',{token:prepared.token}),/変更されています/);assert.equal(f.writes.length,0);
  const pv2=f.web.dispatch('preview',{});const next=f.web.dispatch('prepare',{runId:pv2.runId}),result=f.web.dispatch('apply',{token:next.token});assert.equal(result.status,'OK');assert.equal(f.writes.length,2);
  const repeated=f.web.dispatch('apply',{token:next.token});assert.equal(repeated.status,'OK');assert.equal(f.writes.length,2);
});
test('expired web confirmation cannot apply',()=>{
  const f=fixture();f.rows[0].Subject='changed';const pv=f.web.dispatch('preview',{});const p=f.web.dispatch('prepare',{runId:pv.runId});f.tick(16*60*1000);assert.throws(()=>f.web.dispatch('apply',{token:p.token}),/期限/);assert.equal(f.writes.length,0);
});
test('another preview cannot be prepared using an older displayed RunId',()=>{const f=fixture(),pv=f.web.dispatch('preview',{});f.web.dispatch('preview',{});assert.throws(()=>f.web.dispatch('prepare',{runId:pv.runId}),/再確認/);});
test('web import needs matching confirmation',()=>{
  const f=fixture();
  assert.throws(()=>f.web.dispatch('import',{token:'forged'}),/確認/);const c=f.web.dispatch('importCheck',{});assert.equal(f.web.dispatch('import',{token:c.token}).count,0);assert.equal(f.writes.length,0);
  assert.throws(()=>f.web.dispatch('unknown',{}),/操作/);
});
test('unacknowledged apply result survives reload and can be read by its RunId without another mutation',()=>{
  const f=fixture();f.rows[0].Subject='updated';const pv=f.web.dispatch('preview',{}),p=f.web.dispatch('prepare',{runId:pv.runId});const result=f.web.dispatch('apply',{token:p.token});
  assert.equal(f.web.dispatch('boot',{}).unseenOutcome.runId,p.runId);assert.deepEqual(f.web.dispatch('outcome',{runId:p.runId}),result);assert.equal(f.writes.length,2);
  assert.throws(()=>f.web.dispatch('outcome',{runId:'unrelated'}),/見つかりません/);
  f.web.dispatch('acknowledgeOutcome',{runId:p.runId});assert.equal(f.web.dispatch('boot',{}).unseenOutcome,null);assert.equal(f.writes.length,2);
});

test('boot and history remain available without Gmail or Filters reads',()=>{
  const f=fixture();f.deps.gmail.read=()=>{throw Error('Gmail must not be read on startup');};f.deps.store.readRows=()=>{throw Error('Filters must not be read on startup');};
  assert.equal(f.web.dispatch('boot',{}).unseenOutcome,null);assert.equal(f.web.dispatch('history',{}).items.length,0);assert.equal(f.writes.length,0);
});
test('removed Web editing and listing commands are rejected without mutations',()=>{
  const f=fixture();for(const action of ['new','save','detail','list'])assert.throws(()=>f.web.dispatch(action,{key}),/対応していない操作/);assert.equal(f.rows.length,1);assert.equal(f.writes.length,0);
});
test('Web preparation returns only the server-validated selected entries',()=>{
  const f=fixture(),other='22222222-2222-4222-8222-222222222222';const second={id:'other',criteria:{from:'other@example.com'},action:{}};f.data.filters.push(second);f.rows.push(C.importFilter(second,f.data.labels,other));f.rows[0].Subject='one';f.rows[1].Subject='two';
  const pv=f.web.dispatch('preview',{}),p=f.web.dispatch('prepare',{runId:pv.runId,keys:[key]});assert.equal(p.summary.REPLACE,1);assert.deepEqual(p.entries.map(e=>e.ruleKey),[key]);
  const result=f.web.dispatch('apply',{token:p.token,keys:[key,other]});assert.equal(result.status,'OK');assert.equal(result.remaining,1);assert.equal(f.writes.length,2);
});
test('Web import confirmation includes the number of new labels',()=>{
 const f=fixture(),check=f.web.dispatch('importCheck');assert.equal(check.labelCount,1);assert.equal(check.labelTotal,1);const imported=f.web.dispatch('import',{token:check.token});assert.equal(imported.labelCount,1);assert.equal(f.labelRows.length,1);
});
test('label dependency shown at Web confirmation is applied exactly once through the shared token',()=>{
 const f=fixture(),lk='22222222-2222-4222-8222-222222222222';f.rows[0].UserLabel='請求書';f.labelRows.push({LabelKey:lk,Name:'請求書',GmailLabelId:''});
 const pv=f.web.dispatch('preview'),p=f.web.dispatch('prepare',{runId:pv.runId,keys:[key]});assert.equal(p.entries.filter(e=>e.kind==='LABEL').length,1);assert.equal(p.selection.count,2);
 assert.equal(f.web.dispatch('apply',{token:p.token}).status,'OK');const n=f.writes.length;f.web.dispatch('apply',{token:p.token});assert.equal(f.writes.length,n);
});
