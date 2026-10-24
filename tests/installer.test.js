'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../src/Core'),{hash}=require('./helpers');
const I=fs.existsSync(path.join(__dirname,'../installer/Installer.js'))?require('../installer/Installer.js'):{};
function files(){return ['Core','Sync','Sheets','Gmail','Menu'].map(name=>({name,type:'SERVER_JS',source:fs.readFileSync(path.join(__dirname,'../src/'+name+'.js'),'utf8')})).concat({name:'appsscript',type:'JSON',source:fs.readFileSync(path.join(__dirname,'../appsscript.json'),'utf8')});}
function harness(){
  let saved=null,locked=false;const books=new Map(),projects=new Map(),events=[],faults={};let serial=0;
  const fail=k=>{if(faults[k]){delete faults[k];throw new Error(k+' failure');}};
  const deps={files:files(),hash,email:()=> 'owner@example.com',
    state:{get:()=>C.clone(saved),set:v=>{fail('save');saved=C.clone(v);}},
    withLock(fn){if(locked)throw new Error('実行中');locked=true;try{return fn();}finally{locked=false;}},
    books:{create(){fail('createBook');const id='book-'+(++serial);const b={getId:()=>id,getUrl:()=> 'https://docs.google.com/spreadsheets/d/'+id+'/edit',getOwner:()=>({getEmail:()=> 'owner@example.com'})};books.set(id,b);events.push('createBook');fail('afterBook');return b;},open(id){fail('openBook');if(!books.has(id))throw new Error('not found');return books.get(id);}},
    setup(book){events.push('setup:'+book.getId());fail('setup');},
    projects:{create(parentId){fail('createScript');const id='script-'+(++serial);projects.set(id,{scriptId:id,parentId,files:[]});events.push('createScript');fail('afterScript');return {scriptId:id,parentId};},get(id){if(!projects.has(id))throw new Error('not found');return C.clone(projects.get(id));},content(id){fail('content');return {files:C.clone(projects.get(id).files)};},put(id,files){fail('put');projects.get(id).files=C.clone(files);events.push('put');fail('afterPut');}},
  };
  return {deps,events,books,projects,faults,state:()=>saved,setState:v=>saved=v,setLocked:v=>locked=v};
}
test('installer creates spreadsheet, sheets and bound source once; repeat creates nothing',()=>{
  const h=harness(),i=I.create(h.deps),result=i.install();assert.equal(result.status,'COMPLETE');assert.equal(h.books.size,1);assert.equal(h.projects.size,1);assert.equal(h.events.filter(e=>e==='put').length,1);
  const p=h.projects.get(result.scriptId);assert.equal(p.parentId,result.spreadsheetId);assert.deepEqual(p.files,h.deps.files);assert.equal(i.install().spreadsheetId,result.spreadsheetId);assert.equal(h.books.size,1);assert.equal(h.events.filter(e=>e==='put').length,1);
});
test('installer setup failure resumes same spreadsheet without another create',()=>{
  const h=harness(),i=I.create(h.deps);h.faults.setup=true;assert.throws(()=>i.install(),/setup/);assert.equal(h.books.size,1);assert.equal(i.install().status,'COMPLETE');assert.equal(h.books.size,1);
});
test('missing saved spreadsheet never falls back to creation',()=>{
  const h=harness(),i=I.create(h.deps);i.install();h.books.clear();assert.throws(()=>i.install(),/not found/);assert.equal(h.events.filter(e=>e==='createBook').length,1);
});
test('lost spreadsheet create response blocks automatic duplication and supports audited recovery',()=>{
  const h=harness(),i=I.create(h.deps);h.faults.afterBook=true;assert.throws(()=>i.install(),/afterBook/);assert.throws(()=>i.install(),/不明|復旧/);assert.equal(h.books.size,1);
  i.recover({spreadsheetId:[...h.books.keys()][0]});assert.equal(i.install().status,'COMPLETE');assert.equal(h.books.size,1);
});
test('lost bound-script create response blocks duplicate projects, recover validates parent',()=>{
  const h=harness(),i=I.create(h.deps);h.faults.afterScript=true;assert.throws(()=>i.install(),/afterScript/);assert.throws(()=>i.install(),/不明|復旧/);assert.equal(h.projects.size,1);
  const id=[...h.projects.keys()][0];h.projects.get(id).parentId='other';assert.throws(()=>i.recover({scriptId:id}),/親|紐付/);h.projects.get(id).parentId=h.state().spreadsheetId;
  i.recover({scriptId:id});assert.equal(i.install().status,'COMPLETE');assert.equal(h.projects.size,1);
});
test('PUT failure or lost response resumes same project; readback recognizes successful write',()=>{
  for(const fault of ['put','afterPut']){const h=harness(),i=I.create(h.deps);h.faults[fault]=true;assert.throws(()=>i.install(),/failure/);assert.equal(i.install().status,'COMPLETE');assert.equal(h.books.size,1);assert.equal(h.projects.size,1);assert.equal(h.events.filter(e=>e==='put').length,1);}
});
test('manual source edits are not overwritten by resume or update',()=>{
  const h=harness(),i=I.create(h.deps);const result=i.install();h.projects.get(result.scriptId).files[0].source+='\n// manual edit';assert.throws(()=>i.install(),/変更|一致/);assert.throws(()=>i.update(),/変更|一致/);assert.equal(h.events.filter(e=>e==='put').length,1);
});
test('review P1: manual code after initial content-read failure is never trusted as upload baseline',()=>{
  const h=harness(),i=I.create(h.deps);h.faults.content=true;assert.throws(()=>i.install(),/content/);assert.equal(h.state().phase,'BOUND');
  const project=[...h.projects.values()][0];project.files=[{name:'Manual',type:'SERVER_JS',source:'function personalWork(){return 123;}'}];
  assert.throws(()=>i.install(),/変更|初期|空/);assert.equal(project.files[0].name,'Manual');assert.equal(h.events.filter(e=>e==='put').length,0);
});
test('review P1: uncertain create recovery refuses a project with manual sources',()=>{
  const h=harness(),i=I.create(h.deps);h.faults.afterScript=true;assert.throws(()=>i.install(),/afterScript/);
  const project=[...h.projects.values()][0];project.files=[{name:'Manual',type:'SERVER_JS',source:'function personalWork(){}'}];
  assert.throws(()=>i.recover({scriptId:project.scriptId}),/変更|初期|空/);assert.equal(project.files[0].name,'Manual');assert.equal(h.state().phase,'CREATING_SCRIPT');assert.equal(h.events.filter(e=>e==='put').length,0);
});
test('new packaged version needs explicit update and never recreates resources',()=>{
  const h=harness(),i=I.create(h.deps);i.install();h.deps.files[0].source+='\n// next release';assert.throws(()=>i.install(),/更新|バージョン/);assert.equal(i.update().status,'COMPLETE');assert.equal(h.books.size,1);assert.equal(h.projects.size,1);assert.equal(h.events.filter(e=>e==='put').length,2);
});
test('installer refuses another account and simultaneous execution',()=>{
  const h=harness(),i=I.create(h.deps);i.install();h.deps.email=()=> 'other@example.com';assert.throws(()=>i.install(),/所有者|実行者/);h.deps.email=()=> 'owner@example.com';h.setLocked(true);assert.throws(()=>i.install(),/実行中/);
});
test('checkpoint persistence failure happens before external creation',()=>{
  const h=harness(),i=I.create(h.deps);h.faults.save=true;assert.throws(()=>i.install(),/save/);assert.equal(h.events.length,0);
});
test('explicit not-created recovery clears only an uncertain create intent',()=>{
  const h=harness(),i=I.create(h.deps);h.faults.createBook=true;assert.throws(()=>i.install(),/createBook/);i.recover({notCreated:true});assert.equal(i.install().status,'COMPLETE');assert.throws(()=>i.recover({notCreated:true}),/中断|復旧/);
});
test('Apps Script API client uses fixed HTTPS host, scopes token to header, and sanitizes errors',()=>{
  let observed;const client=I.createProjects({token:()=> 'SECRET',fetch:(url,options)=>{observed={url,options};return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({scriptId:'id'})};}});
  client.create('book');assert.equal(observed.url,'https://script.googleapis.com/v1/projects');assert.equal(observed.options.headers.Authorization,'Bearer SECRET');assert.equal(JSON.parse(observed.options.payload).parentId,'book');
  const bad=I.createProjects({token:()=> 'SECRET',fetch:()=>({getResponseCode:()=>403,getContentText:()=> 'SECRET'})});assert.throws(()=>bad.create('book'),e=>e.message.includes('403')&&!e.message.includes('SECRET'));
});
