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
