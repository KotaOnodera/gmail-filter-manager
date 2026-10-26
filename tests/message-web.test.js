'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../src/Web'),M=require('../src/Messages'),Sheets=require('../src/Sheets'),{harness,hash}=require('./helpers'),{fakeSheets}=require('./fake-sheets');
function fixture(){
  const h=harness();h.tick(1700000000000);const f=fakeSheets(),store=Sheets.create({...f,hash,uuid:h.deps.uuid});store.setup();store.appendRows(h.rows);let writes=0;
  const d={...h.deps,store,bookId:'book',withLock:fn=>fn(),messageMaxSteps:1};d.gmail.listMessages=()=>({ids:['a','b'],nextPageToken:''});d.gmail.modifyMessages=()=>{writes++;};d.messages=M.create(d);
  return {d,h,web:()=>W.create(d),writes:()=>writes};
}
test('existing-message Web flow requires owner-bound server token and replays only the saved result',()=>{
  const f=fixture(),w=f.web();const list=w.dispatch('messagesList');assert.equal(list.entries.length,1);
  const run=w.dispatch('messagesStart',{keys:[f.h.key]});const ready=w.dispatch('messagesScan',{runId:run.runId});assert.equal(ready.total,2);assert.equal(f.writes(),0);
  assert.throws(()=>w.dispatch('messagesApply',{token:'forged',runId:run.runId}),/確認/);
  const p=w.dispatch('messagesPrepare',{runId:run.runId});assert.ok(p.token);assert.equal(p.entries[0].count,2);
  const done=w.dispatch('messagesApply',{token:p.token});assert.equal(done.status,'OK');assert.equal(f.writes(),1);
  assert.deepEqual(w.dispatch('messagesApply',{token:p.token}),done);assert.equal(f.writes(),1);
});
test('boot can restore message progress without Gmail, Filters or Backup reads',()=>{
  const f=fixture(),w=f.web(),run=w.dispatch('messagesStart',{keys:null});
  f.d.gmail.read=()=>{throw Error('No Gmail at startup');};f.d.store.readRows=()=>{throw Error('No Filters at startup');};f.d.store.readMessageData=()=>{throw Error('No Backup at startup');};
  const boot=f.web().dispatch('boot');assert.equal(boot.messageJob.runId,run.runId);assert.equal(boot.messageJob.status,'SCANNING');assert.equal(f.writes(),0);
});
test('message approval expires, belongs to actor/book and cannot advance another revision',()=>{
  const f=fixture(),w=f.web(),run=w.dispatch('messagesStart',{keys:null});w.dispatch('messagesScan',{runId:run.runId});const p=w.dispatch('messagesPrepare',{runId:run.runId});
  f.d.actor=()=> 'different@example.com';assert.throws(()=>f.web().dispatch('messagesApply',{token:p.token}),/確認/);f.d.actor=()=>'';
  f.h.tick(16*60*1000);assert.throws(()=>w.dispatch('messagesApply',{token:p.token}),/期限/);assert.equal(f.writes(),0);
});
test('a lost message response is recoverable after reload and old token cannot repeat another chunk',()=>{
  const f=fixture();f.d.messageBatchSize=1;f.d.messages=M.create(f.d);const w=f.web(),run=w.dispatch('messagesStart',{keys:null});w.dispatch('messagesScan',{runId:run.runId});
  const first=w.dispatch('messagesPrepare',{runId:run.runId});w.dispatch('messagesApply',{token:first.token});const partial=f.web().dispatch('messagesStatus',{runId:run.runId});assert.equal(partial.status,'PARTIAL');assert.equal(partial.completed,1);
  const second=w.dispatch('messagesPrepare',{runId:run.runId});w.dispatch('messagesApply',{token:second.token});assert.equal(f.writes(),2);assert.throws(()=>w.dispatch('messagesApply',{token:first.token}));assert.equal(f.writes(),2);
});
test('preparing and applying blob-backed definitions never reads unrelated historical message pages',()=>{
  const crypto=require('node:crypto'),C=require('../src/Core'),h=harness();h.tick(1700000000000);
  const f=fakeSheets(),store=Sheets.create({...f,hash,uuid:()=>crypto.randomUUID()});store.setup();
  const filter={id:'large',criteria:{subject:'s'.repeat(25000),query:'q'.repeat(25000)},action:{removeLabelIds:['INBOX']}};
  store.appendRows([C.importFilter(filter,h.data.labels,h.key)]);
  const d={...h.deps,store,messageMaxSteps:1};d.gmail.listMessages=()=>({ids:['match'],nextPageToken:''});d.gmail.modifyMessages=()=>{};
  const controller=M.create(d),run=controller.start(null);controller.scan(run.runId);
  const unrelated=[];for(let i=0;i<20;i++)unrelated.push(store.writeMessageData('older-run',{ids:Array.from({length:500},(_,j)=>'old-'+i+'-'+j)}).row);
  const backup=f.sheets.get('Backup'),getRange=backup.getRange.bind(backup);backup.getRange=(...args)=>{const r=getRange(...args),getValues=r.getValues.bind(r);r.getValues=()=>{assert.ok(!unrelated.some(row=>row>=args[0]&&row<args[0]+(args[2]||1)),'read unrelated MESSAGES rows: '+JSON.stringify(args));return getValues();};return r;};
  const ticket=controller.prepare(run.runId);assert.equal(controller.apply(ticket).status,'OK');
});
test('message progress is readable without the operation lock or Backup reads during a tracked request',()=>{
 const f=fixture(),w=f.web(),run=w.dispatch('messagesStart',{keys:null,_requestId:'start-1'});w.dispatch('messagesScan',{runId:run.runId,_requestId:'scan-1'});
 f.d.withLock=()=>{throw Error('operation still holds lock');};f.d.store.readMessageData=()=>{throw Error('No Backup reads');};
 const status=f.web().dispatch('resume',{requestId:'scan-1'});assert.equal(status.status,'DONE');assert.equal(status.runId,run.runId);assert.equal(status.messageJob.total,2);assert.equal(status.messageJob.status,'READY');assert.equal(f.writes(),0);
});
