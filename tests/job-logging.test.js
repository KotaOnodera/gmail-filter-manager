'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{harness}=require('./helpers');
const L=fs.existsSync(require('node:path').join(__dirname,'../src/Logging.js'))?require('../src/Logging'):{};
function fixture(){const h=harness(),out=[];let locked=false;const d={...h.deps,withLogLock:fn=>{if(locked)throw Error('concurrent');locked=true;try{return fn();}finally{locked=false;}},sink:v=>out.push(v)};return {...h,d,out,logger:L.create?.(d)};}
test('logger bounds bytes, strips arbitrary strings and suppresses repeated errors across instances',()=>{
 const h=fixture();assert.ok(h.logger);h.logger.emit('run','RECOVERY','APPLY',{count:2,secret:'sender@example.com',query:'private'});L.create(h.d).emit('run','RECOVERY','APPLY',{});
 assert.equal(h.out.length,1);assert.ok(Buffer.byteLength(h.out[0])<=2048);assert.ok(!h.out[0].includes('sender')&&!h.out[0].includes('private'));h.logger.emit('x'.repeat(3000),'address@example.com','secret-label',{});assert.ok(h.out.every(v=>Buffer.byteLength(v)<=2048&&!v.includes('address')));
});
test('persistent daily and per-job caps apply across triggers and reset only on next UTC day',()=>{
 const h=fixture();assert.ok(h.logger);for(let n=0;n<30;n++)L.create(h.d).emit('job','RECOVERY','APPLY',{code:n});assert.equal(h.out.length,20);
 for(let n=0;n<120;n++)L.create(h.d).emit('run-'+n,'RECOVERY','APPLY',{});assert.equal(h.out.length,100);h.tick(86400000);h.logger.emit('tomorrow','RECOVERY','APPLY',{});assert.equal(h.out.length,101);
});
test('diagnostics default off and expire; logging failures remain isolated',()=>{
 const h=fixture();assert.ok(h.logger);h.logger.emit('job','TIMING','SHEET_READ',{elapsedMs:2});assert.equal(h.out.length,0);
 h.props.logDiagnosticsUntil=1000;h.logger.emit('job','TIMING','SHEET_READ',{elapsedMs:2});assert.equal(h.out.length,1);h.tick(1001);h.logger.emit('job','TIMING','DIFF_CHECK',{elapsedMs:3});assert.equal(h.out.length,1);
 h.d.sink=()=>{throw Error('Cloud unavailable');};assert.doesNotThrow(()=>L.create(h.d).emit('job','RECOVERY','APPLY',{}));h.d.withLogLock=()=>{throw Error('busy');};assert.doesNotThrow(()=>L.create(h.d).emit('job','RECOVERY','VERIFY',{}));
});
