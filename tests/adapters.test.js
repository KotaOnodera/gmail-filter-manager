'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../src/Core.js');const {hash,base,labels,key}=require('./helpers');const {fakeSheets}=require('./fake-sheets');
const load=f=>fs.existsSync(path.join(__dirname,'../src/'+f+'.js'))?require('../src/'+f+'.js'):{};
const Sheets=load('Sheets'),GmailAdapter=load('Gmail'),Menu=load('Menu');
function env(){const f=fakeSheets();return {...f,store:Sheets.create({...f,hash,uuid:()=>crypto.randomUUID()})};}
test('setup creates exactly four schemas and is idempotent without data loss/protection duplicates',()=>{
  const e=env();e.store.setup();e.store.appendRows([C.importFilter(base(),labels,key)]);const before=C.clone(e.sheets.get('Filters').values);const n=e.sheets.get('Filters').protections.length;
  e.store.setup();assert.equal(e.sheets.size,4);assert.deepEqual(e.sheets.get('Filters').values,before);assert.equal(e.sheets.get('Filters').protections.length,n);
});
test('schema mismatch and formulas fail closed without erasing user data',()=>{
  const e=env();e.store.setup();e.sheets.get('Filters').values[0][0]='Renamed';
  assert.throws(()=>e.store.readRows(),/ヘッダー/);assert.throws(()=>e.store.setup(),/ヘッダー/);
  assert.equal(e.sheets.get('Filters').values[0][0],'Renamed');
  e.sheets.get('Filters').values[0][0]='RuleKey';e.store.appendRows([C.importFilter(base(),labels,key)]);
  e.sheets.get('Filters').formulas[1]=[];e.sheets.get('Filters').formulas[1][3]='=A1';assert.throws(()=>e.store.readRows(),/数式/);
});
test('T18 Sheets writes rich text literally including formulas, apostrophes, false and zero',()=>{
  const e=env();e.store.setup();const f={id:'f',criteria:{from:'=IMPORTXML("x")',subject:"'日本語",hasAttachment:false,size:0,sizeComparison:'larger'},action:{}};
  e.store.appendRows([C.importFilter(f,labels,key)]);const r=e.store.readRows()[0];assert.deepEqual(C.toFilter(r,{labels,forwarding:[]}).filter,{criteria:f.criteria,action:f.action});
  assert.equal(e.sheets.get('Filters').getRange(2,1,1,C.columns.length).getFormulas()[0].filter(Boolean).length,0);
});
test('RuleKey updates target sorted rows, not cached row positions, and reject ambiguous identity',()=>{
  const e=env();e.store.setup();const second=crypto.randomUUID();e.store.appendRows([C.importFilter(base(),labels,key),C.importFilter({...base(),id:'b'},labels,second)]);
  [e.sheets.get('Filters').values[1],e.sheets.get('Filters').values[2]]=[e.sheets.get('Filters').values[2],e.sheets.get('Filters').values[1]];
  e.store.updateRow(key,{GmailFilterId:'new'});assert.equal(e.store.readRows().find(r=>r.RuleKey===key).GmailFilterId,'new');
  e.sheets.get('Filters').values[1][0]=key;assert.throws(()=>e.store.updateRow(key,{Result:'x'}),/RuleKey/);
});
test('row anchors use unbounded row ranges and recover an import persisted before metadata failed',()=>{
  const e=env();e.store.setup();const sheet=e.sheets.get('Filters'),row=C.importFilter(base(),labels,key);
  // A failed import can leave the data row persisted without its row metadata.
  sheet.values.push(C.columns.map(k=>String(row[k]??'')));
  assert.throws(()=>sheet.getRange(2,1,1,sheet.getMaxColumns()).addDeveloperMetadata('GFM','bounded'),/arbitrary ranges/);
  e.store.appendRows([]);e.store.ensureKeys(()=>crypto.randomUUID());
  assert.equal(sheet.metadata.length,1);assert.equal(sheet.getLastRow(),2);
  e.store.updateRow(key,{Result:'recovered'});assert.equal(e.store.readRows()[0].Result,'recovered');
});
test('backup chunks >50000 characters, verifies hash, handles empty mailbox and preserves snapshots',()=>{
  const e=env();e.store.setup();const state={filters:[{...base(),criteria:{query:'x'.repeat(110000)}}],labels,forwarding:[]};
  const result=e.store.backup(state,'snap','now');assert.equal(result.count,1);assert.deepEqual(e.store.readBackup('snap'),state);
  const empty={filters:[],labels:[],forwarding:[]};e.store.backup(empty,'empty','now');assert.deepEqual(e.store.readBackup('empty'),empty);assert.deepEqual(e.store.readBackup('snap'),state);
  assert.ok(e.sheets.get('Backup').values.every(row=>row.every(v=>String(v).length<=40000)));
});
test('incomplete or tampered backup can never pass readback',()=>{
  const e=env();e.store.setup();e.store.backup({filters:[base()],labels,forwarding:[]},'s','now');
  const sheet=e.sheets.get('Backup');const original=C.clone(sheet.values);sheet.values.pop();assert.throws(()=>e.store.readBackup('s'),/完了|不完全/);
  sheet.values=original;const jsonIndex=Sheets.schemas.Backup.indexOf('Json');sheet.values[1][jsonIndex]='{}';assert.throws(()=>e.store.readBackup('s'),/ハッシュ|破損/);
});
test('large hidden original metadata is chunked without losing fields',()=>{
  const e=env();e.store.setup();const f={...base(),criteria:{from:'x',future:'z'.repeat(60000)}};
  e.store.appendRows([C.importFilter(f,labels,key)]);const r=e.store.readRows()[0];assert.equal(JSON.parse(r.OriginalJson).criteria.future.length,60000);
});
test('History only appends and Diff replacement never mutates Filters',()=>{
  const e=env();e.store.setup();e.store.appendRows([C.importFilter(base(),labels,key)]);const before=e.store.readRows();
  e.store.history({runId:'a',at:'2026-10-25T00:00:00Z',command:'X',result:'OK'});e.store.history({runId:'b',at:'2026-10-25T00:01:00Z',command:'Y',result:'ERROR'});
  e.store.writeDiff('run',C.plan(before,{filters:[base()],labels,forwarding:[]}));assert.equal(e.sheets.get('History').getLastRow(),3);assert.deepEqual(e.store.readRows(),before);
});
test('Gmail adapter lists complete arrays, read has no writes and delete uses Apps Script remove',()=>{
  const writes=[];const service={Users:{Settings:{Filters:{list:()=>({filter:[base()]}),create:(f,user)=>{writes.push(['create',user]);return {id:'new',...f};},remove:(user,id)=>writes.push(['remove',user,id])},ForwardingAddresses:{list:()=>({forwardingAddresses:[]})}},Labels:{list:()=>({labels})}}};
  const g=GmailAdapter.create(service);assert.equal(g.read().filters.length,1);assert.equal(writes.length,0);g.create(base());g.delete('old');assert.deepEqual(writes,[['create','me'],['remove','me','old']]);
  service.Users.Settings.Filters.list=()=>({nextPageToken:'unexpected'});assert.throws(()=>g.read(),/不完全|ページ/);
});
test('menu holds separate locks for prepare and apply, never across confirmation, double execution rejected',()=>{
  let locked=false;const events=[];const controller={prepare:()=>{assert.ok(locked);events.push('prepare');return {summary:{CREATE:1},runId:'r'};},apply:(t,yes)=>{assert.ok(locked);assert.ok(yes);events.push('apply');return {status:'OK',completed:1};}};
  const runner=Menu.create({controller,withLock(fn){assert.equal(locked,false);locked=true;try{return fn();}finally{locked=false;}},confirm:()=>{assert.equal(locked,false);events.push('confirm');return true;},notify:()=>{},show:()=>{}});
  runner.apply();assert.deepEqual(events,['prepare','confirm','apply']);
});
