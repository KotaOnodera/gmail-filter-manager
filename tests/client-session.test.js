'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(shared=new Map()){
 const jobs=[],busy=[],recover=[],errors=[],timers=new Map();let id=0;
 const ctx=vm.createContext({setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);},Date,Math});
 const file=path.join(__dirname,'../Session.html');if(fs.existsSync(file))vm.runInContext(fs.readFileSync(file,'utf8').replace(/^<script>\s*/,'').replace(/\s*<\/script>\s*$/,''),ctx);
 const storage={getItem:k=>shared.get(k)||null,setItem:(k,v)=>shared.set(k,v),removeItem:k=>shared.delete(k)};
 const d={request(command,input){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});jobs.push({command,input,resolve,reject});return promise;},onBusy:v=>busy.push(v),onError:e=>errors.push(e.message),onRecover:req=>recover.push(req),storage,isVisible:()=>true};
 const session=ctx.GFMClientSession?.create(d);return {session,jobs,busy,recover,errors,timers,shared};
}
test('returning while apply is unresolved releases controls and ignores its stale response',async()=>{
 const f=fixture();assert.ok(f.session,'session exists');let rendered=0;const old=f.session.run(async()=>{await f.session.call('apply',{token:'secret',runId:'r1'});rendered++;});assert.equal(f.jobs.length,1);
 f.session.resume();assert.equal(f.recover.length,1);assert.equal(f.busy.at(-1),false);assert.equal(f.recover[0].runId,'r1');assert.equal(f.recover[0].command,'apply');
 f.jobs[0].resolve({status:'OK'});await old;assert.equal(rendered,0);assert.equal(f.errors.length,0);
 const next=f.session.run(async()=>{await f.session.call('preview');rendered++;});f.jobs[1].resolve({});await next;assert.equal(rendered,1);
});
test('a discarded page restores only request metadata and never stores or replays approval tokens',()=>{
 const f=fixture();assert.ok(f.session);f.session.run(async()=>f.session.call('messagesApply',{token:'sensitive-approval',runId:'m1'}));const stored=[...f.shared.values()].join('');assert.ok(!stored.includes('sensitive-approval'));
 const restored=fixture(f.shared);assert.equal(restored.session.restore(),true);assert.equal(restored.recover[0].runId,'m1');assert.equal(restored.jobs.length,0);
});
test('watchdog recovers pending requests without calling the mutating command again',async()=>{
 const f=fixture();assert.ok(f.session);const old=f.session.run(async()=>f.session.call('import',{token:'approve'}));[...f.timers.values()][0]();assert.equal(f.recover.length,1);assert.equal(f.jobs.length,1);f.jobs[0].resolve({});await old;assert.equal(f.jobs.length,1);
});
test('late messagesStart response cannot launch the next scan after recovery or affect a newer action',async()=>{
 const f=fixture();assert.ok(f.session);const old=f.session.run(async()=>{const r=await f.session.call('messagesStart',{});await f.session.call('messagesScan',{runId:r.runId});});f.session.resume();
 const fresh=f.session.run(async()=>f.session.call('preview'));f.jobs[0].resolve({runId:'old'});await old;assert.equal(f.jobs.length,2);assert.equal(f.busy.at(-1),true);f.jobs[1].resolve({});await fresh;assert.equal(f.busy.at(-1),false);
});
