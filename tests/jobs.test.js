'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const C=require('../src/Core'),S=require('../src/Sync'),{harness,key}=require('./helpers');
const J=fs.existsSync(require('node:path').join(__dirname,'../src/Jobs.js'))?require('../src/Jobs'):{};
function fixture(options={}){
 const h=harness(options),blobs=new Map(),triggers=new Set();let serial=0,locked=false;
 h.deps.bookId='book';h.deps.actor=()=> 'owner@example.com';
 h.deps.store.writeJobData=(runId,v)=>{const p={runId,id:String(++serial)};blobs.set(p.id,C.clone(v));return p;};
 h.deps.store.readJobData=p=>C.clone(blobs.get(p.id));
 h.deps.scheduler={ensure(){triggers.add('trigger');},exists:()=>triggers.size===1,clear(){triggers.clear();}};
 h.deps.withLock=fn=>{if(locked)throw Error('locked');locked=true;try{return fn();}finally{locked=false;}};
 h.rows[0].Subject='changed';const controller=S.create(h.deps);controller.preview();const ticket=controller.prepare();
 const jobs=J.create?.(h.deps);
 return {...h,blobs,triggers,ticket,jobs,drain(){for(let i=0;i<100;i++){const v=jobs.status();if(['OK','PAUSED'].includes(v.status))return v;jobs.run();}throw Error('not terminated');}};
}
test('acceptance persists approved scope promptly without any Gmail or sheet reads; duplicate acceptance never queues twice',()=>{
 const h=fixture();assert.ok(h.jobs,'persisted jobs API must exist');
 h.deps.gmail.read=()=>{throw Error('accept must not read Gmail');};h.deps.store.readRows=()=>{throw Error('accept must not read Filters');};
 const accepted=h.jobs.accept(h.ticket,true);assert.equal(accepted.status,'ACCEPTED');assert.equal(h.writes.length,0);assert.equal(h.triggers.size,1);
 assert.equal(h.jobs.accept(h.ticket,true).runId,h.ticket.runId);assert.equal(h.triggers.size,1);
 assert.ok(h.blobs.size);assert.ok(JSON.stringify(h.props.filterJob).length<8000);
});
test('preparation stages yield before Gmail mutation and background execution completes replacement with verified counts',()=>{
 const h=fixture();assert.ok(h.jobs);h.jobs.accept(h.ticket,true);h.jobs.run();assert.equal(h.writes.length,0);
 const result=h.drain();assert.equal(result.status,'OK');assert.equal(result.filters.completed,1);assert.equal(result.filters.remaining,0);assert.equal(h.writes.filter(w=>w[0]==='create').length,1);assert.equal(h.writes.filter(w=>w[0]==='delete').length,1);assert.equal(h.triggers.size,0);assert.ok(result.timings.SHEET_READ>=0);assert.ok(result.timings.DIFF_CHECK>=0);assert.ok(result.timings.BACKUP_CHECK>=0);assert.ok(result.timings.REFERENCES>=0);assert.ok(result.timings.GMAIL_UPDATE>=0);assert.ok(result.timings.VERIFY>=0);
});
for(const cutoff of ['afterCreate','afterDelete'])test('durable reconciliation resumes '+cutoff+' without duplicate create or wrong delete',()=>{
 const h=fixture();assert.ok(h.jobs);h.jobs.accept(h.ticket,true);h.faults[cutoff]=true;
 const result=h.drain();assert.equal(result.status,'OK');assert.equal(h.writes.filter(w=>w[0]==='create').length,1);assert.deepEqual(h.writes.filter(w=>w[0]==='delete'),[['delete','old']]);assert.equal(h.data.filters.length,1);
});
test('edits between trigger batches pause remaining work and preserve approved scope',()=>{
 const h=fixture();assert.ok(h.jobs);h.jobs.accept(h.ticket,true);h.jobs.run();h.rows[0].Subject='unapproved';
 assert.equal(h.drain().status,'PAUSED');assert.equal(h.writes.length,0);assert.match(h.jobs.status(h.ticket.runId).error,/変更/);
});
test('unknown create result is distinct from failure and never blindly recreated',()=>{
 const h=fixture();assert.ok(h.jobs);h.jobs.accept(h.ticket,true);h.faults.create=true;
 const result=h.drain();assert.equal(result.status,'PAUSED');assert.equal(result.uncertain,1);assert.equal(h.writes.length,0);assert.equal(h.jobs.run().status,'PAUSED');
});
test('missing trigger and expired lease are detected from status; status repairs continuation without mutation',()=>{
 const h=fixture();assert.ok(h.jobs);h.jobs.accept(h.ticket,true);h.triggers.clear();h.props.filterJob.status='RUNNING';h.props.filterJob.leaseUntil=1;h.tick(200000);
 const v=h.jobs.status(h.ticket.runId);assert.equal(v.status,'WAITING');assert.equal(v.recovered,true);assert.equal(h.triggers.size,1);assert.equal(h.writes.length,0);assert.equal(h.drain().status,'OK');
});
test('owner/book identity and operation lock fence background duplicate execution',()=>{
 const h=fixture();assert.ok(h.jobs);h.jobs.accept(h.ticket,true);const before=C.clone(h.props.filterJob);
 h.deps.actor=()=> 'other';assert.throws(()=>h.jobs.run(),/所有者|実行者/);assert.deepEqual(h.props.filterJob,before);h.deps.actor=()=> 'owner@example.com';
 h.deps.withLock(()=>assert.throws(()=>h.jobs.run(),/locked/));assert.equal(h.writes.length,0);
});
test('large approval originals reside in sheet data, not script properties',()=>{
 const h=fixture();assert.ok(h.jobs);h.rows[0].OriginalJson=JSON.stringify({criteria:{query:'x'.repeat(50000)},action:{}});
 const c=S.create(h.deps);c.preview();const t=c.prepare();h.jobs.accept(t,true);assert.ok(JSON.stringify(h.props).length<24000);assert.ok([...h.blobs.values()].some(v=>JSON.stringify(v).length>50000));
});
test('metadata response loss after successful replacement never replays completed create',()=>{
 const h=fixture();h.jobs.accept(h.ticket,true);const original=h.deps.store.updateRow;
 h.deps.store.updateRow=(k,p)=>{original(k,p);h.deps.store.updateRow=original;throw Error('metadata response lost');};
 assert.equal(h.drain().status,'OK');assert.equal(h.writes.filter(w=>w[0]==='create').length,1);assert.equal(h.data.filters.length,1);
});
test('confirmed counts ignore unchanged filters and unknown count clears after reconciliation',()=>{
 const h=fixture();h.jobs.accept(h.ticket,true);h.faults.afterCreate=true;const v=h.drain();assert.equal(v.uncertain,0);assert.equal(v.completed,1);
});
test('preapproval preparation is a saved staged job and performs no Gmail mutations',()=>{
 const h=fixture();assert.equal(typeof h.jobs.prepareStart,'function');h.deps.state.remove('prepared');h.deps.state.remove('preview');
 const accepted=h.jobs.prepareStart({keys:null});assert.equal(accepted.status,'PREPARING');assert.equal(h.writes.length,0);
 let v;for(let n=0;n<10;n++){h.jobs.run();v=h.jobs.prepareStatus(accepted.preparationId);if(v.status==='READY')break;}
 assert.equal(v.status,'READY');assert.ok(v.ticket.jobApproval);assert.equal(v.entries.filter(e=>e.operation==='REPLACE').length,1);assert.equal(h.writes.length,0);
 assert.equal(h.jobs.accept(v.ticket,true).status,'ACCEPTED');assert.equal(h.drain().status,'OK');
});
test('remaining confirmation preserves original selected scope after definitions change',()=>{
 const h=fixture();const other='22222222-2222-4222-8222-222222222222';h.rows.push(C.importFilter({id:'second',criteria:{from:'other@example.com'},action:{}},h.data.labels,other));h.data.filters.push({id:'second',criteria:{from:'other@example.com'},action:{}});
 const c=S.create(h.deps);c.preview();const ticket=c.prepare([key]);h.jobs.accept(ticket,true);h.jobs.run();h.rows[0].Subject='edited';assert.equal(h.drain().status,'PAUSED');
 assert.equal(typeof h.jobs.prepareRemaining,'function');const p=h.jobs.prepareRemaining(ticket.runId);for(let n=0;n<10;n++)h.jobs.run();const ready=h.jobs.prepareStatus(p.preparationId);assert.equal(ready.status,'READY');assert.ok(ready.entries.every(e=>e.ruleKey===key));
});
test('continuation reconciles an interrupted created replacement before showing cleanup and edited definition',()=>{
 const h=fixture();h.jobs.accept(h.ticket,true);const original=h.deps.gmail.create;h.deps.gmail.create=f=>{const value=original(f);h.rows[0].Subject='edited after create';return value;};
 const stopped=h.drain();assert.equal(stopped.status,'PAUSED');assert.equal(h.data.filters.length,2);const p=h.jobs.prepareRemaining(h.ticket.runId);for(let n=0;n<10;n++)h.jobs.run();const ready=h.jobs.prepareStatus(p.preparationId);assert.equal(ready.status,'READY');assert.ok(ready.entries.some(e=>e.jobCleanup));
 h.jobs.accept(ready.ticket,true);assert.equal(h.drain().status,'OK');assert.equal(h.data.filters.length,1);assert.equal(h.data.filters[0].criteria.subject,'edited after create');
});
test('selection receipt tampering halts before any Gmail changes',()=>{
 const h=fixture(),c=S.create(h.deps);c.preview();const t=c.prepare([key]);h.jobs.accept(t,true);h.scopes[t.snapshotId]=['unapproved'];assert.equal(h.drain().status,'PAUSED');assert.equal(h.writes.length,0);
});
test('scheduler registration failure pauses with saved reason; lifetime/retry limits remove worker',()=>{
 const h=fixture();h.deps.scheduler.ensure=()=>{throw Error('permission');};assert.equal(h.jobs.accept(h.ticket,true).status,'PAUSED');assert.match(h.jobs.status().error,/トリガー/);
 const next=fixture();next.jobs.accept(next.ticket,true);next.tick(86400001);assert.equal(next.jobs.run().status,'PAUSED');assert.equal(next.triggers.size,0);
});
test('label create response loss and legacy rename refs recover without adopting an unrelated label',()=>{
 const lk='22222222-2222-4222-8222-222222222222',h=fixture({labelRows:[{LabelKey:lk,Name:'renamed',GmailLabelId:'Label_1',SyncedName:'仕事'}]});h.rows[0].UserLabel='仕事';h.rows[0].OriginalJson=JSON.stringify({criteria:{from:'sender@example.com'},action:{addLabelIds:['Label_1']}});h.rows[0].OriginalRowJson=JSON.stringify({...JSON.parse(h.rows[0].OriginalRowJson),UserLabel:'仕事'});h.data.filters[0].action.addLabelIds=['Label_1'];const c=S.create(h.deps);c.preview();const t=c.prepare([key]);h.jobs.accept(t,true);h.faults.afterRenameLabel=true;
 assert.equal(h.drain().status,'OK');assert.equal(h.labelRows[0].GmailLabelId,'Label_1');assert.equal(h.rows[0].UserLabel,'renamed');assert.equal(h.writes.filter(w=>w[0]==='labelRename').length,1);
});
test('acceptance immediately exposes planned changed counts and no unchanged row count',()=>{
 const h=fixture();const v=h.jobs.accept(h.ticket,true);assert.equal(v.filters.planned,1);assert.equal(v.filters.remaining,1);assert.equal(v.filters.completed,0);
});
test('a present trigger with no heartbeat is repaired only a bounded number of times',()=>{
 const h=fixture();h.jobs.accept(h.ticket,true);
 for(let n=0;n<3;n++){h.tick(6*60*1000);const v=h.jobs.status();assert.equal(v.status,'WAITING');assert.equal(v.recovered,true);}
 h.tick(6*60*1000);const v=h.jobs.status();assert.equal(v.status,'PAUSED');assert.match(v.error,/トリガー|自動実行/);assert.equal(h.triggers.size,0);
});
test('checkpoint integrity failure pauses, records reason and preserves the trustworthy receipt',()=>{
 const h=fixture();h.jobs.accept(h.ticket,true);h.jobs.run();const before=C.clone(h.props.filterJob),read=h.deps.store.readJobData;
 h.deps.store.readJobData=p=>{if(p.id===before.checkpoint.id){const e=Error('saved data corrupt');e.code='GFM_DATA_INTEGRITY';throw e;}return read(p);};
 let result;assert.doesNotThrow(()=>{result=h.jobs.run();});assert.equal(result.status,'PAUSED');assert.equal(h.props.filterJob.attempts,1);assert.equal(h.props.filterJob.leaseUntil,0);assert.match(result.error,/保存|検証|破損/);assert.deepEqual(h.props.filterJob.checkpoint,before.checkpoint);assert.equal(h.triggers.size,0);assert.equal(h.history.at(-1).result,'PAUSED');assert.equal(h.writes.length,0);
});
test('transient checkpoint read failure is retried at most five times with uncertainty intact',()=>{
 const h=fixture();h.jobs.accept(h.ticket,true);h.jobs.run();const checkpoint=C.clone(h.props.filterJob.checkpoint);h.props.filterJob.intentPhase='CREATE';h.props.filterJob.uncertain=1;
 h.deps.store.readJobData=()=>{throw Error('Spreadsheet service temporarily unavailable');};
 for(let n=1;n<=5;n++){let v;assert.doesNotThrow(()=>{v=h.jobs.run();});assert.equal(v.status,n===5?'PAUSED':'WAITING');assert.equal(h.props.filterJob.attempts,n);assert.equal(v.uncertain,1);assert.deepEqual(h.props.filterJob.checkpoint,checkpoint);assert.equal(h.history.at(-1).result,v.status);}
 assert.equal(h.triggers.size,0);assert.equal(h.writes.length,0);
});
test('malformed loaded approval pauses instead of escaping the worker',()=>{
 const h=fixture();h.jobs.accept(h.ticket,true);h.blobs.set(h.ticket.jobApproval.id,{rows:'corrupt'});let result;assert.doesNotThrow(()=>{result=h.jobs.run();});assert.equal(result.status,'PAUSED');assert.match(result.error,/保存|検証|破損/);assert.equal(h.writes.length,0);
});
test('remaining confirmation refuses an intervening filter ID association edit',()=>{
 const h=fixture();h.jobs.accept(h.ticket,true);const create=h.deps.gmail.create;h.deps.gmail.create=f=>{const result=create(f);h.rows[0].Subject='edited';return result;};assert.equal(h.drain().status,'PAUSED');
 h.rows[0].GmailFilterId='user-chosen-id';const before=h.writes.length,p=h.jobs.prepareRemaining(h.ticket.runId);h.jobs.run();assert.equal(h.jobs.prepareStatus(p.preparationId).status,'PAUSED');assert.equal(h.rows[0].GmailFilterId,'user-chosen-id');assert.equal(h.writes.length,before);
});
test('remaining confirmation refuses an intervening label ID association edit',()=>{
 const lk='22222222-2222-4222-8222-222222222222',h=fixture({labelRows:[{LabelKey:lk,Name:'fresh',GmailLabelId:''}]});const c=S.create(h.deps);c.preview();const ticket=c.prepare();h.jobs.accept(ticket,true);const create=h.deps.gmail.createLabel;
 h.deps.gmail.createLabel=name=>{const result=create(name);h.labelRows[0].Name='edited label';return result;};assert.equal(h.drain().status,'PAUSED');
 h.labelRows[0].GmailLabelId='user-chosen-label';const before=h.writes.length,p=h.jobs.prepareRemaining(ticket.runId);h.jobs.run();assert.equal(h.jobs.prepareStatus(p.preparationId).status,'PAUSED');assert.equal(h.labelRows[0].GmailLabelId,'user-chosen-label');assert.equal(h.writes.length,before);
});
for(const retryable of [false,true])test('reference '+(retryable?'transient':'permanent')+' failure exposes bounded diagnostic without raw error',()=>{
 const lk='22222222-2222-4222-8222-222222222222',h=fixture({labelRows:[{LabelKey:lk,Name:'仕事',GmailLabelId:'Label_1',SyncedName:'仕事'}]});
 h.deps.store.batchJobPatches=()=>{throw Object.assign(Error('private@example.com raw filter'),{code:'GFM_REFERENCE_UPDATE',reference:{code:retryable?'SERVICE_UNAVAILABLE':'ANCHOR_INVALID',stage:retryable?'WRITE':'PRECHECK',retryable,count:1,serviceStatus:retryable?503:undefined,private:'do not persist'}});};
 h.rows[0].UserLabel='仕事';h.rows[0].UserLabelRef='';const controller=S.create(h.deps);controller.preview();const ticket=controller.prepare();h.jobs.accept(ticket,true);let result;for(let n=0;n<20;n++){result=h.jobs.run();if(result.status==='PAUSED')break;}
 assert.equal(result.status,'PAUSED');assert.equal(result.diagnostic?.code,retryable?'SERVICE_UNAVAILABLE':'ANCHOR_INVALID');assert.equal(result.diagnostic?.attempt,retryable?5:1);assert.equal(result.diagnostic?.operation,'REFERENCE_UPDATE');assert.equal(typeof result.diagnostic?.at,'number');assert.equal(result.diagnostic?.count,1);assert.ok(!JSON.stringify(h.props.filterJob).includes('private'));assert.ok(!JSON.stringify(h.history).includes('private'));assert.equal(h.writes.length,0);
});
