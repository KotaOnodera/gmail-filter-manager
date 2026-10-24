'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const C=require('../src/Core.js');
const S=fs.existsSync(path.join(__dirname,'../src/Sync.js'))?require('../src/Sync.js'):{};
const {harness,key,labels,base}=require('./helpers');
function ready(h){const s=S.create(h.deps);s.preview();return {s,ticket:s.prepare()};}
test('T01/T02 import is read-only, backed up, idempotent and preserves edited rows',()=>{
  const h=harness({rows:[]});const s=S.create(h.deps);
  assert.equal(s.importAll(false).count,1);assert.equal(h.rows.length,0);
  s.importAll(true);assert.equal(h.rows.length,1);const originalKey=h.rows[0].RuleKey;
  h.rows[0].Subject='edited';s.importAll(true);
  assert.equal(h.rows.length,1);assert.equal(h.rows[0].RuleKey,originalKey);assert.equal(h.rows[0].Subject,'edited');
  assert.equal(h.writes.length,0);assert.ok(Object.keys(h.backups).length>=1);
});
test('T05/T06 dry run and unchanged apply never write Gmail',()=>{
  const h=harness();const {s,ticket}=ready(h);const result=s.apply(ticket,true);
  assert.equal(result.status,'OK');assert.equal(h.writes.length,0);assert.equal(s.verify().ok,true);
});
test('T07 create once and persist ID and verification',()=>{
  const h=harness({filters:[]});const {s,ticket}=ready(h);
  assert.equal(s.apply(ticket,true).status,'OK');assert.equal(h.writes.length,1);assert.ok(h.rows[0].GmailFilterId.startsWith('new-'));
  s.preview();assert.equal(s.apply(s.prepare(),true).status,'OK');assert.equal(h.writes.length,1);
});
test('T08 replace creates before deletion and records new ID/history',()=>{
  const h=harness();h.rows[0].Subject='changed';const {s,ticket}=ready(h);
  assert.equal(s.apply(ticket,true).status,'OK');assert.deepEqual(h.writes,[['create','new-1'],['delete','old']]);
  assert.equal(h.rows[0].GmailFilterId,'new-1');assert.ok(h.history.some(e=>e.newId==='new-1'&&e.oldId==='old'));
});
test('T09 disabled and deletion status keep rows and definitions after Gmail deletion',()=>{
  for(const status of ['無効','削除予定']) {
    const h=harness();h.rows[0].Status=status;const {s,ticket}=ready(h);
    assert.equal(s.apply(ticket,true).status,'OK');assert.equal(h.rows.length,1);assert.equal(h.rows[0].From,'sender@example.com');assert.equal(h.data.filters.length,0);assert.equal(h.rows[0].GmailFilterId,'');
  }
});
test('T10 no rows leaves remote-only rule untouched',()=>{
  const h=harness({rows:[]});const {s,ticket}=ready(h);assert.equal(ticket.summary.REMOTE_ONLY,1);
  s.apply(ticket,true);assert.equal(h.data.filters.length,1);assert.equal(h.writes.length,0);
});
test('T11 stale Filters, Gmail, labels, or forwarding abort before writes',()=>{
  const mutations=[h=>h.rows[0].Subject='changed',h=>h.data.filters[0].criteria.subject='remote',h=>h.data.labels[0].name='renamed',h=>h.data.forwarding=[]];
  for(const change of mutations){const h=harness();h.rows[0].Subject='local';const {s,ticket}=ready(h);change(h);assert.throws(()=>s.apply(ticket,true),/プレビュー|一致|変更/);assert.equal(h.writes.length,0);}
});
test('Diff display is never consumed as an execution plan',()=>{
  const h=harness();const {s,ticket}=ready(h);h.diffs[0].entries[0].operation='DELETE';
  s.apply(ticket,true);assert.equal(h.writes.length,0);
});
test('T12 any validation ERROR blocks whole apply',()=>{
  const h=harness();h.rows[0].ForwardTo='bad@example.com';const s=S.create(h.deps);
  assert.ok(s.preview().entries.some(e=>e.operation==='ERROR'));assert.throws(()=>s.prepare(),/エラー/);assert.equal(h.writes.length,0);
});
test('T13 backup failure stops before approval/write',()=>{
  const h=harness();h.rows[0].Subject='changed';const s=S.create(h.deps);s.preview();h.faults.backup=true;
  assert.throws(()=>s.prepare(),/backup/);assert.equal(h.writes.length,0);
});
test('T16 No leaves Gmail and Filters untouched and cannot be reused to approve different plan',()=>{
  const h=harness();h.rows[0].Subject='changed';const {s,ticket}=ready(h);const before=C.clone(h.rows);
  assert.equal(s.apply(ticket,false).status,'CANCELLED');assert.deepEqual(h.rows,before);assert.equal(h.writes.length,0);
  assert.throws(()=>s.apply(ticket,true),/プレビュー|承認/);
});
test('T17 risk counts cover forwarding and trash',()=>{
  const h=harness();h.rows[0].ForwardTo='dest@example.com';h.rows[0].MoveToTrash=true;const {ticket}=ready(h);
  assert.equal(ticket.summary.REPLACE,1);assert.equal(ticket.summary.FORWARD,1);assert.equal(ticket.summary.TRASH,1);
});
test('T15 failure deleting old after create resumes through fresh approved cleanup without creating twice',()=>{
  const h=harness();h.rows[0].Subject='changed';const {s,ticket}=ready(h);h.faults.delete=true;
  assert.equal(s.apply(ticket,true).status,'RECOVERY_REQUIRED');assert.equal(h.data.filters.length,2);
  const p=s.preview();assert.equal(p.entries.filter(e=>e.cleanup).length,1);
  assert.equal(s.apply(s.prepare(),true).status,'OK');assert.deepEqual(h.writes,[['create','new-1'],['delete','old']]);
});
test('lost create response is reconciled by backup and fingerprint without repeating write',()=>{
  const h=harness({filters:[]});const {s,ticket}=ready(h);h.faults.afterCreate=true;
  assert.equal(s.apply(ticket,true).status,'RECOVERY_REQUIRED');assert.equal(h.writes.length,1);
  s.preview();assert.equal(h.rows[0].GmailFilterId,'new-1');s.apply(s.prepare(),true);assert.equal(h.writes.length,1);
});
test('uncertain creation with no/ambiguous candidates blocks further writes',()=>{
  const h=harness({filters:[]});const {s,ticket}=ready(h);h.faults.create=true;
  s.apply(ticket,true);assert.throws(()=>s.preview(),/不明|復旧/);assert.equal(h.writes.length,0);
});
test('ID-save failure keeps durable journal and next preview adopts created ID',()=>{
  const h=harness({filters:[]});const {s,ticket}=ready(h);h.faults.updateRow=true;
  assert.equal(s.apply(ticket,true).status,'RECOVERY_REQUIRED');s.preview();assert.equal(h.rows[0].GmailFilterId,'new-1');assert.equal(h.writes.length,1);
});
test('lost delete response reconciles absent ID, preserves row and never repeats delete',()=>{
  const h=harness();h.rows[0].Status='無効';const {s,ticket}=ready(h);h.faults.afterDelete=true;
  s.apply(ticket,true);s.preview();s.apply(s.prepare(),true);assert.deepEqual(h.writes,[['delete','old']]);assert.equal(h.rows[0].GmailFilterId,'');
});
test('partial batch/time budget stops safely and needs a new preview',()=>{
  const rows=Array.from({length:3},(_,i)=>{const r=C.importFilter({...base(),id:'',criteria:{subject:String(i)}},labels,require('node:crypto').randomUUID());return r;});
  const h=harness({rows,filters:[]});h.deps.maxOperations=1;const {s,ticket}=ready(h);
  assert.equal(s.apply(ticket,true).status,'PARTIAL');assert.equal(h.writes.length,1);assert.throws(()=>s.apply(ticket,true),/プレビュー/);
  s.preview();assert.equal(s.apply(s.prepare(),true).status,'PARTIAL');assert.equal(h.writes.length,2);
});
test('execution budget expires before next API write',()=>{
  const h=harness({filters:[]});const {s,ticket}=ready(h);h.deps.maxMillis=1;
  const oldNotify=h.deps.notify;h.deps.notify=()=>{oldNotify();h.tick(2);};
  assert.equal(s.apply(ticket,true).status,'PARTIAL');assert.equal(h.writes.length,0);
});
test('backup readback mismatch invalidates preparation',()=>{
  const h=harness();const s=S.create(h.deps);s.preview();h.deps.store.readBackup=()=>({...h.data,filters:[]});
  assert.throws(()=>s.prepare(),/バックアップ/);assert.equal(h.writes.length,0);
});
test('equivalent ID adoption updates only system columns after approval',()=>{
  const h=harness();h.rows[0].GmailFilterId='';const {s,ticket}=ready(h);
  s.apply(ticket,true);assert.equal(h.rows[0].GmailFilterId,'old');assert.equal(h.writes.length,0);
});
