/* Pure planning for explicitly approved spreadsheet-authoritative execution. */
var GFMApplyPolicy=(function(){
  'use strict';
  const name='SHEET_AUTHORITATIVE';
  const core=()=>typeof module!=='undefined'?require('./Core'):GFMCore;
  const labels=()=>typeof module!=='undefined'?require('./Labels'):GFMLabels;
  function plan(rows,labelRows,live,keys){
    const C=core(),L=labels(),lp=L.plan(labelRows,live.labels),resolved=L.resolve(rows,labelRows,lp.labels,live.labels);
    return [...lp.entries,...C.plan(resolved.rows,{...live,labels:lp.labels},keys).map(e=>resolved.errors[e.ruleKey]?{...e,operation:'ERROR',errors:[resolved.errors[e.ruleKey]]}:e)];
  }
  function entry(approval,source,rows,labelRows,live){
    const C=core();
    if(source.cleanup||source.jobCleanup){const old=live.filters.find(f=>f.id===source.before.id);return {...C.clone(source),before:old||null,operation:old?'DELETE':'NOOP',matchedId:source.keepId};}
    const found=plan(rows,labelRows,live,approval.keys).find(e=>e.ruleKey===source.ruleKey);
    if(!found||found.operation==='ERROR')throw Error(found?.errors?.join(' / ')||'承認した対象行が見つかりません');
    return C.clone(found);
  }
  function report(approval,rows,labelRows,live){
    const keys=new Set(approval.keys),entries=plan(rows,labelRows,live,approval.keys).filter(e=>!['NOOP','REMOTE_ONLY'].includes(e.operation)||e.matchedId||e.operation==='REMOTE_ONLY').map(e=>({...e,inScope:!!e.ruleKey&&keys.has(e.ruleKey)}));
    return {entries,inScope:entries.filter(e=>e.inScope).length,outside:entries.filter(e=>!e.inScope&&e.operation!=='REMOTE_ONLY').length,remoteOnly:entries.filter(e=>e.operation==='REMOTE_ONLY').length,status:entries.length?'DIFFERENCES':'MATCH'};
  }
  return {name,plan,entry,report};
})();
if(typeof module!=='undefined')module.exports=GFMApplyPolicy;
