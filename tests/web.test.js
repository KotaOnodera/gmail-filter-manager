'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),C=require('../src/Core'),S=require('../src/Sync'),{harness,key,hash}=require('./helpers');
const W=fs.existsSync(path.join(__dirname,'../src/Web.js'))?require('../src/Web'):{};
function fixture(){const h=harness();h.deps.store.updateEditable=(k,p)=>Object.assign(h.rows.find(r=>r.RuleKey===k),p);h.deps.store.readHistory=(offset,limit)=>({items:h.history.slice().reverse().slice(offset,offset+limit),total:h.history.length});const d={...h.deps,bookId:'book',withLock:fn=>fn(),controller:S.create(h.deps),version:r=>hash(C.stable(C.config([r])))};return {...h,web:W.create(d)};}
test('web save is versioned, preserves tri-state/zero/literal and never mutates Gmail',()=>{
  const f=fixture(),before=f.web.dispatch('detail',{key});
  const result=f.web.dispatch('save',{key,version:before.version,patch:{NameOrNote:'=1+2',HasAttachment:'FALSE',SizeBytes:'0',SizeComparison:'larger'}});
  assert.equal(result.row.NameOrNote,'=1+2');assert.equal(result.row.HasAttachment,'FALSE');assert.equal(result.row.SizeBytes,'0');assert.equal(result.row.GmailFilterId,undefined);assert.equal(f.rows[0].GmailFilterId,'old');assert.equal(f.writes.length,0);
  assert.throws(()=>f.web.dispatch('save',{key,version:before.version,patch:{Subject:'lost edit'}}),/変更されています/);
  assert.throws(()=>f.web.dispatch('save',{key,version:result.version,patch:{GmailFilterId:'bad'}}),/編集できません/);
});
test('new filter save can be retried without duplicate rows',()=>{
  const f=fixture(),draft=f.web.dispatch('new',{}),input={key:draft.row.RuleKey,version:draft.version,patch:{Status:'有効',From:'new@example.com',Archive:'TRUE'}};
  f.web.dispatch('save',input);f.web.dispatch('save',input);assert.equal(f.rows.length,2);assert.equal(f.writes.length,0);
});
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
test('web import needs matching confirmation; list omits original system JSON',()=>{
  const f=fixture();const list=f.web.dispatch('list',{});assert.equal(list.total,1);assert.equal(list.items[0].OriginalJson,undefined);
  assert.throws(()=>f.web.dispatch('import',{token:'forged'}),/確認/);const c=f.web.dispatch('importCheck',{});assert.equal(f.web.dispatch('import',{token:c.token}).count,0);assert.equal(f.writes.length,0);
  assert.throws(()=>f.web.dispatch('unknown',{}),/操作/);
});
