'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,turn,key}=require('./client-fixture');
const locator={viewId:'ready-confirmation',runId:'saved-run',action:'prepareStart'};
const metadata={valid:true,reason:'VALID',serverNow:1700000000000,expiresAt:1700000900000};
function saved(mode='ALL'){
 const result={runId:'saved-run',preparationId:'prepared-once',status:'READY',token:'approval',snapshotId:'backup-once',summary:{CREATE:1},entries:[{ruleKey:key,operation:'CREATE',after:{criteria:{subject:'saved change'},action:{}}}],confirmation:metadata,_view:locator};
 if(mode==='SELECTED')result.selection={count:1};
 return {status:'OK',...locator,mode,keys:mode==='SELECTED'?[key]:[],sourceView:{viewId:'original-preview',action:'preview',runId:'saved-run'},result};
}
// Drive the real Client/Session timers, not a rewritten deadline implementation.
function clock(){let now=0,serial=0;const timers=new Map();return {
 options:{setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),performance:{now:()=>now}},
 async advance(ms){const until=now+ms;for(;;){const next=[...timers].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await turn();}now=until;await turn();}
};}
async function restored(){const time=clock(),f=fixture(new Map([['gfm.savedView.v1',JSON.stringify(locator)]]),time.options);f.resolve('boot',{});await turn();return {f,time};}
const text=f=>f.ids.main.textContent;
const apply=f=>f.ids.main.querySelectorAll('button').find(b=>/^(全部Gmailに適用|選択した変更をGmailに適用)$/.test(b.textContent));
const approval=f=>f.ids.main.querySelectorAll('section').find(n=>n.className==='sticky-actions').querySelectorAll('input')[0];
function noWrites(f){assert.equal(f.pending.filter(p=>['prepare','prepareStart','prepareRemaining','reconfirm','apply','messagesApply'].includes(p.command)).length,0);}
for(const mode of ['ALL','SELECTED'])test('actual Client/Session renders a valid '+mode+' saved confirmation arriving at 12 seconds without repeating preparation',async()=>{
 const {f,time}=await restored();await time.advance(12000);f.resolve('viewGet',saved(mode));await turn();
 assert.match(text(f),mode==='ALL'?/全部適用を確認/:/選択した変更を適用/);assert.match(text(f),/saved change/);assert.match(text(f),/バックアップID: backup-once/);
 assert.equal(!!approval(f).checked,false);assert.equal(apply(f).disabled,true);assert.doesNotMatch(text(f),/タイムアウト/);noWrites(f);
 if(mode==='SELECTED'){f.click('差分に戻る');await turn();assert.deepEqual(f.pending.filter(p=>p.command==='viewGet').map(p=>p.input.viewId),['ready-confirmation','original-preview']);}
});
test('saved read stays pending through 29999ms, times out at 30000ms, and retries only the same locator',async()=>{
 const {f,time}=await restored();await time.advance(29999);assert.doesNotMatch(text(f),/タイムアウト/);assert.equal(f.ids.main.querySelectorAll('button').some(b=>b.textContent==='取得し直す'),false);
 await time.advance(1);assert.match(text(f),/タイムアウト/);assert.ok(f.ids.main.querySelectorAll('button').some(b=>b.textContent==='取得し直す'));
 f.resolve('viewGet',saved());await turn();assert.match(text(f),/保存した画面を再確認/,'late success after timeout cannot restore the old screen');
 f.click('取得し直す');await turn();assert.deepEqual(f.pending.filter(p=>p.command==='viewGet').map(p=>p.input),[locator,locator]);noWrites(f);
 f.resolve('viewGet',saved('SELECTED'));await turn();assert.match(text(f),/選択した変更を適用/);assert.equal(!!approval(f).checked,false);assert.equal(apply(f).disabled,true);noWrites(f);
});
test('navigation fences a valid delayed saved response before the read deadline',async()=>{
 const {f,time}=await restored();await time.advance(12000);f.click('import');f.resolve('importCheck',{count:1,total:1,token:'new'});await turn();f.resolve('viewGet',saved());await turn();assert.match(text(f),/インポートを確認/);assert.doesNotMatch(text(f),/saved change/);noWrites(f);
});
test('status recovery accepts a 12-second read and fetches its confirmation without replaying the request',async()=>{
 const time=clock(),f=fixture(new Map([['gfm.pendingRequest.v1',JSON.stringify({requestId:'lost',command:'prepareStart',runId:'saved-run'})]]),time.options);f.resolve('boot',{});await turn();await time.advance(12000);
 f.resolve('resume',{status:'DONE',action:'prepareStart',viewId:locator.viewId,runId:locator.runId});await turn();await time.advance(12000);f.resolve('viewGet',saved());await turn();assert.match(text(f),/全部適用を確認/);assert.equal(!!approval(f).checked,false);assert.equal(apply(f).disabled,true);noWrites(f);
});
test('confirmation status validation remains unchecked and disabled during a 12-second read and fails closed at 30 seconds',async()=>{
 const {f,time}=await restored();f.resolve('viewGet',saved());await turn();const check=approval(f);check.checked=true;check.events.change();assert.equal(apply(f).disabled,false);
 f.document.hidden=true;f.events.visibilitychange();f.document.hidden=false;f.events.visibilitychange();await time.advance(12000);assert.equal(!!check.checked,false);assert.equal(check.disabled,true);assert.equal(apply(f).disabled,true);
 f.resolve('confirmationStatus',metadata);await turn();assert.equal(check.disabled,false);assert.equal(!!check.checked,false);assert.equal(apply(f).disabled,true);
 f.document.hidden=true;f.events.visibilitychange();f.document.hidden=false;f.events.visibilitychange();await time.advance(29999);assert.equal(check.disabled,true);await time.advance(1);assert.match(text(f),/確認状態を取得できません/);assert.equal(apply(f).disabled,true);
 f.resolve('confirmationStatus',metadata);await turn();assert.equal(check.disabled,true);assert.equal(apply(f).disabled,true);noWrites(f);
});
