'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/Core'),S=require('../src/Sheets'),R=require('../src/Runtime'),W=require('../src/Web'),J=require('../src/Jobs'),Sync=require('../src/Sync'),{fakeSheets}=require('./fake-sheets'),{harness,key,hash,labels,base}=require('./helpers');
test('batch reference updates use one metadata lookup and one API write for twenty five rows',()=>{
 const f=fakeSheets(),store=S.create({...f,hash,uuid:()=>require('node:crypto').randomUUID()});store.setup();
 const rows=Array.from({length:25},()=>C.importFilter(base(),labels,require('node:crypto').randomUUID()));store.appendRows(rows);
 let calls=0;const write=f.api.Spreadsheets.Values.batchUpdateByDataFilter;f.api.Spreadsheets.Values.batchUpdateByDataFilter=(...a)=>{calls++;return write(...a);};
 assert.equal(typeof store.batchJobPatches,'function');const ref={key,name:'仕事'};
 store.batchJobPatches(rows.map(r=>({key:r.RuleKey,reference:true,values:{UserLabel:ref.name,UserLabelRef:JSON.stringify(ref)}})),store.readRows(),[]);
 assert.equal(calls,1);assert.ok(store.readRows().every(r=>r.UserLabelRef===JSON.stringify(ref)));
});
test('scheduler preserves unrelated triggers and leaves exactly one recurring owned worker',()=>{
 assert.equal(typeof R.scheduler,'function');const list=[{id:'other',getHandlerFunction:()=> 'other'},{id:'a',getHandlerFunction:()=> 'GFM_runFilterJob'},{id:'b',getHandlerFunction:()=> 'GFM_runFilterJob'}];let created=0;
 const api={getProjectTriggers:()=>list.slice(),deleteTrigger:t=>list.splice(list.indexOf(t),1),newTrigger:name=>({timeBased(){return this;},everyMinutes(n){assert.equal(n,1);return this;},create(){created++;list.push({getHandlerFunction:()=>name});}})};
 const scheduler=R.scheduler(api);scheduler.ensure();scheduler.ensure();assert.equal(list.length,2);assert.equal(created,0);scheduler.clear();assert.equal(list[0].id,'other');scheduler.ensure();assert.equal(created,1);
});
test('production Web job acceptance is idempotent, boot/status restore progress and no synchronous apply runs',()=>{
 const h=harness(),data=new Map();h.rows[0].Subject='changed';h.deps.bookId='book';h.deps.withLock=fn=>fn();h.deps.scheduler={ensure(){},exists:()=>true,clear(){}};
 h.deps.store.writeJobData=(runId,v)=>{const p={runId,id:String(data.size)};data.set(p.id,C.clone(v));return p;};h.deps.store.readJobData=p=>C.clone(data.get(p.id));
 const jobs=J.create(h.deps),controller=Sync.create(h.deps),web=W.create({...h.deps,controller,jobs});const pv=web.dispatch('preview'),p=web.dispatch('prepare',{runId:pv.runId});
 controller.apply=()=>{throw Error('must use background acceptance');};const accepted=web.dispatch('apply',{token:p.token});assert.equal(accepted.status,'ACCEPTED');assert.equal(h.writes.length,0);
 assert.equal(web.dispatch('boot').filterJob.runId,p.runId);assert.equal(web.dispatch('apply',{token:p.token}).runId,p.runId);assert.equal(web.dispatch('filterJobStatus',{runId:p.runId}).status,'ACCEPTED');
 for(let i=0;i<20&&jobs.status().status!=='OK';i++)jobs.run();assert.equal(web.dispatch('outcome',{runId:p.runId}).status,'OK');assert.equal(h.writes.length,2);
});
test('boot reads saved filter progress without waiting on the mutation lock',()=>{
 const h=harness();let acquired=0;const web=W.create({...h.deps,bookId:'book',withLock(){acquired++;throw Error('held by worker');},controller:{},jobs:{status:()=>({status:'RUNNING',job:true,runId:'r'})}});h.props.filterJob={runId:'r'};
 assert.equal(web.dispatch('boot').filterJob.status,'RUNNING');assert.equal(acquired,0);
});
test('backup validation and scope receipt reads never download historical job/message payloads',()=>{
 const f=fakeSheets(),store=S.create({...f,hash,uuid:()=>require('node:crypto').randomUUID()});store.setup();const state={filters:[base()],labels,forwarding:[]};store.backup(state,'snapshot','now');store.writeScope('snapshot',[key],'now');store.writeJobData('other-run',{private:'x'.repeat(90000)});
 const sheet=f.sheets.get('Backup'),range=sheet.getRange.bind(sheet);sheet.getRange=(...a)=>{const r=range(...a),get=r.getValues.bind(r);r.getValues=()=>{if(a[1]===1&&a[3]===8){const values=get();if(values.some(v=>v[2]==='MESSAGES'))throw Error('historical payload must not be downloaded');return values;}return get();};return r;};
 assert.deepEqual(store.readBackup('snapshot'),state);assert.deepEqual(store.readScope('snapshot'),[key]);
});
