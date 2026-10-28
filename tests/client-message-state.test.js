'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,turn,key}=require('./client-fixture');
const entry={key,title:'saved target',eligible:true,errors:[],ignored:['転送'],count:2,action:{addLabelIds:['Label_1'],removeLabelIds:['INBOX','UNREAD']}};
const run={kind:'MESSAGES',runId:'m',status:'SCANNING',total:2,completed:0,remaining:2,uncertain:0,error:'',scanRule:0,ruleCount:1,revision:2,entries:[entry],labels:[]};
const text=f=>f.ids.main.textContent;
async function opened(status=run,storage=new Map()) {const f=fixture(storage);f.resolve('boot',{messageJob:status});await turn();f.click('保存済みの既存メール処理を確認');f.resolve('messagesStatus',status);await turn();return f;}
test('saved scan waits for manual continuation; an outstanding batch is shown only until its response',async()=>{
 const f=await opened();assert.match(text(f),/ここまで検索済み・続行待ち/);assert.match(text(f),/総対象件数は未確定/);assert.match(text(f),/検索済み 延べ2件/);assert.doesNotMatch(text(f),/検索しています/);assert.equal(f.pending.filter(p=>p.command==='messagesScan').length,0);
 f.click('対象メールの検索を続ける');await turn();assert.match(text(f),/検索リクエストの応答を待っています/);assert.equal(f.ids.main.querySelectorAll('button').filter(b=>/検索を続ける|再試行/.test(b.textContent)).length,0);
 f.resolve('messagesScan',{...run,total:4,remaining:4,revision:3});await turn();assert.match(text(f),/ここまで検索済み・続行待ち/);assert.match(text(f),/検索済み 延べ4件/);assert.equal(f.pending.filter(p=>p.command==='messagesScan').length,1);assert.equal(f.pending.filter(p=>p.command==='messagesApply').length,0);
});
test('search failure shows reason and retries the saved run without starting or approving a new one',async()=>{
 const f=await opened({...run,status:'SCAN_FAILED',error:'Gmail quota reached'});assert.match(text(f),/検索に失敗/);assert.match(text(f),/Gmail quota reached/);assert.doesNotMatch(text(f),/検索しています/);
 f.click('検索を再試行');await turn();assert.equal(f.pending.find(p=>p.command==='messagesScan').input.runId,'m');f.resolve('messagesScan',{...run,status:'READY',total:3,remaining:3});await turn();assert.match(text(f),/検索が完了/);assert.match(text(f),/対象 延べ3件/);assert.equal(f.pending.filter(p=>['messagesStart','messagesApply'].includes(p.command)).length,0);
});
test('zero-result search completes and requires an unchecked explicit confirmation',async()=>{
 const f=await opened({...run,status:'READY',total:0,remaining:0,entries:[{...entry,count:0}]});assert.match(text(f),/検索が完了/);assert.match(text(f),/対象 延べ0件/);assert.doesNotMatch(text(f),/総対象件数は未確定/);
 f.click('既存メールへの適用を確認');f.resolve('messagesPrepare',{...run,status:'READY',total:0,remaining:0,token:'approval',entries:[{...entry,count:0}]});await turn();assert.match(text(f),/既存メールへの適用を確認/);const apply=f.ids.main.querySelectorAll('button').find(b=>b.textContent==='確認した既存メールを処理する');assert.equal(apply.disabled,true);assert.equal(f.pending.filter(p=>p.command==='messagesApply').length,0);
});
test('unresolved lost scan response stays uncertain until DONE and ignores its late callback',async()=>{
 const f=await opened();f.click('対象メールの検索を続ける');await turn();const original=f.pending.find(p=>p.command==='messagesScan');f.watchdog();f.resolve('resume',{status:'UNKNOWN',action:'messagesScan',runId:'m',messageJob:run});await turn();assert.match(text(f),/検索リクエストの完了を確認できません/);assert.match(text(f),/総対象件数は未確定/);assert.equal(f.pending.filter(p=>p.command==='messagesStatus').length,1,'unknown must not be treated as a completed request');
 f.click('状況を更新');f.resolve('resume',{status:'DONE',action:'messagesScan',runId:'m',messageJob:{...run,total:4,remaining:4}});await turn();f.resolve('messagesStatus',{...run,total:4,remaining:4});await turn();assert.match(text(f),/ここまで検索済み・続行待ち/);original.resolve({...run,status:'READY',total:99});await turn();assert.match(text(f),/検索済み 延べ4件/);assert.equal(f.pending.filter(p=>p.command==='messagesScan').length,1);
});
test('reload restores saved scan targets instead of reopening a stale list; no scan or apply is replayed',async()=>{
 const f=await opened();
 const reload=fixture(f.storage);reload.resolve('boot',{messageJob:run});await turn();assert.ok(reload.pending.some(p=>p.command==='messagesStatus'));reload.resolve('messagesStatus',run);await turn();assert.match(text(reload),/ここまで検索済み・続行待ち/);assert.match(text(reload),/saved target/);assert.equal(reload.pending.filter(p=>['messagesList','messagesScan','messagesApply','viewGet'].includes(p.command)).length,0);
});
test('reloaded outstanding scan checks the same request and never assumes saved SCANNING is active execution',async()=>{
 const storage=new Map([['gfm.pendingRequest.v1',JSON.stringify({requestId:'lost-scan',command:'messagesScan',runId:'m'})]]),f=fixture(storage);
 f.resolve('boot',{messageJob:run});f.resolve('resume',{status:'RUNNING',action:'messagesScan',runId:'m',messageJob:run});await turn();assert.match(text(f),/検索リクエストの完了を確認しています/);assert.match(text(f),/検索済み 延べ2件/);assert.doesNotMatch(text(f),/サーバーで処理中/);assert.equal(f.pending.filter(p=>['messagesScan','messagesApply'].includes(p.command)).length,0);
});
test('saved status retrieval has a deadline and retry reads the same run; a newer action fences old reads',async()=>{
 const f=await opened(),reload=fixture(f.storage);reload.resolve('boot',{messageJob:run});await turn();const timeout=[...reload.timers.values()].find(t=>t.ms===30000);assert.ok(timeout);timeout.fn();await turn();assert.match(text(reload),/取得し直す/);
 reload.click('取得し直す');await turn();assert.equal(reload.pending.filter(p=>p.command==='messagesStatus').length,2);assert.equal(reload.pending.filter(p=>p.command==='preview').length,0);
 reload.resolve('messagesStatus',run);reload.resolve('messagesStatus',run);await turn();assert.match(text(reload),/続行待ち/);
 const stale=fixture(f.storage);stale.resolve('boot',{messageJob:run});await turn();stale.click('import');stale.resolve('importCheck',{count:1,total:1,token:'new'});await turn();stale.resolve('messagesStatus',run);await turn();assert.match(text(stale),/インポートを確認/);assert.doesNotMatch(text(stale),/続行待ち/);
});
test('cancelled incomplete search keeps its saved count provisional and offers no continuation',async()=>{
 const f=await opened({...run,status:'CANCELLED',totalKnown:false});assert.match(text(f),/処理を中止/);assert.match(text(f),/検索済み 延べ2件/);assert.match(text(f),/総対象件数は未確定/);assert.equal(f.ids.main.querySelectorAll('button').filter(b=>/検索を続ける|再試行|適用を確認/.test(b.textContent)).length,0);
});
test('starting a search renders the actual first outstanding scan, then zero READY without mutation',async()=>{
 const f=fixture();f.resolve('boot',{});await turn();f.click('messages');f.resolve('messagesList',{entries:[{...entry,count:undefined}],labels:[]});await turn();f.click('適用できる全件のメールを検索');f.resolve('messagesStart',{...run,total:0,remaining:0});await turn();assert.match(text(f),/検索リクエストの応答を待っています/);assert.equal(f.pending.filter(p=>p.command==='messagesScan').length,1);f.resolve('messagesScan',{...run,status:'READY',total:0,remaining:0});await turn();assert.match(text(f),/検索が完了/);assert.equal(f.pending.filter(p=>p.command==='messagesApply').length,0);
});
test('timed-out saved status retries its original run even when boot reports a different latest job',async()=>{
 const storage=new Map([['gfm.savedView.v1',JSON.stringify({viewId:'',action:'messagesStatus',runId:'original-run'})]]),f=fixture(storage);
 f.resolve('boot',{messageJob:{...run,runId:'new-run'}});await turn();assert.equal(f.pending.find(p=>p.command==='messagesStatus').input.runId,'original-run');
 [...f.timers.values()].find(t=>t.ms===30000).fn();await turn();f.click('取得し直す');await turn();
 assert.deepEqual(f.pending.filter(p=>p.command==='messagesStatus').map(p=>p.input.runId),['original-run','original-run']);
 f.resolve('messagesStatus',{...run,runId:'original-run'});f.resolve('messagesStatus',{...run,runId:'original-run'});await turn();assert.match(text(f),/実行ID: original-run/);assert.doesNotMatch(text(f),/実行ID: new-run/);assert.equal(f.pending.filter(p=>['messagesStart','messagesScan','messagesApply'].includes(p.command)).length,0);
});
