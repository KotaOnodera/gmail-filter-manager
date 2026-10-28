'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture,turn,key}=require('./client-fixture');
const ready={status:'READY',preparationId:'p',runId:'r',token:'t',snapshotId:'backup',summary:{CREATE:1,ERROR:0},entries:[{ruleKey:key,operation:'CREATE',after:{criteria:{from:'a'},action:{}}}],confirmation:{valid:true,serverNow:1,expiresAt:900001}};
for(const event of ['visibilitychange','pageshow'])test('F1 hidden preparation resumes saved status on '+event+' without restart',async()=>{
 const f=fixture();f.resolve('boot',{});await turn();f.click('all');await turn();f.resolve('prepareStart',{preparationId:'p',status:'PREPARING',phase:'BACKUP'});await turn();
 f.document.hidden=true;f.events.visibilitychange();const timer=[...f.timers.entries()].find(([,t])=>t.ms===5000);f.timers.delete(timer[0]);timer[1].fn();await turn();assert.equal(f.pending.filter(p=>p.command==='prepareStatus').length,0);
 f.document.hidden=false;if(event==='visibilitychange')f.events.visibilitychange();else f.windowEvents.pageshow({persisted:true});await turn();assert.equal(f.pending.filter(p=>p.command==='prepareStatus').length,1);f.resolve('prepareStatus',ready);await turn();assert.match(f.ids.main.textContent,/全部適用を確認/);assert.equal(f.pending.filter(p=>p.command==='prepareStart').length,1);assert.equal(f.pending.filter(p=>p.command==='apply').length,0);
});
for(const source of ['visibilitychange','timer'])test('F2 late '+source+' job response preserves newer import confirmation',async()=>{
 const f=fixture();const job={job:true,runId:'old-job',status:'WAITING',phase:'APPLY',updatedAt:1};f.resolve('boot',{filterJob:job});await turn();
 if(source==='visibilitychange')f.events.visibilitychange();else if(source==='timer')[...f.timers.values()].find(t=>t.ms===5000).fn();await turn();
 f.click('操作に戻る');await turn();f.click('import');await turn();f.resolve('importCheck',{count:1,total:1,token:'new-import',confirmation:{valid:true,serverNow:1,expiresAt:900001}});await turn();const content=f.ids.main.textContent;assert.match(content,/取り込/);
 for(const p of f.pending.filter(p=>p.command==='filterJobStatus'&&!p.done)){p.done=true;p.resolve(job);}await turn();assert.equal(f.ids.main.textContent,content);assert.equal(f.pending.filter(p=>p.command==='apply').length,0);
});
