'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../src/Core'),S=require('../src/Sync'),Sheets=require('../src/Sheets');const {harness,key,base,labels,hash}=require('./helpers');const {fakeSheets}=require('./fake-sheets');
test('real controller and Sheets adapter import, edit, replace and verify serialized text',()=>{
  const f=fakeSheets(),h=harness({rows:[]});const store=Sheets.create({...f,hash,uuid:()=>crypto.randomUUID()});store.setup();
  const s=S.create({...h.deps,store});s.importAll(true);assert.equal(store.readRows().length,1);assert.equal(h.writes.length,0);
  const subject=C.columns.indexOf('Subject');f.sheets.get('Filters').values[1][subject]='=日本語の検索';
  s.preview();const ticket=s.prepare();assert.equal(s.apply(ticket,true).status,'OK');
  assert.equal(store.readRows()[0].GmailFilterId,'new-1');assert.equal(h.data.filters[0].criteria.subject,'=日本語の検索');
  assert.deepEqual(h.writes,[['create','new-1'],['delete','old']]);assert.equal(s.verify().ok,true);
  assert.throws(()=>s.apply(ticket,true),/プレビュー|承認/);
});
test('metadata-addressed writes skip editable cells and reject missing/deleted row anchors',()=>{
  const f=fakeSheets(),store=Sheets.create({...f,hash,uuid:()=>key});store.setup();store.appendRows([C.importFilter(base(),labels,key)]);
  const before=store.readRows()[0].From;store.updateRow(key,{GmailFilterId:'new'});assert.equal(store.readRows()[0].From,before);
  f.sheets.get('Filters').metadata=[];assert.throws(()=>store.updateRow(key,{GmailFilterId:'wrong'}),/メタデータ/);assert.equal(store.readRows()[0].GmailFilterId,'new');
});
