'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const buildPath=path.join(__dirname,'../scripts/build.js');
const B=fs.existsSync(buildPath)?require(buildPath):{};
test('build emits deterministic standalone GAS with exact current bound sources and separate permissions',()=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'gfm-build-'));
  try{
    B.build(path.resolve(__dirname,'..'),output);const first=fs.readFileSync(path.join(output,'Code.js'),'utf8');B.build(path.resolve(__dirname,'..'),output);assert.equal(fs.readFileSync(path.join(output,'Code.js'),'utf8'),first);
    const context=vm.createContext({});vm.runInContext(first,context);assert.equal(vm.runInContext('typeof GFM_install',context),'function');assert.equal(vm.runInContext('typeof GFM_updateInstalledCode',context),'function');
    const payload=JSON.parse(vm.runInContext('JSON.stringify(GFMInstallPayload)',context));assert.equal(payload.length,13);
    for(const name of ['Core','Labels','Sync','Sheets','Gmail','Messages','Runtime','Menu','Web'])assert.equal(payload.find(f=>f.name===name).source,fs.readFileSync(path.join(__dirname,'../src/'+name+'.js'),'utf8'));
    for(const name of ['Index','Styles','Client']){assert.equal(payload.find(f=>f.name===name).type,'HTML');assert.equal(payload.find(f=>f.name===name).source,fs.readFileSync(path.join(__dirname,'../'+name+'.html'),'utf8'));}
    const installer=JSON.parse(fs.readFileSync(path.join(output,'appsscript.json'),'utf8'));assert.ok(installer.oauthScopes.includes('https://www.googleapis.com/auth/script.projects'));assert.ok(installer.oauthScopes.every(s=>!s.includes('gmail')));
    const child=JSON.parse(payload.find(f=>f.name==='appsscript').source);assert.ok(child.oauthScopes.includes('https://www.googleapis.com/auth/gmail.modify'));assert.ok(child.oauthScopes.every(s=>!s.includes('script.projects')&&!s.includes('external_request')));
    assert.ok(!first.includes('/Users/')&&!first.includes('drive.google.com/drive/folders/'));
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});
test('generated GAS installer boots with real adapters, creates exactly five sheets and never needs Gmail services',()=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'gfm-boot-'));
  try{
    B.build(path.resolve(__dirname,'..'),output);const {fakeSheets}=require('./fake-sheets'),crypto=require('node:crypto'),f=fakeSheets();
    const props=new Map();let bookCreates=0,scriptCreates=0,project={scriptId:'script',parentId:'book',files:[]};
    f.book.getOwner=()=>({getEmail:()=> 'owner@example.com'});f.book.getUrl=()=> 'https://docs.google.com/spreadsheets/d/book/edit';
    f.app.create=()=>{bookCreates++;f.book.insertSheet('Sheet1');return f.book;};f.app.openById=id=>{assert.equal(id,'book');return f.book;};
    const context=vm.createContext({
      SpreadsheetApp:f.app,
      Session:{getEffectiveUser:()=>({getEmail:()=> 'owner@example.com'})},
      PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v)})},
      LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
      Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(a,s)=>[...crypto.createHash(a).update(s).digest()],getUuid:()=>crypto.randomUUID()},
      ScriptApp:{getOAuthToken:()=> 'synthetic-token'},
      UrlFetchApp:{fetch(url,options){
        assert.ok(url.startsWith('https://script.googleapis.com/v1/projects'));assert.equal(options.headers.Authorization,'Bearer synthetic-token');
        let body;
        if(options.method==='post'){scriptCreates++;body={scriptId:project.scriptId,parentId:project.parentId};}
        else if(options.method==='put'){project.files=JSON.parse(options.payload).files;body={files:project.files};}
        else body=url.endsWith('/content')?{files:project.files}:{scriptId:project.scriptId,parentId:project.parentId};
        return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(body)};
      }}
    });
    vm.runInContext(fs.readFileSync(path.join(output,'Code.js'),'utf8'),context);
    assert.equal(vm.runInContext('GFMInstaller.runtime().install().status',context),'COMPLETE');
    assert.deepEqual([...f.sheets.keys()],['Filters','Labels','Diff','History','Backup']);assert.equal(project.files.length,13);
    vm.runInContext('GFMInstaller.runtime().install()',context);assert.equal(bookCreates,1);assert.equal(scriptCreates,1);
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});
