var GFMWeb = (function () {
  'use strict';
  function create(d) {
    const now=()=>d.now();
    function page(input){return {offset:Math.max(0,Math.min(100000,Number.isSafeInteger(input.offset)?input.offset:0)),limit:20};}
    function confirmation(kind,ticket){const token=d.uuid();d.state.set(kind,{token,ticket,at:now(),actor:d.actor(),bookId:d.bookId});return token;}
    function checked(kind,token){const c=d.state.get(kind);if(!c||!token||c.token!==token||c.actor!==d.actor()||c.bookId!==d.bookId)throw new Error('確認が無効です。もう一度確認してください');if(now()-c.at>15*60*1000)throw new Error('確認の期限が切れました。もう一度確認してください');return c;}
    const viewActions=new Set(['preview','prepare','prepareStart','prepareRemaining','importCheck','messagesList','messagesPrepare']);
    const viewTTL=24*60*60*1000;
    const C=typeof module!=='undefined'?require('./Core'):GFMCore,L=typeof module!=='undefined'?require('./Labels'):GFMLabels;
    const same=(a,b)=>C.stable(a)===C.stable(b);
    function configHash(rows,labels){return d.hash(C.stable({filters:C.config(rows||d.store.readRows()),labels:L.config(labels||d.store.readLabelRows())}));}
    function owned(h){return h&&h.actor===d.actor()&&h.bookId===d.bookId;}
    function locator(h){return {viewId:h.viewId,runId:h.runId,action:h.action};}
    function pruneViews(){
      const ids=d.state.get('webViewIndex')||[],keep=[];
      for(const id of ids){const h=d.state.get('webView:'+id);if(!owned(h)){keep.push(id);continue;}if(now()-h.at<=viewTTL){keep.push(id);continue;}d.store.removeWebView(h.pointer);d.state.remove('webView:'+id);}
      while(keep.length>=12){const id=keep.shift(),h=d.state.get('webView:'+id);if(owned(h)){d.store.removeWebView(h.pointer);d.state.remove('webView:'+id);}}
      d.state.set('webViewIndex',keep);return keep;
    }
    function saveView(action,input,result){
      if(!viewActions.has(action)||result.job)return result;
      const ids=pruneViews(),viewId=d.uuid(),h={viewId,action,runId:result.runId||input.runId||'',preparationId:result.preparationId||'',at:now(),actor:d.actor(),bookId:d.bookId};
      let sourceView=null;
      if(['prepare','prepareStart'].includes(action)&&input.runId){
        const sourceId=input._sourceViewId||ids.slice().reverse().find(id=>{const v=d.state.get('webView:'+id);return owned(v)&&v.action==='preview'&&v.runId===input.runId;});
        const source=sourceId&&d.state.get('webView:'+sourceId);
        if(owned(source)&&source.action==='preview'&&source.runId===input.runId){
          sourceView=locator(source);
          if(Array.isArray(input.keys)){const saved=d.store.readWebView(source.pointer);if(!same(saved.keys,input.keys))updateView({...sourceView,keys:input.keys,revision:saved.revision+1});}
        }
      }
      const data={viewId,action,runId:h.runId,sourceView,preparationId:h.preparationId,actor:h.actor,bookId:h.bookId,mode:input._viewMode==='SELECTED'||input.keys!==undefined?'SELECTED':'ALL',keys:input.keys||[],revision:0,result,config:configHash()};
      h.pointer=d.store.writeWebView(viewId,data);d.state.set('webView:'+viewId,h);ids.push(viewId);d.state.set('webViewIndex',ids);return {...result,_view:locator(h)};
    }
    function readyPreparation(preparationId){
      const p=d.jobs.prepareStatus(preparationId);if(p.status!=='READY')return p;
      if(!same(p.ticket,d.state.get('prepared'))||now()-p.ticket.preparedAt>15*60*1000)throw Error('確認が失効しました。差分を再取得してください');
      const captured=d.store.readJobData(p.ticket.jobApproval);
      if(configHash(captured.rows,captured.labelRows)!==configHash())throw Error('確認後に設定が変更されています。差分を再取得してください');
      const old=d.state.get('webApproval');
      if(old&&old.ticket.runId===p.ticket.runId){checked('webApproval',old.token);return {...p,...p.ticket,token:old.token};}
      return {...p,...p.ticket,token:confirmation('webApproval',p.ticket)};
    }
    function loadView(input){
      const h=typeof input.viewId==='string'&&input.viewId.length<=128?d.state.get('webView:'+input.viewId):null;
      if(!owned(h))return {status:'NOT_FOUND'};
      if(input.runId&&input.runId!==h.runId)throw Error('保存した表示の実行IDが一致しません');
      const job=d.state.get('filterJob');if(d.jobs&&owned(job)&&(h.preparationId&&job.ticket?.jobApproval?.runId===h.preparationId||h.action==='prepare'&&h.runId===job.runId))return {status:'JOB',result:d.jobs.status(job.runId)};
      if(now()-h.at>viewTTL)return {status:'EXPIRED',action:h.action};
      try{
        const v=d.store.readWebView(h.pointer);
        if(!owned(v)||v.viewId!==h.viewId||v.action!==h.action||v.runId!==h.runId||v.preparationId!==h.preparationId)throw Error('保存した表示の対応が一致しません');
        let result=v.result;
        if(h.preparationId){const current=d.state.get('filterPreparation');if(!owned(current)||current.preparationId!==h.preparationId)throw Error('別の確認準備が開始されています');result=readyPreparation(h.preparationId);}
        const kind=h.action==='importCheck'?'webImport':h.action==='messagesPrepare'?'webMessageApproval':h.action==='prepare'||result.status==='READY'&&h.preparationId?'webApproval':'';
        if(kind){const approval=checked(kind,result.token);if(kind==='webApproval'&&!same(approval.ticket,d.state.get('prepared')))throw Error('確認が失効しました');}
        if(h.action==='preview'&&d.state.get('preview')?.runId!==h.runId)throw Error('別の差分確認が行われています');
        if(!h.preparationId&&v.config!==configHash())throw Error('設定が変更されています。再確認してください');
        if(h.action==='messagesPrepare'&&d.state.get('messageJob')&&d.state.get('messageJob').runId!==result.runId)throw Error('既存メールの実行IDが変更されています');
        const validKeys=new Set((result.entries||[]).filter(e=>(e.ruleKey||e.key)&&e.operation!=='ERROR'&&e.eligible!==false&&!e.errors?.length).map(e=>e.ruleKey||e.key));
        if(!Array.isArray(v.keys)||v.keys.some(k=>!validKeys.has(k))&&(!h.preparationId||result.status==='READY'))throw Error('保存した選択対象が一致しません');
        return {status:'OK',...locator(h),sourceView:v.sourceView||null,mode:v.mode,keys:v.keys,revision:v.revision,result:{...result,_view:locator(h)}};
      }catch(e){return {status:'INVALID',action:h.action,error:'保存した画面を使用できません。再確認または取得し直してください。 '+String(e.message||e).slice(0,200)};}
    }
    function updateView(input){
      const restored=loadView(input);if(restored.status!=='OK')return restored;
      const h=d.state.get('webView:'+input.viewId),v=d.store.readWebView(h.pointer);
      if(!['preview','messagesList'].includes(h.action))throw Error('この操作段階の選択は変更できません');
      if(!Number.isSafeInteger(input.revision)||input.revision<=v.revision)return {status:'STALE'};
      const valid=new Set((v.result.entries||[]).filter(e=>(e.ruleKey||e.key)&&e.operation!=='ERROR'&&e.eligible!==false&&!e.errors?.length).map(e=>e.ruleKey||e.key));
      if(!Array.isArray(input.keys)||input.keys.length>10000||new Set(input.keys).size!==input.keys.length||input.keys.some(k=>!valid.has(k)))throw Error('選択対象が一致しません');
      const pointer=d.store.writeWebView(h.viewId,{...v,keys:input.keys,revision:input.revision});d.state.set('webView:'+h.viewId,{...h,pointer});d.store.removeWebView(h.pointer);return {status:'OK'};
    }
    const trackedActions=new Set(['importCheck','import','preview','prepare','prepareStart','prepareRemaining','apply','messagesList','messagesStart','messagesScan','messagesPrepare','messagesApply','messagesCancel']);
    function saveActivity(activity){
      const index=d.state.get('webActivityIndex')||[];if(!Array.isArray(index))throw Error('実行状況の索引が破損しています');
      const key='webActivity:'+activity.requestId;d.state.set(key,activity);
      if(!index.includes(activity.requestId)){index.push(activity.requestId);const removed=index.splice(0,Math.max(0,index.length-32));d.state.set('webActivityIndex',index);removed.forEach(id=>d.state.remove('webActivity:'+id));}
    }
    function tracked(action,input,fn){
      const requestId=input._requestId;
      if(!trackedActions.has(action)||typeof requestId!=='string'||!requestId||requestId.length>128)return saveView(action,input,fn());
      const approval=action==='apply'?d.state.get('webApproval'):action==='messagesApply'?d.state.get('webMessageApproval'):null;
      const activity={requestId,action,runId:input.runId||approval?.ticket?.runId||'',status:'RUNNING',at:now(),actor:d.actor(),bookId:d.bookId};
      saveActivity(activity);
      try{
        const result=saveView(action,input,fn()),record={...activity,status:'DONE',runId:result?.runId||activity.runId,finishedAt:now(),preparationId:result?.preparationId||'',viewId:result?._view?.viewId||''};
        if(action==='apply'||action==='import')record.result={...result,error:result.error?String(result.error).slice(0,1500):undefined};
        saveActivity(record);return result;
      }catch(err){saveActivity({...activity,status:'ERROR',error:String(err.message||err).slice(0,1500),finishedAt:now()});throw err;}
    }
    function resume(requestId){
      if(typeof requestId!=='string'||!requestId||requestId.length>128)throw Error('実行状況の確認IDが不正です');
      const a=d.state.get('webActivity:'+requestId)||d.state.get('webActivity');
      if(!a||a.requestId!==requestId||a.actor!==d.actor()||a.bookId!==d.bookId)return {status:'NOT_FOUND',requestId};
      const result={requestId,viewId:a.viewId||'',preparationId:a.preparationId||'',action:a.action,runId:a.runId,status:a.status,error:a.error||'',result:a.result||null};
      const outcome=d.state.get('webOutcome');
      if(a.action==='apply'&&d.jobs&&a.runId&&d.state.get('filterJob')?.runId===a.runId){result.status='DONE';result.result=d.jobs.status(a.runId);return result;}
      if(a.action==='apply'&&outcome?.actor===d.actor()&&outcome.bookId===d.bookId&&outcome.result.runId===a.runId&&outcome.result.status!=='UNKNOWN'){result.status='DONE';result.result=outcome.result;}
      if(a.action.startsWith('messages')){
        const j=d.state.get('messageJob');if(j&&(j.runId===a.runId||a.action==='messagesStart'&&j.requestId===requestId)){result.runId=j.runId;result.messageJob={runId:j.runId,status:j.status,total:j.total,completed:j.completed,remaining:j.total-j.completed,uncertain:j.pending?.count||0,error:j.error||''};}
      }
      if(result.status==='RUNNING'&&now()-a.at>7*60*1000)result.status='UNKNOWN';
      return result;
    }
    function dispatch(action,input) {
      input=input||{};if(typeof input!=='object'||Array.isArray(input))throw new Error('入力形式が不正です');
      // Read only small owner-scoped checkpoints; status must remain available while a write owns the lock.
      if(action==='resume')return resume(input.requestId);
      if(action==='viewGet')return loadView(input);
      if(action==='viewUpdate')return d.withLock(()=>updateView(input));
      if(action==='boot'){const last=d.state.get('webOutcome');return {filterJob:d.jobs&&d.state.get('filterJob')?d.jobs.status():null,filterPreparation:(()=>{const p=d.state.get('filterPreparation');return p?{preparationId:p.preparationId,previousRunId:p.previousRunId||'',runId:p.ticket?.runId||'',status:p.status,phase:p.phase,createdAt:p.createdAt,updatedAt:p.updatedAt}:null;})(),messageJob:d.state.get('messageJob'),unseenOutcome:last&&!last.acknowledged&&last.actor===d.actor()&&last.bookId===d.bookId?last.result:null};}
      if(action==='filterJobStatus'&&d.jobs)return d.jobs.status(input.runId);
      if(action==='prepareStatus'&&d.jobs)return readyPreparation(input.preparationId);
      return d.withLock(()=>tracked(action,input,()=>{
        if(action==='prepareRemaining'&&d.jobs){d.state.remove('webApproval');return d.jobs.prepareRemaining(input.runId);}
        if(action==='prepareStart'&&d.jobs){d.state.remove('webApproval');return d.jobs.prepareStart(input);}

        if(action==='messagesList')return d.messages.list();
        if(action==='messagesStart')return d.messages.start(input.keys===undefined?null:input.keys,input._requestId);
        if(action==='messagesScan')return d.messages.scan(input.runId);
        if(action==='messagesStatus')return d.messages.status(input.runId);
        if(action==='messagesCancel'){d.state.remove('webMessageApproval');return d.messages.cancel(input.runId);}
        if(action==='messagesPrepare'){
          const ticket=d.messages.prepare(input.runId);return {...d.messages.status(input.runId),token:confirmation('webMessageApproval',ticket)};
        }
        if(action==='messagesApply'){
          const receipt=d.state.get('webMessageReceipt');
          if(receipt&&receipt.token===input.token&&receipt.actor===d.actor()&&receipt.bookId===d.bookId)return d.messages.status(receipt.runId);
          const c=checked('webMessageApproval',input.token);d.state.remove('webMessageApproval');
          d.state.set('webMessageReceipt',{token:input.token,runId:c.ticket.runId,actor:d.actor(),bookId:d.bookId});
          return d.messages.apply(c.ticket);
        }
        if(action==='importCheck'){const ticket=d.controller.importAll(false);return {count:ticket.count,total:ticket.total,labelCount:ticket.labelCount,labelTotal:ticket.labelTotal,token:confirmation('webImport',ticket)};}
        if(action==='import'){const c=checked('webImport',input.token);d.state.remove('webImport');return d.controller.importAll(true,c.ticket);}
        if(action==='preview'){d.state.remove('webApproval');const result=d.controller.preview();return result;}
        if(action==='prepare'){
          const preview=d.state.get('preview');if(!preview||!input.runId||input.runId!==preview.runId)throw new Error('別の変更確認が行われました。差分を再確認してください');
          const view=d.controller.prepareView(input.keys),ticket=view.ticket;return {...ticket,entries:view.entries,labels:view.labels,token:confirmation('webApproval',ticket)};
        }
        if(action==='apply'){
          const last=d.state.get('webOutcome');if(last&&input.token===last.token&&last.actor===d.actor()&&last.bookId===d.bookId)return d.jobs&&last.result.job?d.jobs.status(last.result.runId):last.result;
          const c=checked('webApproval',input.token);d.state.remove('webApproval');
          // Consume before the first mutation. A lost response never grants a second apply.
          d.state.set('webOutcome',{token:input.token,actor:d.actor(),bookId:d.bookId,result:{status:'UNKNOWN',runId:c.ticket.runId,completed:0,error:'結果を履歴で確認してください。自動再実行はしません。'}});
          const result={...(d.jobs?d.jobs.accept(c.ticket,true):d.controller.apply(c.ticket,true)),runId:c.ticket.runId};
          d.state.set('webOutcome',{token:input.token,actor:d.actor(),bookId:d.bookId,result});return result;
        }
        if(action==='outcome'||action==='acknowledgeOutcome'){
          const last=d.state.get('webOutcome');if(!last||last.actor!==d.actor()||last.bookId!==d.bookId||last.result.runId!==input.runId)throw new Error('この実行結果は見つかりません。履歴を確認してください');
          if(action==='acknowledgeOutcome')d.state.set('webOutcome',{...last,acknowledged:true});return d.jobs&&last.result.job?d.jobs.status(last.result.runId):last.result;
        }
        if(action==='verify')return d.controller.verify();
        if(action==='history'){const p=page(input);return d.store.readHistory(p.offset,p.limit,typeof input.runId==='string'?input.runId.slice(0,200):'');}
        throw new Error('対応していない操作です');
      }));
    }
    return {dispatch};
  }
  return {create};
})();
function GFM_web(action,input){return GFMWeb.create(GFMRuntime.open()).dispatch(action,input);}
function doGet(){
  GFMRuntime.open();
  const t=HtmlService.createTemplateFromFile('Index');
  t.session=HtmlService.createHtmlOutputFromFile('Session').getContent();
  t.styles=HtmlService.createHtmlOutputFromFile('Styles').getContent();t.client=HtmlService.createHtmlOutputFromFile('Client').getContent();
  return t.evaluate().setTitle('Gmailフィルター管理').addMetaTag('viewport','width=device-width, initial-scale=1');
}
if(typeof module!=='undefined')module.exports=GFMWeb;
