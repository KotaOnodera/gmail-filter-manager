'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../src/Core'),S=require('../src/Sync'),Sheets=require('../src/Sheets');const {harness,key,base,labels,hash}=require('./helpers');const {fakeSheets}=require('./fake-sheets');
function twoRules(){
  const filters=[{...base(),id:'old1',criteria:{subject:'one'}},{...base(),id:'old2',criteria:{subject:'two'}}];
  const rows=filters.map((f,i)=>{const r=C.importFilter(f,labels,i===0?key:'22222222-2222-4222-8222-222222222222');r.Subject+=' changed';return r;});
  return harness({rows,filters});
}
test('review P1: an edit during first create never reaches a later stale operation',()=>{
  const h=twoRules(),s=S.create(h.deps);s.preview();const ticket=s.prepare(),create=h.deps.gmail.create;
  h.deps.gmail.create=f=>{const result=create(f);h.rows[1].Subject='edited during create';return result;};
  assert.notEqual(s.apply(ticket,true).status,'OK');
  assert.equal(h.writes.filter(w=>w[0]==='create').length,1);
  assert.ok(h.data.filters.some(f=>f.id==='old2'));assert.ok(h.data.filters.some(f=>f.id==='old1'));
});
test('review P1: unrelated Gmail drift during create stops before deleting old or later rules',()=>{
  const h=twoRules(),s=S.create(h.deps);s.preview();const ticket=s.prepare(),create=h.deps.gmail.create;
  h.deps.gmail.create=f=>{const result=create(f);h.data.filters[1].criteria.subject='concurrent remote';return result;};
  assert.notEqual(s.apply(ticket,true).status,'OK');assert.deepEqual(h.writes,[['create','new-1']]);
});
test('review P2: a sort at lookup/write boundary never corrupts another RuleKey',()=>{
  const f=fakeSheets(),store=Sheets.create({...f,hash,uuid:()=>crypto.randomUUID()});store.setup();const second='22222222-2222-4222-8222-222222222222';
  store.appendRows([C.importFilter(base(),labels,key),C.importFilter({...base(),id:'other'},labels,second)]);
  const swap=()=>{[f.sheets.get('Filters').values[1],f.sheets.get('Filters').values[2]]=[f.sheets.get('Filters').values[2],f.sheets.get('Filters').values[1]];};
  let sorted=false;const sortOnce=()=>{if(!sorted){sorted=true;swap();}};
  const make=f.app.newRichTextValue;f.app.newRichTextValue=()=>{sortOnce();return make();};
  f.beforeAtomicWrite=sortOnce;
  // New adapter uses an atomic metadata-addressed write; the old adapter is interrupted at its literal write.
  if(f.api)f.api.beforeAtomicWrite=sortOnce;
  let error;try{store.updateRow(key,{GmailFilterId:'new',Result:'OK'});}catch(e){error=e;}
  const actual=store.readRows();assert.equal(actual.find(r=>r.RuleKey===second).GmailFilterId,'other');
  assert.equal(actual.find(r=>r.RuleKey===key).GmailFilterId,'new');assert.equal(error,undefined);
});
