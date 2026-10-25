'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),S=require('../src/Sheets'),C=require('../src/Core'),{fakeSheets}=require('./fake-sheets'),{hash,key,base,labels}=require('./helpers');
function fixture(){const f=fakeSheets(),store=S.create({...f,hash,uuid:()=>key});store.setup();store.appendRows([C.importFilter(base(),labels,key)]);return {...f,store};}
test('editable patch follows metadata after sort and preserves system fields and literal text',()=>{
  const f=fixture(),second='22222222-2222-4222-8222-222222222222';f.store.appendRows([C.importFilter({...base(),id:'second'},labels,second)]);
  f.api.beforeAtomicWrite=()=>{const s=f.sheets.get('Filters');[s.values[1],s.values[2]]=[s.values[2],s.values[1]];};
  f.store.updateEditable(key,{NameOrNote:'=1+2',HasAttachment:'FALSE',SizeBytes:'0'});
  const row=f.store.readRows().find(r=>r.RuleKey===key);assert.equal(row.NameOrNote,'=1+2');assert.equal(row.GmailFilterId,'old');assert.equal(row.HasAttachment,'FALSE');assert.equal(row.SizeBytes,'0');assert.equal(f.store.readRows().find(r=>r.RuleKey===second).NameOrNote,'');
});
test('editable patch rejects system columns before writing',()=>{
  const f=fixture();assert.throws(()=>f.store.updateEditable(key,{GmailFilterId:'hijack'}),/編集可能/);assert.equal(f.store.readRows()[0].GmailFilterId,'old');
});
test('history is read newest first with bounded pagination',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.store.history({runId:'run-'+i,command:'PREVIEW',result:'OK'});
  assert.deepEqual(f.store.readHistory(0,2).items.map(r=>r.RunId),['run-2','run-1']);assert.equal(f.store.readHistory(2,2).items[0].RunId,'run-0');assert.equal(f.store.readHistory(0,2).total,3);
});
test('history RunId filter never mixes another run into recovery results',()=>{const f=fixture();f.store.history({runId:'target',command:'APPLY',result:'OK'});f.store.history({runId:'other',command:'PREVIEW',result:'OK'});assert.deepEqual(f.store.readHistory(0,20,'target').items.map(r=>r.RunId),['target']);assert.equal(f.store.readHistory(0,20,'target').total,1);});
