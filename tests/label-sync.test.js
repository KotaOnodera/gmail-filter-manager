'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/Core'),S=require('../src/Sync');
const {harness,labels,key,base}=require('./helpers');
const lk='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const lr=(patch={})=>({LabelKey:lk,Name:'仕事',GmailLabelId:'Label_1',SyncedName:'仕事',...patch});
function fixture({newLabel=false}={}){const f={...base(),action:{addLabelIds:['Label_1']}};const r=C.importFilter(f,labels,key);r.UserLabelRef=JSON.stringify({key:lk,name:'仕事'});if(newLabel){r.UserLabel='新ラベル';r.UserLabelRef='';r.GmailFilterId='';r.OriginalJson='';r.OriginalRowJson='';}const h=harness({filters:newLabel?[]:[f],rows:[r],labelRows:[lr(newLabel?{Name:'新ラベル',GmailLabelId:''}:{Name:'経理'})]});return {...h,s:S.create(h.deps)};}
test('labels import preserves spreadsheet desired name and binds new imports without duplicates',()=>{
 const h=harness({labelRows:[lr({Name:'希望名'})]}),s=S.create(h.deps);const check=s.importAll(false);assert.equal(check.labelCount,0);s.importAll(true,check);assert.equal(h.labelRows[0].Name,'希望名');assert.equal(h.writes.length,0);
 const otherHarness=harness(),otherSync=S.create(otherHarness.deps);const p=otherSync.importAll(false);assert.equal(p.labelCount,1);otherSync.importAll(true,p);otherSync.importAll(true);assert.equal(otherHarness.labelRows.length,1);
});
test('rename uses the same id, follows filter reference and does not recreate unchanged filters',()=>{
 const h=fixture();const p=h.s.preview();assert.equal(p.entries.find(e=>e.kind==='LABEL').operation,'REPLACE');assert.equal(p.entries.find(e=>e.ruleKey===key).operation,'NOOP');
 const t=h.s.prepare();assert.equal(h.s.apply(t,true).status,'OK');assert.deepEqual(h.writes,[['labelRename','Label_1']]);assert.equal(h.rows[0].UserLabel,'経理');assert.equal(h.rows[0].GmailFilterId,'old');assert.equal(h.labelRows[0].SyncedName,'経理');
});
test('Gmail-side name drift is forcibly replaced by the spreadsheet name',()=>{
 const h=fixture();h.labelRows[0].Name='仕事';h.data.labels.find(l=>l.id==='Label_1').name='Gmail側変更';h.s.preview();assert.equal(h.s.apply(h.s.prepare(),true).status,'OK');assert.equal(h.data.labels.find(l=>l.id==='Label_1').name,'仕事');
});
test('selected filter adds its dependency and creates label before the filter',()=>{
 const h=fixture({newLabel:true});h.s.preview();const v=h.s.prepareView([key]);assert.equal(v.entries.some(e=>e.kind==='LABEL'&&e.operation==='CREATE'),true);assert.equal(v.ticket.selection.count,2);
 const result=h.s.apply(v.ticket,true);assert.equal(result.status,'OK');assert.deepEqual(h.writes.map(w=>w[0]),['labelCreate','create']);const id=h.labelRows[0].GmailLabelId;assert.equal(h.data.filters[0].action.addLabelIds[0],id);assert.equal(JSON.parse(h.rows[0].UserLabelRef).key,lk);
});
test('unselected invalid labels do not block a selected valid label, and explicit filter edits survive tracking',()=>{
 const h=fixture();h.labelRows.push(lr({LabelKey:other,Name:'INBOX',GmailLabelId:''}));h.rows[0].UserLabel='別名の希望';h.rows[0].Subject='manual';h.s.preview();assert.equal(h.s.apply(h.s.prepare(['label:'+lk]),true).status,'OK');assert.equal(h.rows[0].UserLabel,'別名の希望');assert.equal(h.rows[0].Subject,'manual');
});
test('lost label-create response is recovered once without duplicate creation',()=>{
 const h=fixture({newLabel:true});h.s.preview();h.faults.afterCreateLabel=true;const first=h.s.apply(h.s.prepare([key]),true);assert.equal(first.status,'RECOVERY_REQUIRED');assert.equal(h.data.filters.length,0);
 h.s.preview();assert.ok(h.labelRows[0].GmailLabelId);const next=h.s.apply(h.s.prepare([key]),true);assert.equal(next.status,'OK');assert.equal(h.writes.filter(w=>w[0]==='labelCreate').length,1);
});
test('lost rename response and failed label-id save recover through the journal',()=>{
 for(const fault of ['afterRenameLabel','updateLabelRow']){const h=fixture();h.s.preview();h.faults[fault]=true;assert.equal(h.s.apply(h.s.prepare(),true).status,'RECOVERY_REQUIRED');h.s.preview();assert.equal(h.s.apply(h.s.prepare(),true).status,'OK');assert.equal(h.writes.filter(w=>w[0]==='labelRename').length,1);}
});
test('label changes after approval stop all writes, while sorting alone is allowed',()=>{
 const h=fixture();h.s.preview();const t=h.s.prepare();h.labelRows[0].Name='edited';assert.throws(()=>h.s.apply(t,true),/変更/);assert.equal(h.writes.length,0);
});
test('deleted Gmail label is recreated and bound filters are updated to the new id',()=>{
 const h=fixture();h.data.labels=h.data.labels.filter(l=>l.id!=='Label_1');h.s.preview();assert.equal(h.s.apply(h.s.prepare(),true).status,'OK');assert.deepEqual(h.writes.map(w=>w[0]),['labelCreate','create','delete']);assert.notEqual(h.labelRows[0].GmailLabelId,'Label_1');assert.equal(h.rows[0].UserLabel,'経理');
});
test('a malformed reference on an unselected rule is displayed as an error without blocking a valid selection',()=>{
 const h=fixture();const bad=C.importFilter({...base(),id:'bad',criteria:{from:'bad@example.com'}},labels,other);bad.UserLabelRef='{bad';h.rows.push(bad);h.data.filters.push({...base(),id:'bad',criteria:{from:'bad@example.com'}});
 const p=h.s.preview();assert.equal(p.entries.find(e=>e.ruleKey===other).operation,'ERROR');assert.equal(h.s.apply(h.s.prepare(['label:'+lk]),true).status,'OK');
});
test('label-only rename keeps unselected sheet-only filter creation for later application',()=>{
 const h=fixture({newLabel:true});h.s.preview();const result=h.s.apply(h.s.prepare(['label:'+lk]),true);assert.equal(result.status,'OK');assert.equal(result.remaining,1);assert.equal(h.data.filters.length,0);assert.equal(h.writes.length,1);
});
test('sheet and Gmail order changes alone never invalidate a label confirmation',()=>{
 const h=fixture();h.labelRows.push(lr({LabelKey:other,Name:'extra',GmailLabelId:''}));h.s.preview();const t=h.s.prepare(['label:'+lk]);h.labelRows.reverse();h.data.labels.reverse();assert.equal(h.s.apply(t,true).status,'OK');
});
test('real Sheets adapter renames references without replacing the Gmail filter or losing existing data',()=>{
 const Sheets=require('../src/Sheets'),{fakeSheets}=require('./fake-sheets'),{hash}=require('./helpers');
 const h=fixture(),f=fakeSheets(),store=Sheets.create({...f,hash,uuid:()=>require('node:crypto').randomUUID()});store.setup();store.appendRows(h.rows);store.appendLabelRows(h.labelRows);
 const s=S.create({...h.deps,store});s.preview();assert.equal(s.apply(s.prepare(),true).status,'OK');assert.equal(store.readRows()[0].UserLabel,'経理');assert.equal(store.readRows()[0].GmailFilterId,'old');assert.equal(store.readLabelRows()[0].SyncedName,'経理');assert.deepEqual(h.writes,[['labelRename','Label_1']]);
});
