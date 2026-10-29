'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const S=require('../src/Sheets'),C=require('../src/Core'),{fakeSheets}=require('./fake-sheets'),{hash,base,labels}=require('./helpers');
function fixture(){const f=fakeSheets(),store=S.create({...f,hash,uuid:crypto.randomUUID});store.setup();store.appendRows(Array.from({length:4},()=>C.importFilter(base(),labels,crypto.randomUUID())));return {...f,store};}
// The live advanced Sheets response omits the default zero sheetId. The
// production adapter must still find IDs; explicit foreign locations stay out.
test('reference batch finds first-sheet anchors when Sheets omits zero sheetId',()=>{
 const f=fixture(),rows=f.store.readRows(),search=f.api.Spreadsheets.DeveloperMetadata.search;
 f.api.Spreadsheets.DeveloperMetadata.search=(...args)=>{const r=search(...args);for(const m of r.matchedDeveloperMetadata)if(m.developerMetadata.location.dimensionRange.sheetId===0)delete m.developerMetadata.location.dimensionRange.sheetId;return r;};
 f.store.batchJobPatches(rows.map(r=>({key:r.RuleKey,reference:true,values:{UserLabel:r.UserLabel,UserLabelRef:'{"key":"22222222-2222-4222-8222-222222222222","name":"仕事"}'}})),rows,[]);
 assert.equal(f.store.readRows().filter(r=>r.UserLabelRef==='{"key":"22222222-2222-4222-8222-222222222222","name":"仕事"}').length,4);
 assert.equal(f.sheets.get('Filters').metadata.length,4);
});
test('omitted zero sheetId does not initialize duplicate row anchors',()=>{
 const f=fixture(),search=f.api.Spreadsheets.DeveloperMetadata.search;
 f.api.Spreadsheets.DeveloperMetadata.search=(...args)=>{const r=search(...args);for(const m of r.matchedDeveloperMetadata)if(m.developerMetadata.location.dimensionRange.sheetId===0)delete m.developerMetadata.location.dimensionRange.sheetId;return r;};
 f.store.ensureKeys(crypto.randomUUID);assert.equal(f.sheets.get('Filters').metadata.length,4);
});
test('identical anchors from prior initialization are coalesced only on the same physical row',()=>{
 const f=fixture(),s=f.sheets.get('Filters'),rows=f.store.readRows();s.getRange('2:2').addDeveloperMetadata('GFM',s.metadata[0].value);
 f.store.batchJobPatches([{key:rows[0].RuleKey,reference:true,values:{UserLabel:rows[0].UserLabel,UserLabelRef:'{"key":"same","name":"仕事"}'}}],rows,[]);
 assert.equal(f.store.readRows()[0].UserLabelRef,'{"key":"same","name":"仕事"}');
 s.getRange('3:3').addDeveloperMetadata('GFM',s.metadata[0].value);
 assert.throws(()=>f.store.batchJobPatches([{key:rows[0].RuleKey,values:{Result:'wrong'}}],rows,[]),/不一致|重複/);
});
test('missing anchor is a permanent safe precheck diagnostic',()=>{
 const f=fixture(),rows=f.store.readRows();f.sheets.get('Filters').metadata=[];
 assert.throws(()=>f.store.batchJobPatches([{key:rows[0].RuleKey,values:{Result:'ok'}}],rows,[]),e=>e.code==='GFM_REFERENCE_UPDATE'&&e.reference.code==='ANCHOR_INVALID'&&e.reference.stage==='PRECHECK'&&e.reference.retryable===false&&e.reference.count===1);
});
test('service error retains only safe write classification and supports receipt reconciliation',()=>{
 const f=fixture(),rows=f.store.readRows(),write=f.api.Spreadsheets.Values.batchUpdateByDataFilter;
 const patches=rows.map(r=>({key:r.RuleKey,reference:true,values:{UserLabel:r.UserLabel,UserLabelRef:'{"key":"safe","name":"仕事"}'}}));
 f.api.Spreadsheets.Values.batchUpdateByDataFilter=(...args)=>{write(...args);throw Object.assign(Error('secret@example.com private-filter-details'),{code:503});};
 assert.throws(()=>f.store.batchJobPatches(patches,rows,[]),e=>e.code==='GFM_REFERENCE_UPDATE'&&e.reference.code==='SERVICE_UNAVAILABLE'&&e.reference.stage==='WRITE'&&e.reference.retryable===true&&e.reference.serviceStatus===503&&!JSON.stringify(e.reference).includes('secret')&&!e.message.includes('secret'));
 f.api.Spreadsheets.Values.batchUpdateByDataFilter=write;f.store.batchJobPatches(patches,rows,[]);
 assert.equal(f.store.readRows().filter(r=>r.UserLabelRef==='{"key":"safe","name":"仕事"}').length,4);
});
test('readback mismatch is permanent and identifies the verification stage',()=>{
 const f=fixture(),rows=f.store.readRows();f.api.beforeAtomicWrite=()=>{f.sheets.get('Filters').values[1][C.columns.indexOf('Subject')]='external';};
 assert.throws(()=>f.store.batchJobPatches([{key:rows[0].RuleKey,values:{Result:'ok'}}],rows,[]),e=>e.reference?.code==='READBACK_MISMATCH'&&e.reference.stage==='READBACK'&&!e.reference.retryable);
});
test('reference replay accepts only approved old/new cells after a partial write',()=>{
 const f=fixture(),rows=f.store.readRows(),patches=rows.map(r=>({key:r.RuleKey,reference:true,values:{UserLabel:r.UserLabel,UserLabelRef:'{"key":"safe","name":"仕事"}'}})),write=f.api.Spreadsheets.Values.batchUpdateByDataFilter;
 f.api.Spreadsheets.Values.batchUpdateByDataFilter=body=>{write({...body,data:body.data.slice(0,2)});throw Object.assign(Error('lost'),{code:503});};
 assert.throws(()=>f.store.batchJobPatches(patches,rows,[]),e=>e.reference.retryable);
 const raw=f.sheets.get('Filters').values;[raw[1],raw[4]]=[raw[4],raw[1]];
 f.api.Spreadsheets.Values.batchUpdateByDataFilter=write;f.store.batchJobPatches(patches,rows,[]);
 assert.equal(f.store.readRows().filter(r=>r.UserLabelRef==='{"key":"safe","name":"仕事"}').length,4);
 raw[1][C.columns.indexOf('UserLabelRef')]='unapproved';
 assert.throws(()=>f.store.batchJobPatches(patches,rows,[]),e=>e.reference.code==='CONFIG_CHANGED'&&!e.reference.retryable);
});
for(const code of [400,403,429,503,undefined])test('reference service classification is bounded for '+code,()=>{
 const f=fixture(),rows=f.store.readRows();f.api.Spreadsheets.Values.batchUpdateByDataFilter=()=>{throw Object.assign(Error('arbitrary confidential content'),{code});};
 assert.throws(()=>f.store.batchJobPatches([{key:rows[0].RuleKey,values:{Result:'ok'}}],rows,[]),e=>e.reference.retryable===[429,503].includes(code)&&!e.message.includes('confidential')&&!JSON.stringify(e.reference).includes('confidential'));
});
test('reference readback flushes SpreadsheetApp cached reads once after the API batch',()=>{
 const f=fixture(),rows=f.store.readRows(),s=f.sheets.get('Filters'),getRange=s.getRange.bind(s),write=f.api.Spreadsheets.Values.batchUpdateByDataFilter,flush=f.app.flush;let cached=null;
 s.getRange=(...args)=>{const r=getRange(...args),get=r.getValues.bind(r);r.getValues=()=>cached?Array.from({length:r.n},(_,i)=>Array.from({length:r.m},(_,j)=>cached[r.r+i-1]?.[r.c+j-1]??'')):get();return r;};
 f.api.Spreadsheets.Values.batchUpdateByDataFilter=(...args)=>{cached=C.clone(s.values);return write(...args);};f.app.flush=()=>{cached=null;flush();};f.events.length=0;
 f.store.batchJobPatches(rows.map(r=>({key:r.RuleKey,reference:true,values:{UserLabel:'changed',UserLabelRef:'{"key":"safe","name":"changed"}'}})),rows,[]);
 assert.ok(f.store.readRows().every(r=>r.UserLabel==='changed'));assert.equal(f.events.filter(e=>e==='flush').length,1);
});
