/* Opt-in diagnostics; allowlisted numeric summaries only. Never serialize service
 * errors or arbitrary inputs. A separate script lock makes quotas cross-trigger. */
var GFMLogging=(function(){
  'use strict';
  function create(d){
    const events=new Set(['RECOVERY','REVIEW_REQUIRED','SLOW','TIMING']),phases=new Set(['SHEET_READ','DIFF_CHECK','BACKUP_CHECK','REFERENCES','APPLY','GMAIL_UPDATE','VERIFY']);
    function emit(runId,event,phase,values){
      try{
        if(d.enabled&&!d.enabled())return false;
        if(!events.has(event)||!phases.has(phase))return false;
        if(event==='TIMING'&&!(Number(d.state.get('logDiagnosticsUntil'))>d.now()))return false;
        return d.withLogLock(()=>{
          const day=new Date(d.now()).toISOString().slice(0,10),daily=d.state.get('logDaily')||{};
          const key='logJob:'+d.hash(String(runId)).slice(0,32),job=d.state.get(key)||{count:0,seen:[]};
          const safe={};for(const k of ['count','completed','remaining','elapsedMs','code'])if(Number.isFinite(values?.[k]))safe[k]=Math.max(0,Math.min(1e12,values[k]));
          const signature=d.hash(JSON.stringify({event,phase,code:safe.code})).slice(0,16);
          if((daily.day===day?daily.count:0)>=100||job.count>=20||job.seen.includes(signature))return false;
          const record={runId:/^[a-zA-Z0-9_-]{1,128}$/.test(String(runId))?String(runId):d.hash(String(runId)).slice(0,32),event,phase,...safe};
          const text=JSON.stringify(record);if((d.byteLength?d.byteLength(text):text.length*3)>2048)return false;
          // Reserve both caps before output. A lost response consumes quota and
          // can suppress an entry, but can never cause excess Cloud output.
          d.state.set('logDaily',{day,count:(daily.day===day?daily.count:0)+1});
          d.state.set(key,{count:job.count+1,seen:job.seen.concat(signature)});
          d.sink(text);return true;
        });
      }catch(_){return false;}
    }
    return {emit};
  }
  return {create};
})();
if(typeof module!=='undefined')module.exports=GFMLogging;
