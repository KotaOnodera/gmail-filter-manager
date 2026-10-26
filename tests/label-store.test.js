'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../src/Core'),Sheets=require('../src/Sheets'),Gmail=require('../src/Gmail');
const {fakeSheets}=require('./fake-sheets'),{hash,labels,key,base}=require('./helpers');
const lk='22222222-2222-4222-8222-222222222222';
function env(){const f=fakeSheets();return {...f,store:Sheets.create({...f,hash,uuid:()=>crypto.randomUUID()})};}
test('label schema migration preserves old Filters values and is idempotent',()=>{
 const e=env();e.store.setup();const s=e.sheets.get('Filters');
 s.values[0]=C.columns.filter(k=>k!=='UserLabelRef');const r=C.importFilter(base(),labels,key);s.values.push(s.values[0].map(k=>r[k]??''));
 const old=s.values[1].slice();e.sheets.delete('Labels');e.store.ensureLabelSchema();
 assert.deepEqual(s.values[1].slice(0,old.length),old);assert.equal(s.values[0].at(-1),'UserLabelRef');
 assert.ok(e.sheets.has('Labels'));e.store.ensureLabelSchema();assert.equal(e.sheets.size,5);
});
test('label record updates and filter name tracking follow metadata when sorted, and preserve literal text',()=>{
 const e=env();e.store.setup();e.store.appendRows([C.importFilter({...base(),action:{addLabelIds:['Label_1']}},labels,key)]);
 e.store.appendLabelRows([{LabelKey:lk,Name:'仕事',GmailLabelId:'Label_1'},{LabelKey:'33333333-3333-4333-8333-333333333333',Name:'other'}]);
 const s=e.sheets.get('Labels');[s.values[1],s.values[2]]=[s.values[2],s.values[1]];
 e.store.updateLabelRow(lk,{GmailLabelId:'new',Result:'ok'});assert.equal(e.store.readLabelRows().find(r=>r.LabelKey===lk).GmailLabelId,'new');
 const before=e.store.readRows()[0];e.store.setFilterLabel(key,before,{name:'=literal',key:lk});const after=e.store.readRows()[0];assert.equal(after.UserLabel,'=literal');assert.equal(JSON.parse(after.UserLabelRef).key,lk);
 assert.throws(()=>e.store.setFilterLabel(key,before,{name:'wrong',key:lk}),/変更|一致/);
});
test('Gmail label adapter creates and patches only name, never deletes a label',()=>{
 const calls=[];const g=Gmail.create({Users:{Labels:{create:(b,u)=>{calls.push(['create',b,u]);return {id:'new',...b};},patch:(b,u,id)=>{calls.push(['patch',b,u,id]);return {id,...b};}}}});
 g.createLabel('new');g.renameLabel('existing','renamed');assert.deepEqual(calls,[['create',{name:'new',labelListVisibility:'labelShow',messageListVisibility:'show'},'me'],['patch',{name:'renamed'},'me','existing']]);
});
