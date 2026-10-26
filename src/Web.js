var GFMWeb = (function () {
  'use strict';
  function create(d) {
    const now=()=>d.now();
    function page(input){return {offset:Math.max(0,Math.min(100000,Number.isSafeInteger(input.offset)?input.offset:0)),limit:20};}
    function confirmation(kind,ticket){const token=d.uuid();d.state.set(kind,{token,ticket,at:now(),actor:d.actor(),bookId:d.bookId});return token;}
    function checked(kind,token){const c=d.state.get(kind);if(!c||!token||c.token!==token||c.actor!==d.actor()||c.bookId!==d.bookId)throw new Error('確認が無効です。もう一度確認してください');if(now()-c.at>15*60*1000)throw new Error('確認の期限が切れました。もう一度確認してください');return c;}
    const trackedActions=new Set(['importCheck','import','preview','prepare','apply','messagesList','messagesStart','messagesScan','messagesPrepare','messagesApply','messagesCancel']);
    function tracked(action,input,fn){
      const requestId=input._requestId;
      if(!trackedActions.has(action)||typeof requestId!=='string'||!requestId||requestId.length>128)return fn();
      const approval=action==='apply'?d.state.get('webApproval'):action==='messagesApply'?d.state.get('webMessageApproval'):null;
      const activity={requestId,action,runId:input.runId||approval?.ticket?.runId||'',status:'RUNNING',at:now(),actor:d.actor(),bookId:d.bookId};
      d.state.set('webActivity',activity);
      try{
        const result=fn(),record={...activity,status:'DONE',runId:result?.runId||activity.runId,finishedAt:now()};
        if(action==='apply'||action==='import')record.result={...result,error:result.error?String(result.error).slice(0,1500):undefined};
        d.state.set('webActivity',record);return result;
      }catch(err){d.state.set('webActivity',{...activity,status:'ERROR',error:String(err.message||err).slice(0,1500),finishedAt:now()});throw err;}
    }
    function resume(requestId){
      if(typeof requestId!=='string'||!requestId||requestId.length>128)throw Error('実行状況の確認IDが不正です');
      const a=d.state.get('webActivity');
      if(!a||a.requestId!==requestId||a.actor!==d.actor()||a.bookId!==d.bookId)return {status:'NOT_FOUND',requestId};
      const result={requestId,action:a.action,runId:a.runId,status:a.status,error:a.error||'',result:a.result||null};
      const outcome=d.state.get('webOutcome');
      if(a.action==='apply'&&outcome?.actor===d.actor()&&outcome.bookId===d.bookId&&outcome.result.runId===a.runId&&outcome.result.status!=='UNKNOWN'){result.status='DONE';result.result=outcome.result;}
      if(a.action.startsWith('messages')){
        const j=d.state.get('messageJob');if(j&&j.runId===a.runId)result.messageJob={runId:j.runId,status:j.status,total:j.total,completed:j.completed,remaining:j.total-j.completed,uncertain:j.pending?.count||0,error:j.error||''};
      }
      if(result.status==='RUNNING'&&now()-a.at>7*60*1000)result.status='UNKNOWN';
      return result;
    }
    function dispatch(action,input) {
      input=input||{};if(typeof input!=='object'||Array.isArray(input))throw new Error('入力形式が不正です');
      // Read only small owner-scoped checkpoints; status must remain available while a write owns the lock.
      if(action==='resume')return resume(input.requestId);
      return d.withLock(()=>tracked(action,input,()=>{
        if(action==='boot'){const last=d.state.get('webOutcome');return {messageJob:d.state.get('messageJob'),unseenOutcome:last&&!last.acknowledged&&last.actor===d.actor()&&last.bookId===d.bookId?last.result:null};}
        if(action==='messagesList')return d.messages.list();
        if(action==='messagesStart')return d.messages.start(input.keys===undefined?null:input.keys);
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
          const last=d.state.get('webOutcome');if(last&&input.token===last.token&&last.actor===d.actor()&&last.bookId===d.bookId)return last.result;
          const c=checked('webApproval',input.token);d.state.remove('webApproval');
          // Consume before the first mutation. A lost response never grants a second apply.
          d.state.set('webOutcome',{token:input.token,actor:d.actor(),bookId:d.bookId,result:{status:'UNKNOWN',runId:c.ticket.runId,completed:0,error:'結果を履歴で確認してください。自動再実行はしません。'}});
          const result={...d.controller.apply(c.ticket,true),runId:c.ticket.runId};
          d.state.set('webOutcome',{token:input.token,actor:d.actor(),bookId:d.bookId,result});return result;
        }
        if(action==='outcome'||action==='acknowledgeOutcome'){
          const last=d.state.get('webOutcome');if(!last||last.actor!==d.actor()||last.bookId!==d.bookId||last.result.runId!==input.runId)throw new Error('この実行結果は見つかりません。履歴を確認してください');
          if(action==='acknowledgeOutcome')d.state.set('webOutcome',{...last,acknowledged:true});return last.result;
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
