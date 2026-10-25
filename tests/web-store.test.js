'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),S=require('../src/Sheets'),C=require('../src/Core'),{fakeSheets}=require('./fake-sheets'),{hash,key,base,labels}=require('./helpers');
function fixture(){const f=fakeSheets(),store=S.create({...f,hash,uuid:()=>key});store.setup();store.appendRows([C.importFilter(base(),labels,key)]);return {...f,store};}
test('history is read newest first with bounded pagination',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.store.history({runId:'run-'+i,command:'PREVIEW',result:'OK'});
  assert.deepEqual(f.store.readHistory(0,2).items.map(r=>r.RunId),['run-2','run-1']);assert.equal(f.store.readHistory(2,2).items[0].RunId,'run-0');assert.equal(f.store.readHistory(0,2).total,3);
});
test('history RunId filter never mixes another run into recovery results',()=>{const f=fixture();f.store.history({runId:'target',command:'APPLY',result:'OK'});f.store.history({runId:'other',command:'PREVIEW',result:'OK'});assert.deepEqual(f.store.readHistory(0,20,'target').items.map(r=>r.RunId),['target']);assert.equal(f.store.readHistory(0,20,'target').total,1);});

test('large selection receipts round-trip in verified chunks and are immutable',()=>{
  const f=fixture(),keys=Array.from({length:1200},()=>require('node:crypto').randomUUID()),state={filters:[],labels:[],forwarding:[]};f.store.backup(state,'scope-snapshot','now');f.store.writeScope('scope-snapshot',keys,'now');assert.deepEqual(f.store.readScope('scope-snapshot'),keys);assert.throws(()=>f.store.writeScope('scope-snapshot',[key],'now'),/保存済み/);
  const s=f.sheets.get('Backup'),scope=s.values.find(r=>r[2]==='SCOPE');scope[6]+='tampered';assert.throws(()=>f.store.readScope('scope-snapshot'),/ハッシュ/);
});
