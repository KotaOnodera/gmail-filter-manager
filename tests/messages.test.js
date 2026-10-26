'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../src/Core'),{harness,key,labels}=require('./helpers');
// Keep the suite runnable before the module exists so RED names the missing contract.
const M=(()=>{try{return require('../src/Messages');}catch(e){if(e.code==='MODULE_NOT_FOUND')return {};throw e;}})();
const key2='22222222-2222-4222-8222-222222222222';
function fixture(options={}) {
  const filters=options.filters||[{id:'f1',criteria:{from:'sender@example.com',query:'is:unread'},action:{addLabelIds:['Label_1','STARRED','TRASH'],removeLabelIds:['INBOX','UNREAD','SPAM'],forward:'dest@example.com'}}];
  const h=harness({filters,rows:filters.map((f,i)=>C.importFilter(f,labels,i?key2:key))});
  const blobs=new Map(),calls=[],messages=new Map([['a',new Set(['INBOX','UNREAD','Label_other'])],['b',new Set(['INBOX','UNREAD'])],['c',new Set(['INBOX','UNREAD'])],['unmatched',new Set(['INBOX','UNREAD'])]]);
  h.deps.store.writeMessageData=(runId,value)=>{if(h.faults.save)throw Error('save failed');const id='data-'+blobs.size;blobs.set(id,C.clone(value));return {id,runId};};
  h.deps.store.readMessageData=p=>{if(!blobs.has(p.id))throw Error('missing');return C.clone(blobs.get(p.id));};
  h.deps.gmail.listMessages=(query,token)=>{calls.push(['search',query,token]);if(h.faults.search)throw Error('search failed');return token?{ids:['c'],nextPageToken:''}:{ids:['a','b'],nextPageToken:'page2'};};
  h.deps.gmail.modifyMessages=(ids,action)=>{calls.push(['modify',C.clone(ids),C.clone(action)]);if(h.faults.beforeModify)throw Error('API failed');ids.forEach(id=>{action.addLabelIds.forEach(l=>messages.get(id).add(l));action.removeLabelIds.forEach(l=>messages.get(id).delete(l));});if(h.faults.afterModify){delete h.faults.afterModify;throw Error('response lost');}};
  h.deps.now=()=>1700000000000;h.deps.messageMaxSteps=options.steps||1;h.deps.messageBatchSize=options.batchSize||1;
  const controller=()=>M.create(h.deps);
  const scan=run=>{let s;do{s=controller().scan(run.runId);}while(s.status==='SCANNING');return s;};
  const finish=run=>{let s;do{const t=controller().prepare(run.runId);s=controller().apply(t);}while(s.status==='PARTIAL');return s;};
  return {...h,blobs,calls,messages,controller,scan,finish};
}
test('criteria compile to scoped Gmail queries without leaking OR or negated expressions',()=>{
  assert.equal(typeof M.query,'function');
  assert.equal(M.query({from:'sender@example.com',to:'team@example.com',subject:'  monthly   report ',query:'is:unread OR label:work',negatedQuery:'older_than:1y OR has:attachment',hasAttachment:true,excludeChats:true,size:100,sizeComparison:'larger'},1700000000),
    'from:(sender@example.com) {to:(team@example.com) cc:(team@example.com) bcc:(team@example.com)} subject:"monthly report" (is:unread OR label:work) -(older_than:1y OR has:attachment) has:attachment -is:chat larger:100 before:1700000000 -in:spam -in:trash -in:drafts -in:sent');
  for(const criteria of [{query:'x) OR from:other@example.com'},{from:'a) OR (b'},{subject:'a" OR b'},{query:'"unterminated'},{future:true},{}])assert.throws(()=>M.query(criteria,1700000000));
  assert.equal(M.query({hasAttachment:false,query:'from:a@example.com',excludeChats:false,size:0,sizeComparison:'unspecified'},1700000000),'(from:a@example.com) before:1700000000 -in:spam -in:trash -in:drafts -in:sent');
});
test('only selected enabled definitions produce saved message work and three allowed actions',()=>{
  assert.equal(typeof M.create,'function');const f=fixture({filters:[{id:'f1',criteria:{from:'sender@example.com'},action:{addLabelIds:['Label_1','STARRED','TRASH'],removeLabelIds:['INBOX','UNREAD','SPAM'],forward:'dest@example.com'}},{id:'f2',criteria:{subject:'other'},action:{removeLabelIds:['INBOX']}}]});
  const list=f.controller().list();assert.equal(list.entries.length,2);assert.deepEqual(list.entries[0].action,{addLabelIds:['Label_1'],removeLabelIds:['INBOX','UNREAD']});assert.equal(list.entries[0].ignored.length,4);
  const run=f.controller().start([key]);assert.equal(run.status,'SCANNING');assert.equal(f.calls.length,0);
  const ready=f.scan(run);assert.equal(ready.status,'READY');assert.equal(ready.total,3);assert.equal(ready.entries.length,1);assert.equal(ready.entries[0].count,3);assert.equal(f.calls.filter(c=>c[0]==='modify').length,0);
  assert.equal(f.finish(run).status,'OK');assert.deepEqual([...f.messages.get('a')].sort(),['Label_1','Label_other']);assert.deepEqual([...f.messages.get('unmatched')],['INBOX','UNREAD']);
  assert.ok(f.calls.filter(c=>c[0]==='search').every(c=>c[1].includes('sender@example.com')));assert.equal(f.writes.length,0);
});
test('empty, unknown, duplicate, disabled and invalid selections cannot modify messages',()=>{
  const f=fixture();for(const keys of [[],['unknown'],[key,key]])assert.throws(()=>f.controller().start(keys));
  f.rows[0].Status='無効';assert.equal(f.controller().list().entries.length,0);assert.throws(()=>f.controller().start([key]));
  f.rows[0].Status='有効';f.rows[0].Query='bad) OR (all';assert.throws(()=>f.controller().start([key]));assert.equal(f.calls.length,0);
});
test('search is completed before mutation and saved IDs survive unread/label-dependent pagination',()=>{
  const f=fixture();const run=f.controller().start(null);assert.throws(()=>f.controller().prepare(run.runId));
  assert.equal(f.controller().scan(run.runId).status,'SCANNING');assert.throws(()=>f.controller().prepare(run.runId));
  f.scan(run);const result=f.finish(run);assert.equal(result.completed,3);assert.equal(result.remaining,0);assert.equal(f.calls.filter(c=>c[0]==='search').length,2);assert.equal(f.history.at(-1).command,'MESSAGES');assert.equal(f.history.at(-1).result,'OK');
  const before=[...f.messages.get('a')];const run2=f.controller().start([key]);f.scan(run2);f.finish(run2);assert.deepEqual([...f.messages.get('a')],before);
});
test('lost modify response retains uncertain batch and explicit idempotent retry resumes saved IDs',()=>{
  const f=fixture();const run=f.controller().start(null);f.scan(run);f.faults.afterModify=true;
  const ticket=f.controller().prepare(run.runId);const failed=f.controller().apply(ticket);assert.equal(failed.status,'FAILED');assert.equal(failed.uncertain,1);assert.equal(failed.completed,0);assert.equal(failed.remaining,3);assert.match(failed.error,/response lost/);
  assert.throws(()=>f.controller().apply(ticket));const restored=f.controller().status(run.runId);assert.equal(restored.uncertain,1);
  const done=f.finish(run);assert.equal(done.status,'OK');assert.equal(done.completed,3);assert.equal(done.uncertain,0);assert.equal(f.calls.filter(c=>c[0]==='search').length,2);
});
test('changed definitions, expired/replayed tickets and persistence failures stop before writes',()=>{
  const f=fixture();const run=f.controller().start(null);f.scan(run);const ticket=f.controller().prepare(run.runId);
  f.rows[0].Subject='changed';assert.throws(()=>f.controller().apply(ticket));assert.equal(f.calls.filter(c=>c[0]==='modify').length,0);f.rows[0].Subject='';
  const expired=f.controller().prepare(run.runId);f.deps.now=()=>1700001000000;assert.throws(()=>f.controller().apply(expired));f.deps.now=()=>1700000000000;
  const valid=f.controller().prepare(run.runId);f.faults['state:messageJob']=true;assert.throws(()=>f.controller().apply(valid));assert.equal(f.calls.filter(c=>c[0]==='modify').length,0);
});
test('failed search can resume and cancellation preserves completed and unprocessed counts',()=>{
  const f=fixture();const run=f.controller().start(null);assert.throws(()=>f.controller().start(null));f.faults.search=true;assert.equal(f.controller().scan(run.runId).status,'SCAN_FAILED');delete f.faults.search;f.scan(run);f.controller().apply(f.controller().prepare(run.runId));
  const cancelled=f.controller().cancel(run.runId);assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.completed,1);assert.equal(cancelled.remaining,2);assert.throws(()=>f.controller().prepare(run.runId));assert.equal(f.controller().start(null).status,'SCANNING');
});
for(const [name,action,want]of [
  ['label',{addLabelIds:['Label_1']},['INBOX','Label_1','Label_other','UNREAD']],
  ['archive',{removeLabelIds:['INBOX']},['Label_other','UNREAD']],
  ['read',{removeLabelIds:['UNREAD']},['INBOX','Label_other']],
  ['label and read',{addLabelIds:['Label_1'],removeLabelIds:['UNREAD']},['INBOX','Label_1','Label_other']]
])test('applying '+name+' preserves all unrelated labels and message states',()=>{
  const f=fixture({filters:[{id:'f1',criteria:{from:'sender@example.com'},action}]});const run=f.controller().start(null);f.scan(run);f.finish(run);assert.deepEqual([...f.messages.get('a')].sort(),want);
});
test('unsupported-only actions stay visible and cannot be selected for message updates',()=>{
  const f=fixture({filters:[{id:'f1',criteria:{from:'sender@example.com'},action:{addLabelIds:['STARRED','TRASH'],forward:'dest@example.com'}}]});const e=f.controller().list().entries[0];assert.equal(e.eligible,false);assert.equal(e.ignored.length,3);assert.throws(()=>f.controller().start(null));assert.throws(()=>f.controller().start([key]));assert.equal(f.calls.length,0);
});
test('1000 selected rules and 500-ID pages keep every checkpoint and approval below 8KB',()=>{
  const crypto=require('node:crypto'),f=fixture();f.rows.splice(0);f.data.filters.splice(0);
  for(let i=0;i<1000;i++){const filter={id:'f'+i,criteria:{subject:'subject '+i},action:{removeLabelIds:['INBOX']}};f.data.filters.push(filter);f.rows.push(C.importFilter(filter,labels,crypto.randomUUID()));}
  const sizes=[],set=f.deps.state.set;f.deps.state.set=(k,v)=>{const size=Buffer.byteLength(JSON.stringify(v));sizes.push(size);assert.ok(size<=8000,k+' has '+size+' bytes');set(k,v);};
  f.deps.gmail.listMessages=()=>({ids:Array.from({length:500},(_,i)=>'m'+i),nextPageToken:''});
  const run=f.controller().start(null);const progress=f.controller().scan(run.runId);assert.equal(progress.total,500);assert.equal(progress.ruleCount,1000);assert.ok(Math.max(...sizes)<2000);
});
test('a History failure after final scan checkpoint cannot strand a fully discovered job',()=>{
  const f=fixture();f.deps.gmail.listMessages=()=>({ids:['a'],nextPageToken:''});const run=f.controller().start(null);f.faults.history=true;
  const interrupted=f.controller().scan(run.runId);assert.equal(interrupted.total,1);assert.equal(interrupted.completed,0);
  const resumed=f.controller().scan(run.runId);assert.equal(resumed.status,'READY');assert.equal(f.finish(run).status,'OK');
});
test('interrupted scan and mutation saves never advance beyond durable progress',()=>{
  const f=fixture();const run=f.controller().start(null);f.faults.save=true;assert.equal(f.controller().scan(run.runId).status,'SCAN_FAILED');assert.equal(f.controller().status(run.runId).total,0);delete f.faults.save;f.scan(run);
  const original=f.deps.gmail.modifyMessages;f.deps.gmail.modifyMessages=(ids,action)=>{original(ids,action);f.faults['state:messageJob']=true;};
  const result=f.controller().apply(f.controller().prepare(run.runId));assert.equal(result.status,'FAILED');assert.equal(result.completed,0);assert.equal(result.uncertain,1);
  f.deps.gmail.modifyMessages=original;assert.equal(f.finish(run).completed,3);
});
test('history failure at update intent prevents the Gmail write',()=>{
  const f=fixture();const run=f.controller().start(null);f.scan(run);const ticket=f.controller().prepare(run.runId);f.faults.history=true;assert.throws(()=>f.controller().apply(ticket));assert.equal(f.calls.filter(c=>c[0]==='modify').length,0);
  assert.equal(f.finish(run).status,'OK');
});
test('final scan can recover when property write persisted but readback reported failure',()=>{
  const f=fixture();f.deps.gmail.listMessages=()=>({ids:['a'],nextPageToken:''});const run=f.controller().start(null),set=f.deps.state.set;let failed=false;
  f.deps.state.set=(k,v)=>{set(k,v);if(k==='messageJob'&&v.status==='READY'&&!failed){failed=true;throw Error('readback failed after save');}};
  assert.equal(f.controller().scan(run.runId).status,'SCAN_FAILED');assert.equal(f.controller().scan(run.runId).status,'READY');assert.equal(f.finish(run).status,'OK');
});
