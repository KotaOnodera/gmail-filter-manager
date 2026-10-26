'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');const C=require('../src/Core');
const L=fs.existsSync(require('node:path').join(__dirname,'../src/Labels.js'))?require('../src/Labels'):{};
const {labels,base,key}=require('./helpers');
const lk='22222222-2222-4222-8222-222222222222';
const row=(patch={})=>({LabelKey:lk,Name:'仕事',GmailLabelId:'Label_1',SyncedName:'仕事',...patch});
test('label plan creates missing labels, renames by immutable id and recreates deleted managed labels',()=>{
 assert.equal(L.plan([row({Name:'経理'})],labels).entries[0].operation,'REPLACE');
 const p=L.plan([row({GmailLabelId:'',Name:'請求書'})],labels);assert.equal(p.entries[0].operation,'CREATE');assert.equal(p.labels.find(l=>l.name==='請求書').id,'gfm-label:'+lk);
 assert.equal(L.plan([row({GmailLabelId:'deleted'})],labels.filter(l=>l.id!=='Label_1')).entries[0].operation,'CREATE');
});
test('label plan adopts a unique existing name only for an unbound label and rejects collisions or reserved names',()=>{
 assert.equal(L.plan([row({GmailLabelId:''})],labels).entries[0].matchedId,'Label_1');
 assert.equal(L.plan([row({GmailLabelId:'deleted'})],labels).entries[0].operation,'ERROR');
 assert.equal(L.plan([row(),row({LabelKey:'33333333-3333-4333-8333-333333333333'})],labels).entries.every(e=>e.operation==='ERROR'),true);
 assert.equal(L.plan([row({Name:'INBOX'})],labels).entries[0].operation,'ERROR');
 assert.equal(L.plan([row({Name:'new'})],[...labels,{id:'other',name:'new',type:'user'}]).entries[0].operation,'ERROR');
});
test('label references track rename by key while an explicit UserLabel edit selects a different label',()=>{
 const f=C.importFilter({...base(),action:{addLabelIds:['Label_1']}},labels,key);
 const lr=row({Name:'経理'}),state=L.plan([lr],labels).labels;
 const refs=L.resolve([f],[lr],state,labels);assert.equal(refs.rows[0].UserLabel,'経理');assert.equal(refs.refs[key].key,lk);
 f.UserLabelRef=JSON.stringify({key:lk,name:'仕事'});
 assert.equal(L.resolve([f],[lr],state,labels).rows[0].UserLabel,'経理');
 f.UserLabel='other';const second=row({LabelKey:'33333333-3333-4333-8333-333333333333',Name:'other',GmailLabelId:'other'});
 assert.equal(L.resolve([f],[lr,second],[...state,{id:'other',name:'other',type:'user'}],labels).refs[key].key,second.LabelKey);
 f.UserLabel='';assert.equal(L.resolve([f],[lr],state,labels).refs[key],null);
});
test('hierarchical label names remain explicit desired full paths',()=>{
 const rows=[row({Name:'新/親',GmailLabelId:'parent'}),row({LabelKey:'33333333-3333-4333-8333-333333333333',Name:'旧/親/子',GmailLabelId:'child'})];
 const p=L.plan(rows,[{id:'parent',name:'旧/親',type:'user'},{id:'child',name:'旧/親/子',type:'user'}]);
 assert.equal(p.entries.find(e=>e.before.id==='parent').operation,'REPLACE');assert.equal(p.entries.find(e=>e.before.id==='child').operation,'NOOP');
});
