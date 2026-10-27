'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
// Minimal DOM for checking the real client bootstrap/recovery branch, not a second rendering implementation.
class Element{
 constructor(tag){this.tagName=tag;this.childNodes=[];this.dataset={};this.disabled=false;this.events={};this._text='';}
 append(...nodes){this.childNodes.push(...nodes);}replaceChildren(...nodes){this.childNodes=nodes;this._text='';}setAttribute(){}removeAttribute(){}focus(){}addEventListener(name,fn){this.events[name]=fn;}
 get textContent(){return this._text+this.childNodes.map(n=>n.textContent).join('');}set textContent(v){this._text=String(v);this.childNodes=[];}get isConnected(){return true;}
 cloneNode(deep){const e=new Element(this.tagName);e.dataset={...this.dataset};e._text=this._text;if(deep)e.childNodes=this.childNodes.map(n=>n.cloneNode(true));return e;}
 querySelectorAll(selector){const out=[];for(const n of this.childNodes){if(selector==='[data-command]'&&n.dataset.command||selector==='[data-page]'&&n.dataset.page||selector.split(',').includes(n.tagName))out.push(n);out.push(...n.querySelectorAll(selector));}return out;}
}
test('review: restored request does not discard boot metadata linking to a saved message job',async()=>{
 const ids=Object.fromEntries(['main','notice','error','busy'].map(id=>[id,new Element(id==='main'?'main':'div')]));
 const home=new Element('button');home.dataset.command='messages';home.textContent='既存メールを整理する';ids.main.append(home);
 const root=new Element('body');root.append(...Object.values(ids));const pending=[];
 const storage={getItem:()=>JSON.stringify({requestId:'lost-start',command:'messagesStart',runId:''}),setItem(){},removeItem(){}};
 const context=vm.createContext({document:{hidden:false,getElementById:id=>ids[id],createElement:tag=>new Element(tag),querySelectorAll:s=>root.querySelectorAll(s),addEventListener(){}},window:{GFM_LOCAL:true,sessionStorage:storage,scrollTo(){},addEventListener(){}},setTimeout:()=>1,clearTimeout(){},fetch(url,input){const command=JSON.parse(input.body).command;let resolve;const promise=new Promise(yes=>{resolve=yes;});pending.push({command,resolve:data=>resolve({json:async()=>({data})})});return promise;},Date,Math});
 for(const file of ['Session','Client'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../'+file+'.html'),'utf8').replace(/^<script>\s*/,'').replace(/\s*<\/script>\s*$/,''),context);
 pending.find(r=>r.command==='boot').resolve({messageJob:{runId:'saved-job',status:'SCANNING'},unseenOutcome:null});await new Promise(setImmediate);
 pending.find(r=>r.command==='resume').resolve({status:'ERROR',action:'messagesStart',runId:'',error:'start interrupted'});await new Promise(setImmediate);
 assert.ok(ids.main.textContent.includes('保存済みの既存メール処理を確認'),'the saved job remains reachable after failed start recovery');
});
function bootFixture(){
 const ids=Object.fromEntries(['main','notice','error','busy'].map(id=>[id,new Element(id==='main'?'main':'div')])),root=new Element('body');root.append(...Object.values(ids));const pending=[];
 const context=vm.createContext({document:{hidden:false,getElementById:id=>ids[id],createElement:tag=>new Element(tag),querySelectorAll:s=>root.querySelectorAll(s),addEventListener(){}},window:{GFM_LOCAL:true,sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},scrollTo(){},addEventListener(){}},setTimeout:()=>1,clearTimeout(){},fetch(url,input){const {command,input:payload}=JSON.parse(input.body);let resolve;const promise=new Promise(yes=>{resolve=yes;});pending.push({command,input:payload,resolve:data=>resolve({json:async()=>({data})})});return promise;},Date,Math});
 for(const file of ['Session','Client'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../'+file+'.html'),'utf8').replace(/^<script>\s*/,'').replace(/\s*<\/script>\s*$/,''),context);
 return {ids,pending};
}
const savedJob=status=>({job:true,runId:'older-job',status,phase:'VERIFY',updatedAt:10,filters:{planned:1,completed:1,remaining:0},labels:{planned:0,completed:0,remaining:0}});
for(const status of ['PREPARING','READY'])test('reload restores newer '+status+' preparation ahead of an older terminal job',async()=>{
 const f=bootFixture();f.pending.find(r=>r.command==='boot').resolve({filterJob:savedJob('OK'),filterPreparation:{preparationId:'new-preparation',status,updatedAt:20},unseenOutcome:null});await new Promise(setImmediate);
 const request=f.pending.find(r=>r.command==='prepareStatus');assert.ok(request,'new preparation must remain reachable from boot');assert.equal(request.input.preparationId,'new-preparation');
 request.resolve(status==='READY'?{preparationId:'new-preparation',status,runId:'new-run',summary:{CREATE:1},entries:[],labels:[],token:'temporary',snapshotId:'snapshot'}:{preparationId:'new-preparation',status,phase:'BACKUP'});await new Promise(setImmediate);
 assert.ok(f.ids.main.textContent.includes(status==='READY'?'全部適用を確認':'適用内容の確認を準備'));assert.equal(f.pending.filter(r=>r.command==='apply').length,0);
 const back=f.ids.main.querySelectorAll('button').find(b=>b.textContent==='操作に戻る');if(back){await back.events.click();await new Promise(setImmediate);assert.ok(f.ids.main.textContent.includes('保存済みの適用確認を開く'));}
});
test('active accepted job retains priority over older preparation and clears only its own approval',async()=>{
 const f=bootFixture();f.pending.find(r=>r.command==='boot').resolve({filterJob:savedJob('WAITING'),filterPreparation:{preparationId:'different-preparation',status:'READY',updatedAt:5},unseenOutcome:null});await new Promise(setImmediate);
 assert.ok(f.ids.main.textContent.includes('フィルター適用の進捗'));assert.equal(f.pending.filter(r=>r.command==='prepareStatus').length,0);
 const back=f.ids.main.querySelectorAll('button').find(b=>b.textContent==='操作に戻る');await back.events.click();await new Promise(setImmediate);assert.ok(f.ids.main.textContent.includes('保存済みの適用確認を開く'),'viewing another job must not erase saved preparation');
});
for(const target of ['PREPARING','READY'])test('real continuation '+target+' restores when recovery updates its paused source after preparation creation',async()=>{
 const C=require('../src/Core'),Sync=require('../src/Sync'),Jobs=require('../src/Jobs'),Web=require('../src/Web'),Sheets=require('../src/Sheets'),{fakeSheets}=require('./fake-sheets'),{harness,hash}=require('./helpers'),crypto=require('node:crypto');
 const h=harness(),sheetEnv=fakeSheets(),store=Sheets.create({...sheetEnv,hash,uuid:()=>crypto.randomUUID()});store.setup();store.appendRows(h.rows);const raw=sheetEnv.sheets.get('Filters').values,subject=C.columns.indexOf('Subject');raw[1][subject]='approved';
 const deps={...h.deps,store,bookId:'book',withLock:fn=>fn(),scheduler:{ensure(){},exists:()=>true,clear(){}}};deps.jobs=Jobs.create(deps);deps.controller=Sync.create(deps);const web=Web.create(deps),pv=web.dispatch('preview'),approval=web.dispatch('prepare',{runId:pv.runId});web.dispatch('apply',{token:approval.token});
 const create=deps.gmail.create;deps.gmail.create=value=>{const fresh=create(value);raw[1][subject]='edited for continuation';return fresh;};for(let n=0;n<20&&deps.jobs.status().status!=='PAUSED';n++)deps.jobs.run();assert.equal(deps.jobs.status().status,'PAUSED');
 h.tick(100);const p=web.dispatch('prepareRemaining',{runId:pv.runId});assert.equal(h.props.filterPreparation.createdAt,100);h.tick(100);deps.jobs.run();assert.equal(h.props.filterJob.updatedAt,200);
 if(target==='READY'){h.tick(100);deps.jobs.run();h.tick(100);deps.jobs.run();}
 const boot=web.dispatch('boot');assert.equal(boot.filterPreparation.status,target);assert.equal(boot.filterPreparation.previousRunId,pv.runId);assert.ok(boot.filterPreparation.createdAt<boot.filterJob.updatedAt);const before=h.writes.length,f=bootFixture();f.pending.find(r=>r.command==='boot').resolve(boot);await new Promise(setImmediate);
 const request=f.pending.find(r=>r.command==='prepareStatus');assert.ok(request,'source recovery timestamp must not hide its continuation preparation');assert.equal(request.input.preparationId,p.preparationId);request.resolve(web.dispatch('prepareStatus',request.input));await new Promise(setImmediate);
 assert.ok(f.ids.main.textContent.includes(target==='READY'?'選択した変更を適用':'適用内容の確認を準備'));assert.equal(f.pending.filter(r=>r.command==='apply').length,0);assert.equal(h.writes.length,before);
});
