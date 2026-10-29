'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture,turn,key}=require('./client-fixture');
const job={job:true,runId:'run',status:'RUNNING',phase:'REFERENCES',updatedAt:1700000000000,filters:{planned:4,completed:0,remaining:4},labels:{planned:0,completed:0,remaining:0}};
async function boot(){const f=fixture();f.resolve('boot',{filterJob:job});await turn();return f;}
async function fire(f,ms){const entry=[...f.timers.entries()].find(([,t])=>t.ms===ms);assert.ok(entry,'scheduled '+ms);f.timers.delete(entry[0]);entry[1].fn();await turn();}
function reject(f,command){const p=f.pending.find(p=>p.command===command&&!p.done);assert.ok(p,'pending '+command);p.done=true;p.reject('temporary read failure');}
const noWrites=f=>assert.equal(f.pending.filter(p=>['apply','prepareStart','prepareRemaining','messagesApply'].includes(p.command)).length,0);
for(const status of ['PAUSED','OK'])test('actual Client recovers a failed progress read and renders '+status,async()=>{
 const f=await boot();await fire(f,5000);reject(f,'filterJobStatus');await turn();assert.match(f.ids.main.textContent,/最後に確認できた状態.*実行中/);assert.match(f.ids.main.childNodes[1].textContent,/確認できません/);
 await fire(f,5000);f.resolve('filterJobStatus',{...job,status,error:status==='PAUSED'?'停止理由':''});await turn();assert.match(f.ids.main.textContent,status==='PAUSED'?/処理を中断しています/:/承認した変更の反映を確認/);assert.equal(f.timers.size,0);noWrites(f);
});
test('progress reads back off and stop visibly after five retries; manual refresh restarts reads only',async()=>{
 const f=await boot();await fire(f,5000);reject(f,'filterJobStatus');await turn();
 for(const delay of [5000,10000,20000,20000,20000]){await fire(f,delay);reject(f,'filterJobStatus');await turn();}
 assert.equal(f.pending.filter(p=>p.command==='filterJobStatus').length,6);assert.equal(f.timers.size,0);assert.match(f.ids.main.textContent,/自動確認を停止/);
 f.click('保存済みの進捗を更新');await turn();f.resolve('filterJobStatus',{...job,status:'PAUSED'});await turn();assert.match(f.ids.main.textContent,/処理を中断しています/);noWrites(f);
});
test('timeout, duplicate refresh and stale read cannot overwrite another screen',async()=>{
 const f=await boot();await fire(f,5000);f.events.visibilitychange();f.events.visibilitychange();await turn();assert.equal(f.pending.filter(p=>p.command==='filterJobStatus').length,1);
 await fire(f,30000);assert.match(f.ids.main.textContent,/最後に確認できた状態/);
 f.click('操作に戻る');await turn();const content=f.ids.main.textContent;f.resolve('filterJobStatus',{...job,status:'OK'});await turn();assert.equal(f.ids.main.textContent,content);assert.equal(f.timers.size,0);noWrites(f);
});
test('hidden progress read pauses timers and returning resumes without duplicate reads',async()=>{
 const f=await boot();f.document.hidden=true;f.events.visibilitychange();await fire(f,5000);assert.equal(f.pending.filter(p=>p.command==='filterJobStatus').length,0);
 f.document.hidden=false;f.events.visibilitychange();f.windowEvents.pageshow({persisted:true});await turn();assert.equal(f.pending.filter(p=>p.command==='filterJobStatus').length,1);f.resolve('filterJobStatus',{...job,status:'PAUSED'});await turn();assert.match(f.ids.main.textContent,/処理を中断しています/);assert.equal(f.timers.size,0);noWrites(f);
});
test('manual progress refresh reuses an in-flight read across action epoch change',async()=>{
 const f=await boot();await fire(f,5000);f.click('保存済みの進捗を更新');await turn();assert.equal(f.pending.filter(p=>p.command==='filterJobStatus').length,1);f.resolve('filterJobStatus',{...job,status:'OK'});await turn();assert.match(f.ids.main.textContent,/承認した変更の反映を確認/);assert.equal(f.timers.size,0);noWrites(f);
});
async function confirmation(){const v={viewId:'v',action:'prepareStart',runId:'r'},f=fixture(new Map([['gfm.savedView.v1',JSON.stringify(v)]]));f.resolve('boot',{});await turn();f.resolve('viewGet',{status:'OK',action:'prepareStart',mode:'ALL',result:{runId:'r',status:'READY',token:'t',snapshotId:'b',summary:{CREATE:1,ERROR:0},entries:[{ruleKey:key,operation:'CREATE',after:{criteria:{from:'fixture'},action:{}}}],confirmation:{valid:true,serverNow:1,expiresAt:900001},_view:v}});await turn();return f;}
test('busy confirmation stays unchecked and retries read without applying',async()=>{
 const f=await confirmation();f.events.visibilitychange();f.resolve('confirmationStatus',{valid:false,reason:'BUSY',serverNow:1,message:'別の処理が実行中です。'});await turn();const check=f.ids.main.querySelectorAll('input').find(i=>i.type==='checkbox'&&!i.dataset.listErrors);assert.equal(check.disabled,true);await fire(f,5000);f.resolve('confirmationStatus',{valid:true,serverNow:2,expiresAt:900001});await turn();assert.equal(check.disabled,false);assert.equal(!!check.checked,false);assert.equal(f.ids.main.querySelectorAll('button').find(b=>b.textContent==='全部Gmailに適用').disabled,true);noWrites(f);
});
test('confirmation read failures have bounded retries and manual recovery clears old approval',async()=>{
 const f=await confirmation();f.events.visibilitychange();reject(f,'confirmationStatus');await turn();for(const delay of [5000,10000,20000,20000,20000]){await fire(f,delay);reject(f,'confirmationStatus');await turn();}
 assert.match(f.ids.main.textContent,/自動確認を停止/);assert.equal(f.timers.size,0);f.click('確認状態を更新');await turn();f.resolve('confirmationStatus',{valid:true,serverNow:2,expiresAt:900001});await turn();assert.equal(!!f.ids.main.querySelectorAll('input').find(i=>i.type==='checkbox'&&!i.dataset.listErrors).checked,false);noWrites(f);
});
test('a failed manual read of a terminal job keeps the last terminal state without promising automatic execution',async()=>{
 const f=fixture();f.resolve('boot',{filterJob:{...job,status:'OK'}});await turn();f.click('保存済みの進捗を更新');await turn();reject(f,'filterJobStatus');await turn();assert.match(f.ids.main.textContent,/最後に確認できた状態：完了/);assert.doesNotMatch(f.ids.main.textContent,/処理が続いている可能性|読取を再試行します/);assert.equal(f.timers.size,0);noWrites(f);
});
for(const event of ['visibilitychange','pageshow']){
 const show=f=>event==='visibilitychange'?f.events.visibilitychange():f.windowEvents.pageshow({persisted:true});
 test('confirmation '+event+' restarts exhausted read budget',async()=>{
  const f=await confirmation();f.events.visibilitychange();reject(f,'confirmationStatus');await turn();for(const delay of [5000,10000,20000,20000,20000]){await fire(f,delay);reject(f,'confirmationStatus');await turn();}assert.equal(f.timers.size,0);
  f.document.hidden=true;f.events.visibilitychange();f.document.hidden=false;show(f);await turn();reject(f,'confirmationStatus');await turn();await fire(f,5000);f.resolve('confirmationStatus',{valid:true,serverNow:2,expiresAt:900001});await turn();assert.equal(f.ids.main.querySelectorAll('input').find(i=>i.type==='checkbox'&&!i.dataset.listErrors).disabled,false);noWrites(f);
 });
 test('confirmation '+event+' adopts manual in-flight response after returning while busy',async()=>{
  const f=await confirmation();f.click('確認状態を更新');await turn();f.document.hidden=true;f.events.visibilitychange();f.document.hidden=false;show(f);await turn();assert.equal(f.pending.filter(p=>p.command==='confirmationStatus').length,1);
  f.resolve('confirmationStatus',{valid:true,serverNow:2,expiresAt:900001});await turn();const check=f.ids.main.querySelectorAll('input').find(i=>i.type==='checkbox'&&!i.dataset.listErrors);assert.equal(check.disabled,false);assert.equal(!!check.checked,false);assert.doesNotMatch(f.ids.main.textContent,/サーバーで確認しています/);noWrites(f);
 });
}
