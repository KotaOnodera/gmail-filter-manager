'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const manifest=JSON.parse(read('appsscript.json'));
assert.equal(manifest.runtimeVersion,'V8');assert.equal(manifest.timeZone,'Asia/Tokyo');
assert.deepEqual(manifest.dependencies.enabledAdvancedServices,[{userSymbol:'Gmail',version:'v1',serviceId:'gmail'},{userSymbol:'Sheets',version:'v4',serviceId:'sheets'}]);
const suffixes=['gmail.settings.basic','gmail.labels','gmail.modify','spreadsheets','script.container.ui','script.scriptapp','userinfo.email'];
assert.deepEqual(manifest.oauthScopes.slice().sort(),suffixes.map(s=>'https://www.googleapis.com/auth/'+s).sort());
const sources=['Core','Labels','Sync','Sheets','Gmail','Messages','ApplyPolicy','Jobs','Logging','Runtime','Menu','Web'].map(s=>'src/'+s+'.js');
const context=vm.createContext({});
for(const source of sources.slice().reverse()){
  const code=read(source);new vm.Script(code,{filename:source}).runInContext(context);
  if(source!=='src/Gmail.js')assert.ok(!/\.Messages\./.test(code),'Message API only belongs in Gmail adapter');
  if(source==='src/Gmail.js')assert.deepEqual([...code.matchAll(/service\.Users\.Messages\.(\w+)/g)].map(m=>m[1]).sort(),['batchModify','list']);
  assert.ok(!/GmailApp|\.Threads\.|\.Labels\.remove|UrlFetchApp/.test(code),'Unexpected capability: '+source);
}
assert.equal(vm.runInContext('typeof GFM_runFilterJob',context),'function');
assert.ok(read('src/Runtime.js').includes("api.newTrigger('GFM_runFilterJob').timeBased().everyMinutes(1)"));
assert.equal(manifest.exceptionLogging,'NONE');assert.deepEqual(manifest.webapp,{access:'MYSELF',executeAs:'USER_ACCESSING'});
assert.equal(vm.runInContext('typeof onOpen',context),'function');
for(const callback of ['setup','import','preview','apply','verify','history','backup'])assert.equal(vm.runInContext('typeof GFM_'+callback,context),'function');
const ignore=read('.claspignore').split('\n').map(s=>s.trim()).filter(Boolean);
assert.deepEqual(ignore,['**/**','!appsscript.json',...sources.map(p=>'!'+p),'!Index.html','!Styles.html','!Session.html','!Client.html']);
const config=JSON.parse(read('.clasp.example.json'));assert.equal(config.rootDir,'.');assert.deepEqual(config.filePushOrder,sources);assert.equal(config.scriptId,'REPLACE_WITH_CONTAINER_BOUND_SCRIPT_ID');
const installerManifest=JSON.parse(read('installer/appsscript.json'));
assert.deepEqual(installerManifest.oauthScopes.slice().sort(),['drive','spreadsheets','script.projects','script.external_request','userinfo.email'].map(s=>'https://www.googleapis.com/auth/'+s).sort());
const installerContext=vm.createContext({});for(const p of ['src/Core.js','src/Labels.js','src/Sheets.js','installer/Installer.js'])new vm.Script(read(p),{filename:p}).runInContext(installerContext);
assert.equal(vm.runInContext('typeof GFM_install',installerContext),'function');
assert.equal(vm.runInContext('typeof GFM_updateInstalledCode',installerContext),'function');
assert.deepEqual(read('.clasp.installerignore').trim().split('\n'),['**/**','!Code.js','!appsscript.json']);
assert.equal(JSON.parse(read('.clasp.installer.example.json')).rootDir,'dist/installer');
for(const file of ['README.md','docs/setup.md','docs/schema.md','docs/recovery.md','docs/test-report.md','docs/design.md','docs/installer-design.md']){
  const text=read(file);assert.ok(text.length>100,file+' must contain useful documentation');
  for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
    const target=match[1];if(/^[a-z]+:|^#/.test(target))continue;
    assert.ok(fs.existsSync(path.resolve(root,path.dirname(file),target.split('#')[0])),'Broken link in '+file+': '+target);
  }
}
console.log('PASS: runtime + installer sources/manifests/scopes, menu and installer entry points, upload allowlists, documentation and links');
console.log('No network access, credentials, remote writes or deployment used by this check.');
