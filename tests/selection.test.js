'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/Core'),S=require('../src/Sync'),{harness,key,base,labels}=require('./helpers');
const other='22222222-2222-4222-8222-222222222222';
function fixture(){const second={...base(),id:'other',criteria:{from:'other@example.com'}},h=harness({filters:[base(),second],rows:[C.importFilter(base(),labels,key),C.importFilter(second,labels,other)]});h.rows[0].Subject='one';h.rows[1].Subject='two';return {...h,sync:S.create(h.deps)};}
test('selected apply changes only chosen filter and reports unselected work as remaining',()=>{
  const f=fixture();f.sync.preview();const ticket=f.sync.prepare([key]);assert.equal(ticket.summary.REPLACE,1);assert.ok(ticket.selection);
  const result=f.sync.apply(ticket,true);assert.equal(result.status,'OK');assert.equal(result.remaining,1);assert.deepEqual(f.writes,[['create','new-1'],['delete','old']]);assert.equal(f.data.filters.find(x=>x.id==='other').criteria.subject,undefined);assert.equal(f.rows[1].GmailFilterId,'other');
});
test('unselected invalid inputs do not prevent a valid partial apply, but full apply rejects',()=>{
  const f=fixture();f.rows[1].Status='broken';f.sync.preview();assert.throws(()=>f.sync.prepare(),/入力エラー/);const ticket=f.sync.prepare([key]);assert.equal(f.sync.apply(ticket,true).status,'OK');assert.equal(f.rows[1].Status,'broken');
});
test('empty duplicate unknown or tampered selections are rejected before Gmail writes',()=>{
  const f=fixture();f.sync.preview();for(const keys of [[],[key,key],['unknown']])assert.throws(()=>f.sync.prepare(keys),/選択/);
  const t=f.sync.prepare([key]);f.scopes[t.snapshotId]=[other];assert.throws(()=>f.sync.apply(t,true),/選択/);assert.equal(f.writes.length,0);
});
test('unselected row edits still invalidate an approved partial apply',()=>{
  const f=fixture();f.sync.preview();const t=f.sync.prepare([key]);f.rows[1].NameOrNote='concurrent';assert.throws(()=>f.sync.apply(t,true),/変更されています/);assert.equal(f.writes.length,0);
});
test('unselected creates do not consume selected capacity',()=>{
  const filters=Array.from({length:999},(_,i)=>({id:'id-'+i,criteria:{from:'sender-'+i+'@example.com'},action:{}}));
  const rows=[{RuleKey:key,Status:'有効',From:'new-first@example.com'},{RuleKey:other,Status:'有効',From:'new-chosen@example.com'}];
  const h=harness({filters,rows}),sync=S.create(h.deps);sync.preview();const t=sync.prepare([other]);assert.equal(t.summary.CREATE,1);assert.equal(sync.apply(t,true).status,'OK');assert.equal(h.writes.length,1);assert.equal(h.rows[0].GmailFilterId,undefined);
});
test('partial apply cannot omit a pending cleanup before another replacement',()=>{
  const f=fixture();f.faults.delete=true;f.sync.preview();const r=f.sync.apply(f.sync.prepare(),true);assert.equal(r.status,'RECOVERY_REQUIRED');f.sync.preview();assert.throws(()=>f.sync.prepare([other]),/復旧|中断/);
});
test('a large selected set is stored outside the prepared property',()=>{
  const rows=Array.from({length:500},(_,i)=>({RuleKey:require('node:crypto').randomUUID(),Status:'無効',NameOrNote:String(i)}));const h=harness({filters:[],rows}),sync=S.create(h.deps);sync.preview();const t=sync.prepare(rows.map(r=>r.RuleKey));assert.ok(JSON.stringify(t).length<8000);assert.equal(h.scopes[t.snapshotId].length,500);
});
test('remaining includes an unselected ID link shown by the next preview',()=>{
  const f=fixture();f.rows[1].Subject='';f.rows[1].GmailFilterId='';f.sync.preview();const result=f.sync.apply(f.sync.prepare([key]),true);assert.equal(result.status,'OK');assert.equal(result.remaining,1);assert.equal(f.rows[1].GmailFilterId,'');
  const next=f.sync.preview();assert.equal(next.entries.find(e=>e.ruleKey===other).matchedId,'other');f.sync.apply(f.sync.prepare(),true);assert.equal(f.rows[1].GmailFilterId,'other');assert.equal(f.writes.length,2);
});
