'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/Core'),Sync=require('../src/Sync'),Jobs=require('../src/Jobs'),{harness,key,labels}=require('./helpers');
const policy='SHEET_AUTHORITATIVE',lk='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
function fixture({authoritative=true,rename=false,changed=false,selected}={}){
 const filter={id:'old',criteria:{from:'sender@example.com'},action:{addLabelIds:['Label_1'],removeLabelIds:['INBOX']}},row=C.importFilter(filter,labels,key);
 if(changed)row.Subject='approved';
 const h=harness({filters:[filter],rows:[row],labelRows:[{LabelKey:lk,Name:rename?'renamed':'仕事',GmailLabelId:'Label_1',SyncedName:'仕事'}]}),blobs=new Map();let serial=0;
 Object.assign(h.deps,{applyPolicy:authoritative?policy:undefined,bookId:'book',actor:()=> 'owner@example.com',withLock:fn=>fn(),scheduler:{ensure(){},exists:()=>true,clear(){}}});
 h.deps.store.writeJobData=(runId,value)=>{const p={runId,id:String(++serial)};blobs.set(p.id,C.clone(value));return p;};h.deps.store.readJobData=p=>C.clone(blobs.get(p.id));
 const sync=Sync.create(h.deps),jobs=Jobs.create(h.deps);sync.preview();const ticket=sync.prepare(selected);jobs.accept(ticket,true);
 return {...h,blobs,sync,jobs,ticket,toApply(){for(let n=0;n<20&&jobs.status().phase!=='APPLY';n++)jobs.run();assert.equal(jobs.status().phase,'APPLY');},drain(){for(let n=0;n<160;n++){const v=jobs.status();if(['OK','PAUSED','CANCELLED'].includes(v.status))return v;jobs.run();}throw Error('job did not terminate');}};
}
test('new authoritative approval checks originally unchanged managed rows and overwrites later remote edits',()=>{
 const h=fixture();assert.equal(h.ticket.policy,policy);h.toApply();h.data.filters[0].action.removeLabelIds.push('SPAM');const v=h.drain();assert.equal(v.status,'OK');assert.equal(v.verification.status,'MATCH');assert.equal(v.uncertain,0);assert.deepEqual(h.data.filters[0].action.removeLabelIds,['INBOX']);assert.equal(h.writes.filter(w=>w[0]==='create').length,1);assert.equal(h.writes.filter(w=>w[0]==='delete').length,1);
});
test('rename side effects on a linked filter are overwritten after the label result is reconciled',()=>{
 const h=fixture({rename:true}),rename=h.deps.gmail.renameLabel;h.deps.gmail.renameLabel=(id,name)=>{const r=rename(id,name);h.data.filters[0].action.removeLabelIds.push('SPAM');return r;};const v=h.drain();assert.equal(v.status,'OK');assert.equal(v.uncertain,0);assert.equal(h.data.labels.find(l=>l.id==='Label_1').name,'renamed');assert.deepEqual(h.data.filters[0].action.removeLabelIds,['INBOX']);assert.equal(h.writes.filter(w=>w[0]==='labelRename').length,1);
});
test('selected label application preserves unselected filter drift and saves a post-apply report',()=>{
 const h=fixture({rename:true,selected:['label:'+lk]}),rename=h.deps.gmail.renameLabel;h.deps.gmail.renameLabel=(id,name)=>{const r=rename(id,name);h.data.filters[0].action.removeLabelIds.push('SPAM');return r;};const v=h.drain();assert.equal(v.status,'OK');assert.equal(v.uncertain,0);assert.equal(v.verification.status,'DIFFERENCES');assert.equal(v.verification.outside,1);assert.equal(h.writes.filter(w=>w[0]==='create'||w[0]==='delete').length,0);const report=h.jobs.verification(v.runId);assert.ok(report.entries.some(e=>e.ruleKey===key&&e.inScope===false&&e.operation==='REPLACE'));assert.equal(Jobs.create(h.deps).verification(v.runId).entries.length,report.entries.length);
});
for(const change of ['edit','remove'])test('authoritative target is replanned when its current ID '+change+'s before its turn',()=>{
 const h=fixture({changed:true});h.toApply();if(change==='edit')h.data.filters[0].criteria.subject='remote edit';else h.data.filters=[];const v=h.drain();assert.equal(v.status,'OK');assert.equal(h.data.filters.length,1);assert.equal(h.data.filters[0].criteria.subject,'approved');assert.equal(h.writes.filter(w=>w[0]==='create').length,1);
});
test('remote drift after completed targets is reported without replaying or pausing a successful sweep',()=>{
 const h=fixture({changed:true}),read=h.deps.gmail.read;let writes;h.deps.gmail.read=()=>{if(h.props.filterJob.phase==='VERIFY'&&writes===undefined){writes=h.writes.length;h.data.filters[0].criteria.subject='late remote edit';}return read();};const v=h.drain();assert.equal(v.status,'OK');assert.equal(v.verification.status,'DIFFERENCES');assert.equal(v.verification.inScope,1);assert.equal(h.writes.length,writes);assert.equal(h.jobs.verification(v.runId).entries.find(e=>e.ruleKey===key).before.criteria.subject,'late remote edit');
});
for(const fault of ['afterCreate','afterRenameLabel'])test('authoritative '+fault+' response loss is reconciled without another mutation',()=>{
 const h=fixture({changed:true,rename:fault==='afterRenameLabel'});h.faults[fault]=true;const v=h.drain();assert.equal(v.status,'OK');assert.equal(v.uncertain,0);assert.equal(h.writes.filter(w=>w[0]===(fault==='afterCreate'?'create':'labelRename')).length,1);
});
test('ambiguous uncertain creation and sheet edits still stop an authoritative job',()=>{
 const h=fixture({changed:true});h.toApply();h.faults.create=true;assert.equal(h.drain().status,'PAUSED');assert.equal(h.jobs.status().uncertain,1);assert.equal(h.writes.length,0);
 const edited=fixture({changed:true});edited.toApply();edited.rows[0].Subject='unapproved edit';assert.equal(edited.drain().status,'PAUSED');assert.equal(edited.writes.length,0);
});
test('legacy saved approvals retain remote-drift fencing',()=>{const h=fixture({authoritative:false,changed:true});h.toApply();h.data.filters[0].criteria.subject='external';assert.equal(h.drain().status,'PAUSED');assert.equal(h.writes.length,0);});
test('authoritative disabled rows delete the bound current ID despite changed contents',()=>{
 const h=fixture();h.rows[0].Status='無効';h.sync.preview();const t=h.sync.prepare();h.props.filterJob.status='OK';h.jobs.accept(t,true);h.toApply();h.data.filters[0].criteria.subject='remote';assert.equal(h.drain().status,'OK');assert.equal(h.data.filters.length,0);assert.deepEqual(h.writes.filter(w=>w[0]==='delete'),[['delete','old']]);
});
test('large final discrepancies live in durable job data and are owner/run scoped',()=>{
 const h=fixture({changed:true}),read=h.deps.gmail.read;let changed=false;h.deps.gmail.read=()=>{if(h.props.filterJob.phase==='VERIFY'&&!changed){changed=true;h.data.filters.push(...Array.from({length:180},(_,i)=>({id:'outside-'+i,criteria:{from:'outside-'+i+'@example.com'},action:{}})));}return read();};const v=h.drain();assert.equal(v.status,'OK');assert.equal(v.verification.remoteOnly,180);assert.ok(JSON.stringify(h.props.filterJob).length<8000);assert.equal(h.jobs.verification(v.runId).entries.filter(e=>e.operation==='REMOTE_ONLY').length,180);assert.throws(()=>h.jobs.verification('wrong'),/実行|ジョブ/);h.deps.actor=()=> 'other';assert.throws(()=>h.jobs.verification(v.runId),/所有者|実行者/);
});
test('fresh ALL confirmation may choose a new scope after paused intent recovery; remaining preserves old keys',()=>{
 const h=fixture({rename:true,selected:['label:'+lk]}),rename=h.deps.gmail.renameLabel;h.deps.gmail.renameLabel=(id,name)=>{const r=rename(id,name);h.rows[0].Subject='sheet edited';return r;};assert.equal(h.drain().status,'PAUSED');h.deps.gmail.renameLabel=rename;
 const p=h.jobs.prepareRemaining(h.ticket.runId);for(let n=0;n<4;n++)h.jobs.run();const remaining=h.jobs.prepareStatus(p.preparationId);assert.equal(remaining.status,'READY');assert.deepEqual(h.blobs.get(remaining.ticket.jobApproval.id).keys,['label:'+lk]);
 const fresh=h.jobs.prepareStart({fresh:true});for(let n=0;n<4;n++)h.jobs.run();const all=h.jobs.prepareStatus(fresh.preparationId);assert.equal(all.status,'READY');assert.equal(all.ticket.scopeMode,'ALL');assert.ok(h.blobs.get(all.ticket.jobApproval.id).keys.includes(key));assert.equal(h.writes.filter(w=>w[0]==='create').length,0);
});
test('post-apply differences are recorded in history and remain readable after a later job',()=>{
 const h=fixture({rename:true,selected:['label:'+lk]}),rename=h.deps.gmail.renameLabel;h.deps.gmail.renameLabel=(id,name)=>{const r=rename(id,name);h.data.filters[0].action.removeLabelIds.push('SPAM');return r;};const first=h.drain();assert.equal(h.history.at(-1).result,'OK_WITH_DIFFERENCES');assert.equal(JSON.parse(h.history.at(-1).verification).verification.outside,1);const saved=h.jobs.verification(first.runId);h.sync.preview();h.jobs.accept(h.sync.prepare(),true);assert.equal(h.drain().status,'OK');assert.deepEqual(h.jobs.verification(first.runId),saved);h.deps.actor=()=> 'foreign';assert.throws(()=>h.jobs.verification(first.runId),/所有者|実行者/);
});
