'use strict';
// Synthetic services only. No credentials, network, live Gmail, or deployment.
const C=require('../src/Core'),S=require('../src/Sheets'),Sync=require('../src/Sync'),Jobs=require('../src/Jobs'),{fakeSheets}=require('../tests/fake-sheets'),{harness,hash}=require('../tests/helpers'),crypto=require('node:crypto');
function fixture(){
 const labels=Array.from({length:20},(_,i)=>({id:'Label_'+i,name:'old-'+i,type:'user'}));
 const filters=Array.from({length:108},(_,i)=>({id:'filter-'+i,criteria:{from:'synthetic-'+i+'@example.invalid'},action:{addLabelIds:['Label_'+(i%20)]}}));
 const h=harness({rows:[]}),f=fakeSheets();h.data.labels=labels;h.data.filters=filters;h.data.forwarding=[];
 const store=S.create({...f,hash,uuid:()=>crypto.randomUUID()});store.setup();store.appendRows(filters.map(v=>C.importFilter(v,labels,crypto.randomUUID())));
 store.appendLabelRows([...Array.from({length:30},(_,i)=>({LabelKey:crypto.randomUUID(),Name:'new-'+i})),...labels.map(l=>({LabelKey:crypto.randomUUID(),Name:'changed-'+l.name,GmailLabelId:l.id,SyncedName:l.name}))]);
 const counts={getValues:0,getFormulas:0,metadataFind:0,batchWrites:0,flush:0,gmailReads:0,gmailWrites:0,checkpointWrites:0},reset=()=>Object.keys(counts).forEach(k=>counts[k]=0),count=name=>{counts[name]++;h.tick(25);};
 for(const sheet of f.sheets.values()){
  const range=sheet.getRange.bind(sheet);sheet.getRange=(...args)=>{const r=range(...args);for(const method of ['getValues','getFormulas']){const fn=r[method].bind(r);r[method]=(...a)=>{count(method);return fn(...a);};}return r;};
  const finder=sheet.createDeveloperMetadataFinder.bind(sheet);sheet.createDeveloperMetadataFinder=(...args)=>{const v=finder(...args),find=v.find.bind(v);v.find=(...a)=>{count('metadataFind');return find(...a);};return v;};
 }
 const atomic=f.api.Spreadsheets.Values.batchUpdateByDataFilter;f.api.Spreadsheets.Values.batchUpdateByDataFilter=(...a)=>{count('batchWrites');return atomic(...a);};
 const flush=f.app.flush;f.app.flush=()=>{count('flush');return flush();};
 for(const name of ['read','create','delete','createLabel','renameLabel']){const fn=h.deps.gmail[name];h.deps.gmail[name]=(...a)=>{count(name==='read'?'gmailReads':'gmailWrites');return fn(...a);};}
 const checkpoint=store.writeJobData;store.writeJobData=(...a)=>{counts.checkpointWrites++;return checkpoint(...a);};
 const deps={...h.deps,store,bookId:'book',actor:()=> 'synthetic-owner',withLock:fn=>fn(),scheduler:{ensure(){},exists:()=>true,clear(){}},maxMillis:1e12,maxOperations:10000};
 return {deps,counts,reset};
}
function run(){
 const result={scenario:{filters:108,labelCreates:30,labelRenames:20,latencyMsPerCall:25},legacy:{},jobs:{}};
 for(const mode of ['legacy','jobs']){
  const f=fixture(),sync=Sync.create(f.deps);sync.preview();const ticket=sync.prepare();f.reset();const start=performance.now();let outcome,runs=0,maxSimulatedExecutionMillis=0;
  if(mode==='legacy')outcome=sync.apply(ticket,true);
  else {const jobs=Jobs.create(f.deps);jobs.accept(ticket,true);do{const before=f.deps.now();outcome=jobs.run();maxSimulatedExecutionMillis=Math.max(maxSimulatedExecutionMillis,f.deps.now()-before);runs++;if(runs>200)throw Error('worker did not terminate');}while(!['OK','PAUSED'].includes(outcome.status));}
  if(outcome.status!=='OK')throw Error(mode+': '+JSON.stringify(outcome));
  const calls=Object.values(f.counts).reduce((a,b)=>a+b,0)-f.counts.checkpointWrites; // checkpointWrites is a logical subset of sheet calls.
  result[mode]={...f.counts,totalInstrumentedCalls:calls,simulatedServiceMillis:calls*25,nodeElapsedMillis:Math.round((performance.now()-start)*100)/100,executions:runs||1,maxSimulatedExecutionMillis:mode==='legacy'?calls*25:maxSimulatedExecutionMillis};
 }
 return result;
}
if(require.main===module)console.log(JSON.stringify(run(),null,2));
module.exports={run};
