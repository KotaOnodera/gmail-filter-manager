'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const C=require('../src/Core'),S=require('../src/Sync');const {harness,key,base,labels}=require('./helpers');
test('GAS scripts load in reverse order without CommonJS or top-level service access',()=>{
  const context=vm.createContext({});for(const name of ['Menu','Gmail','Sync','Sheets','Core'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/'+name+'.js'),'utf8'),context);
  assert.equal(vm.runInContext('GFMSheets.schemas.Filters.length',context),C.columns.length);assert.equal(vm.runInContext('typeof onOpen',context),'function');
});
test('duplicate unbound desired rules cannot create repeated Gmail filters',()=>{
  const r=C.importFilter(base(),labels,key);r.GmailFilterId='';
  const second={...r,RuleKey:'22222222-2222-4222-8222-222222222222'};
  assert.ok(C.plan([r,second],{filters:[],labels,forwarding:[]}).every(e=>e.operation==='ERROR'));
});
test('1000 unchanged rules require a bounded number of Gmail reads',()=>{
  const filters=Array.from({length:1000},(_,i)=>({...base(),id:'f'+i,criteria:{subject:String(i)}}));
  const rows=filters.map(f=>C.importFilter(f,labels,require('node:crypto').randomUUID()));const h=harness({filters,rows});
  let reads=0;const read=h.deps.gmail.read;h.deps.gmail.read=()=>{reads++;return read();};
  const s=S.create(h.deps);s.preview();const ticket=s.prepare();reads=0;
  assert.equal(s.apply(ticket,true).status,'OK');assert.ok(reads<10,'read count '+reads);
});
test('boolean strings match the dropdown values when writing actual sheet rows',()=>{
  const {fakeSheets}=require('./fake-sheets'),Sheets=require('../src/Sheets'),{hash}=require('./helpers');const f=fakeSheets();const store=Sheets.create({...f,hash,uuid:()=>key});store.setup();store.appendRows([C.importFilter(base(),labels,key)]);
  const row=store.readRows()[0];assert.equal(row.Archive,'TRUE');assert.equal(row.Star,'FALSE');
});
