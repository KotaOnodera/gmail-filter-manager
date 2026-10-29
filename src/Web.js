var GFMWeb = (function () {
  'use strict';
  function create(d) {
    const now=()=>d.now();
    function page(input){return {offset:Math.max(0,Math.min(100000,Number.isSafeInteger(input.offset)?input.offset:0)),limit:20};}
    const approvalTTL=15*60*1000;
    const reasons={VALID:'確認は有効です。',EXPIRED:'確認の期限が切れました。内容を再確認してください。',CONFIG_CHANGED:'確認後に設定が変更されています。内容を再確認してください。',GMAIL_CHANGED:'確認後にGmailが変更されています。内容を再確認してください。',SUPERSEDED:'別の確認操作により確認が失効しました。内容を再確認してください。'};
    function expiry(c){return Math.min(c.expiresAt===undefined?c.at+approvalTTL:c.expiresAt,c.at+approvalTTL,...[c.ticket.preparedAt,c.ticket.at].filter(Number.isFinite).map(t=>t+approvalTTL));}
    function validity(c,reason){return {valid:reason==='VALID',reason,message:reasons[reason],expiresAt:c?expiry(c):null,serverNow:now()};}
    function confirmationStatus(kind,token){
      if(!['webApproval','webMessageApproval','webImport'].includes(kind))throw Error('確認の種類が不正です');
      const c=d.state.get(kind);
      if(!owned(c)||!token||c.token!==token)return validity(null,'SUPERSEDED');
      if(kind==='webApproval'&&!same(c.ticket,d.state.get('prepared'))||kind==='webMessageApproval'&&d.state.get('messageApproval')&&!same(c.ticket,d.state.get('messageApproval')))return validity(c,'SUPERSEDED');
      if(c.config&&c.config!==configHash())return validity(c,'CONFIG_CHANGED');
      if(!(kind==='webApproval'&&c.ticket.policy==='SHEET_AUTHORITATIVE')&&c.remote&&c.remote!==d.hash(C.stable(C.remote(d.gmail.read()))))return validity(c,'GMAIL_CHANGED');
      return validity(c,now()>=expiry(c)?'EXPIRED':'VALID');
    }
    function confirmation(kind,ticket,remote){
      const at=now(),token=d.uuid(),c={token,ticket,at,expiresAt:Math.min(at+approvalTTL,...[ticket.preparedAt,ticket.at].filter(Number.isFinite).map(t=>t+approvalTTL)),actor:d.actor(),bookId:d.bookId,config:configHash(),remote:kind==='webApproval'&&ticket.policy==='SHEET_AUTHORITATIVE'?undefined:remote||d.hash(C.stable(C.remote(d.gmail.read())))};
      d.state.set(kind,c);return {token,confirmation:validity(c,now()>=expiry(c)?'EXPIRED':'VALID')};
    }
    function checked(kind,token){const status=confirmationStatus(kind,token);if(!status.valid){const error=Error(status.message);error.confirmation=status;throw error;}return d.state.get(kind);}
    const viewActions=new Set(['preview','prepare','prepareStart','prepareRemaining','importCheck','messagesList','messagesPrepare']);
    const viewTTL=24*60*60*1000;
    const C=typeof module!=='undefined'?require('./Core'):GFMCore,L=typeof module!=='undefined'?require('./Labels'):GFMLabels;
    const same=(a,b)=>C.stable(a)===C.stable(b);
    function configHash(rows,labels){return d.hash(C.stable({filters:C.config(rows||d.store.readRows()),labels:L.config(labels||d.store.readLabelRows())}));}
    function owned(h){return h&&h.actor===d.actor()&&h.bookId===d.bookId;}
    function locator(h){return {viewId:h.viewId,runId:h.runId,action:h.action};}
    function retireView(h){
      if(!owned(h))return;
      try{d.store.removeWebView(h.pointer);d.state.remove('webView:'+h.viewId);}
      catch(_){
        // Unverified cells must stay intact; one bad disposable view must not
        // prevent fresh confirmation. Keep only a bounded audit locator set.
        const ids=d.state.get('webViewQuarantineIndex')||[];
        if(!ids.includes(h.viewId))ids.push(h.viewId);
        d.state.set('webView:'+h.viewId,{...h,quarantinedAt:now()});
        while(ids.length>12){const id=ids.shift(),old=d.state.get('webView:'+id);if(owned(old)&&old.quarantinedAt!==undefined)d.state.remove('webView:'+id);}
        d.state.set('webViewQuarantineIndex',ids);
      }
    }
    function pruneViews(){
      const ids=d.state.get('webViewIndex')||[],keep=[];
      for(const id of ids){const h=d.state.get('webView:'+id);if(!owned(h)){keep.push(id);continue;}if(now()-h.at<=viewTTL){keep.push(id);continue;}retireView(h);}
      while(keep.length>=12){const id=keep.shift();retireView(d.state.get('webView:'+id));}
      d.state.set('webViewIndex',keep);return keep;
    }
    function navigation(entries=[]){
      if(typeof d.bookId!=='string'||!d.bookId||!/^[-_a-zA-Z0-9]+$/.test(d.bookId))return null;
      const spreadsheet='https://docs.google.com/spreadsheets/d/'+d.bookId+'/edit',locations=d.store.configurationLocations?d.store.configurationLocations(entries):{},sheets={};
      for(const name of ['Filters','Labels'])if(Number.isSafeInteger(locations[name]?.gid)&&locations[name].gid>=0)sheets[name]=spreadsheet+'#gid='+locations[name].gid;
      return {spreadsheet,sheets,locations};
    }
    function withNavigation(result){
      const nav=navigation(result.entries||[]);if(!nav)return result;
      const entries=result.entries?.map(e=>{const name=e.kind==='LABEL'?'Labels':'Filters',key=e.kind==='LABEL'?e.labelKey:e.ruleKey||e.key,row=nav.locations[name]?.rows?.[key],base=nav.sheets[name]||nav.spreadsheet;
        return {...e,...(nav.sheets[name]?{configurationUrl:base+(Number.isSafeInteger(row)&&row>=2?'&range=A'+row:'')}:{})};});
      return {...result,navigation:{spreadsheet:nav.spreadsheet,sheets:nav.sheets},...(entries?{entries}:{})};
    }
    function saveView(action,input,result){
      if(!viewActions.has(action)||result.job)return result;
      result=withNavigation(result);
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
      let originalEntries=null;if(sourceView){const source=d.state.get('webView:'+sourceView.viewId);originalEntries=d.store.readWebView(source.pointer).result.entries||[];}
      if(originalEntries&&Array.isArray(input.keys)){const chosen=originalEntries.filter(e=>input.keys.includes(e.ruleKey)),refs=new Set(chosen.flatMap(e=>[...(e.after?.action?.addLabelIds||[]),...(e.after?.action?.removeLabelIds||[])]));originalEntries=originalEntries.filter(e=>input.keys.includes(e.ruleKey)||e.kind==='LABEL'&&refs.has(e.after?.id||L.virtualId(e.labelKey)));}
      const data={previousRunId:input.previousRunId||result.previousRunId||'',originalEntries,viewId,action,runId:h.runId,sourceView,preparationId:h.preparationId,actor:h.actor,bookId:h.bookId,mode:input._viewMode==='SELECTED'||input.keys!==undefined?'SELECTED':'ALL',keys:input.keys||[],revision:0,result,config:configHash()};
      h.pointer=d.store.writeWebView(viewId,data);d.state.set('webView:'+viewId,h);ids.push(viewId);d.state.set('webViewIndex',ids);return {...result,_view:locator(h)};
    }
    function preparationLocator(preparationId){
      const ids=d.state.get('webViewIndex')||[];
      for(const id of ids.slice().reverse()){const h=d.state.get('webView:'+id);if(owned(h)&&h.preparationId===preparationId&&h.quarantinedAt===undefined&&now()-h.at<=viewTTL&&['prepareStart','prepareRemaining'].includes(h.action))return locator(h);}
      return null;
    }
    function preparationContext(result){
      // A new tab has no browser locator. Recover only a verified owner/book
      // receipt for this preparation; its direct keys and source preview are
      // separate from the dependency-expanded approval ticket.
      const ids=d.state.get('webViewIndex')||[];
      for(const id of ids.slice().reverse()){
        const h=d.state.get('webView:'+id);
        if(!owned(h)||h.preparationId!==result.preparationId||h.quarantinedAt!==undefined||now()-h.at>viewTTL||!['prepareStart','prepareRemaining'].includes(h.action))continue;
        try{
          const v=d.store.readWebView(h.pointer);
          if(!owned(v)||v.viewId!==h.viewId||v.action!==h.action||v.runId!==h.runId||v.preparationId!==h.preparationId||!['ALL','SELECTED'].includes(v.mode)||!Array.isArray(v.keys))continue;
          if((v.previousRunId||v.result.previousRunId||(h.action==='prepareRemaining'?h.runId:''))!==(result.previousRunId||''))continue;
          if(result.selection&&h.action!=='prepareRemaining'&&v.mode!=='SELECTED')continue;
          if(result.entries&&v.keys.some(k=>!result.entries.some(e=>e.ruleKey===k)))continue;
          return {...result,_view:locator(h),mode:result.selection?'SELECTED':v.mode,keys:v.keys,sourceView:v.sourceView||null};
        }catch(_){/* Missing or corrupt disposable receipt never broadens scope. */}
      }
      return {...result,mode:'SELECTED',keys:[],scopeUnavailable:true,token:'',...(result.status==='READY'?{confirmation:validity(null,'SUPERSEDED')}:{})};
    }
    function readyPreparation(preparationId){
      const progress=d.jobs.prepareStatus(preparationId);if(progress.status!=='READY')return withNavigation(preparationContext(progress));
      // PREPARING checkpoints remain readable during a running worker. Once
      // READY, re-read and fence validation plus token issuance against preview,
      // replacement preparation and apply using the shared operation lock.
      return withNavigation(preparationContext(d.withLock(()=>{
        const p=d.jobs.prepareStatus(preparationId);if(p.status!=='READY')return p;
        if(!same(p.ticket,d.state.get('prepared')))throw Error('確認が失効しました。差分を再取得してください');
        const captured=d.store.readJobData(p.ticket.jobApproval);
        if(configHash(captured.rows,captured.labelRows)!==configHash())throw Error('確認後に設定が変更されています。差分を再取得してください');
        const old=d.state.get('webApproval');
        const remote=d.hash(C.stable(C.remote(captured.state)));
        if(p.ticket.policy!=='SHEET_AUTHORITATIVE'&&!old&&remote!==d.hash(C.stable(C.remote(d.gmail.read()))))return {...p,...p.ticket,token:'',confirmation:validity({ticket:p.ticket,at:p.ticket.preparedAt},'GMAIL_CHANGED')};
        if(old&&old.ticket.runId===p.ticket.runId)return {...p,...p.ticket,token:old.token,confirmation:confirmationStatus('webApproval',old.token)};
        if(now()>=p.ticket.preparedAt+approvalTTL)return {...p,...p.ticket,token:'',confirmation:validity({ticket:p.ticket,at:p.ticket.preparedAt},'EXPIRED')};
        return {...p,...p.ticket,...confirmation('webApproval',p.ticket,remote)};
      })));
    }
    function loadView(input){
      const h=typeof input.viewId==='string'&&input.viewId.length<=128?d.state.get('webView:'+input.viewId):null;
      if(!owned(h))return {status:'NOT_FOUND'};
      if(h.quarantinedAt!==undefined)return {status:'INVALID',action:h.action,error:'保存した画面を検証できませんでした。取得し直してください。'};
      if(input.runId&&input.runId!==h.runId)throw Error('保存した表示の実行IDが一致しません');
      const job=d.state.get('filterJob');if(d.jobs&&owned(job)&&(h.preparationId&&job.ticket?.jobApproval?.runId===h.preparationId||h.action==='prepare'&&h.runId===job.runId))return {status:'JOB',result:d.jobs.status(job.runId)};
      if(now()-h.at>viewTTL)return {status:'EXPIRED',action:h.action};
      let v,result;
      try{
        v=d.store.readWebView(h.pointer);
        if(!owned(v)||v.viewId!==h.viewId||v.action!==h.action||v.runId!==h.runId||v.preparationId!==h.preparationId)throw Error('保存した表示の対応が一致しません');
        result=v.result;
        if(h.preparationId){const current=d.state.get('filterPreparation');if(!owned(current)||current.preparationId!==h.preparationId)throw Error('別の確認準備が開始されています');result=readyPreparation(h.preparationId);}
        if(h.action==='messagesPrepare'){const j=d.state.get('messageJob');if(!j||j.runId!==result.runId||j.revision!==result.revision)throw Error('既存メール処理の状態が変更されています。保存済みの状況を再確認してください');}
        const kind=h.action==='importCheck'?'webImport':h.action==='messagesPrepare'?'webMessageApproval':h.action==='prepare'||result.status==='READY'&&h.preparationId?'webApproval':'';
        if(kind){result={...result,confirmation:result.confirmation||confirmationStatus(kind,result.token)};const status=h.preparationId&&result.confirmation?result.confirmation:confirmationStatus(kind,result.token);if(!status.valid){const e=Error(status.message);e.confirmation=result.confirmation&&!result.confirmation.valid?result.confirmation:status;throw e;}result.confirmation=status;}
        if(h.action==='preview'&&d.state.get('preview')?.runId!==h.runId)throw Error('別の差分確認が行われています');
        if(!h.preparationId&&v.config!==configHash())throw Error('設定が変更されています。再確認してください');
        if(h.action==='messagesPrepare'&&d.state.get('messageJob')&&d.state.get('messageJob').runId!==result.runId)throw Error('既存メールの実行IDが変更されています');
        const validKeys=new Set((result.entries||[]).filter(e=>(e.ruleKey||e.key)&&e.operation!=='ERROR'&&e.eligible!==false&&!e.errors?.length).map(e=>e.ruleKey||e.key));
        if(!Array.isArray(v.keys)||v.keys.some(k=>!validKeys.has(k))&&(!h.preparationId||result.status==='READY'))throw Error('保存した選択対象が一致しません');
        return {status:'OK',...locator(h),sourceView:v.sourceView||null,mode:v.mode,keys:v.keys,revision:v.revision,result:{...result,_view:locator(h)}};
      }catch(e){
        const reason=e.confirmation?.reason||(/設定/.test(e.message)?'CONFIG_CHANGED':/Gmail|ラベル/.test(e.message)?'GMAIL_CHANGED':/期限/.test(e.message)?'EXPIRED':'SUPERSEDED');
        if(h.preparationId&&(!result?.entries)){try{const p=d.jobs.prepareStatus(h.preparationId);if(p.status==='READY')result=preparationContext({...p,...p.ticket});}catch(_){}}
        const confirmation=e.confirmation||{...validity(null,reason),expiresAt:result?.confirmation?.expiresAt||((result?.preparedAt!==undefined)?result.preparedAt+approvalTTL:null)};
        return {status:'INVALID',...locator(h),mode:v?.mode,keys:v?.keys||[],sourceView:v?.sourceView||null,confirmation,result:result?{...result,confirmation,_view:locator(h)}:null,error:'保存した画面を使用できません。再確認または取得し直してください。 '+String(e.message||e).slice(0,200)};}
    }
    function reconfirm(input){
      const h=d.state.get('webView:'+input.viewId);if(!owned(h)||h.quarantinedAt!==undefined||now()-h.at>viewTTL)throw Error('保存した確認を検証できません。取得し直してください');
      const v=d.store.readWebView(h.pointer);if(!owned(v)||v.viewId!==h.viewId||v.action!==h.action||v.runId!==h.runId||input.runId&&input.runId!==h.runId)throw Error('保存した確認の対応が一致しません');
      const job=d.state.get('filterJob');if(d.jobs&&owned(job)&&(h.preparationId&&job.ticket?.jobApproval?.runId===h.preparationId||h.action==='prepare'&&job.runId===h.runId))return {status:'JOB',result:d.jobs.status(job.runId)};
      let action,result,keys=v.keys||[],original=v.originalEntries||v.result.entries||[],mode=v.mode;
      if(h.action==='importCheck'){action='importCheck';const ticket=d.controller.importAll(false);result={count:ticket.count,total:ticket.total,labelCount:ticket.labelCount,labelTotal:ticket.labelTotal,...confirmation('webImport',ticket)};}
      else if(h.action==='messagesPrepare'){
        const j=d.state.get('messageJob');if(!j||j.runId!==h.runId)throw Error('別の既存メール処理が開始されています。保存済みの状況を確認してください');
        if(['OK','CANCELLED'].includes(j.status))return {status:'MESSAGE_JOB',result:d.messages.status(j.runId)};
        keys=(v.result.entries||[]).map(e=>e.key);mode='SELECTED';
        // Keep saved message IDs/counts when definitions still match. Changed
        // definitions require an explicit fresh search; never mix old IDs with new actions.
        try{const ticket=d.messages.prepare(h.runId);action='messagesPrepare';result={...d.messages.status(h.runId),...confirmation('webMessageApproval',ticket)};}
        catch(e){if(!/定義|ラベル.*変更/.test(e.message))throw e;d.messages.cancel(h.runId);d.state.remove('webMessageApproval');action='messagesList';result=d.messages.list();}
      }else if(['prepare','prepareStart','prepareRemaining','preview'].includes(h.action)){
        if(v.previousRunId&&v.result.previousRunId&&v.previousRunId!==v.result.previousRunId)throw Error('元のジョブの対応が一致しません。保存済みの状況を確認してください');
        const previousRunId=v.previousRunId||v.result.previousRunId||(h.action==='prepareRemaining'?h.runId:'');
        if(previousRunId){
          if(!owned(job)||job.runId!==previousRunId)throw Error('元のジョブが変更されています。保存済みの状況を確認してください');
          const a=d.store.readJobData(job.ticket.jobApproval),sourceId=(d.state.get('webViewIndex')||[]).find(id=>{const source=d.state.get('webView:'+id);return owned(source)&&(source.preparationId&&source.preparationId===job.ticket.jobApproval.runId||source.action==='prepare'&&source.runId===job.runId);}),source=sourceId?d.store.readWebView(d.state.get('webView:'+sourceId).pointer):null;
          // Only the initial remaining confirmation lacks a current direct
          // selection. Later previews/preparations may deliberately narrow it.
          if(h.action==='prepareRemaining'||v.mode!=='SELECTED')keys=source?.mode==='SELECTED'?source.keys:a.keys;
          const allowed=new Set(a.keys);if(keys.some(k=>!allowed.has(k)))throw Error('元の承認範囲外の対象が選択されています。保存済みの状況を確認してください');
          mode='SELECTED';original=v.originalEntries||v.result.entries||a.entries;
        }
        if(mode==='ALL'&&d.jobs&&!previousRunId){
          const p=d.state.get('filterPreparation');if(!owned(p)||p.preparationId!==h.preparationId||!p.approval)throw Error('元の確認準備を検証できません。取得し直してください');
          d.state.remove('webApproval');result=d.jobs.prepareStart({reconfirmationFrom:p.approval});result=saveView('prepareStart',{_viewMode:'ALL'},result);return {status:'OK',action:'prepareStart',mode:'ALL',keys:[],result};
        }
        d.state.remove('webApproval');action='preview';result={...d.controller.preview(),...(previousRunId?{previousRunId}:{})};
      }else throw Error('この画面からは再確認できません');
      const entryKey=e=>e.ruleKey||e.key,available=new Map((result.entries||[]).map(e=>[entryKey(e),e])),before=new Map(original.map(e=>[entryKey(e),e]));
      const relevant=mode==='ALL'?[...before.keys()]:[...new Set([...keys,...original.filter(e=>e.kind==='LABEL').map(entryKey)])];
      const missing=relevant.filter(k=>!available.has(k)),invalid=relevant.filter(k=>available.has(k)&&(available.get(k).errors?.length||available.get(k).eligible===false||available.get(k).operation==='ERROR'));
      const definition=e=>({operation:e.operation,before:e.before,after:e.after,filter:e.filter,action:e.action,errors:e.errors});
      const changed=[...before.keys()].filter(k=>available.has(k)&&!same(definition(before.get(k)),definition(available.get(k)))) ;
      keys=keys.filter(k=>available.has(k)&&!invalid.includes(k));
      const changes={missing,invalid,changed};result={...result,reconfirmation:changes};
      result=saveView(action,{_viewMode:mode,...(result.previousRunId?{previousRunId:result.previousRunId}:{}),...(mode==='SELECTED'?{keys}:{})},result);
      return {status:'OK',action,mode,keys,changes,result};
    }
    function updateView(input){
      const restored=loadView(input);if(restored.status!=='OK')return restored;
      const h=d.state.get('webView:'+input.viewId),v=d.store.readWebView(h.pointer);
      if(!['preview','messagesList'].includes(h.action))throw Error('この操作段階の選択は変更できません');
      if(!Number.isSafeInteger(input.revision)||input.revision<=v.revision)return {status:'STALE'};
      const valid=new Set((v.result.entries||[]).filter(e=>(e.ruleKey||e.key)&&e.operation!=='ERROR'&&e.eligible!==false&&!e.errors?.length).map(e=>e.ruleKey||e.key));
      if(!Array.isArray(input.keys)||input.keys.length>10000||new Set(input.keys).size!==input.keys.length||input.keys.some(k=>!valid.has(k)))throw Error('選択対象が一致しません');
      const pointer=d.store.writeWebView(h.viewId,{...v,mode:input._viewMode==='SELECTED'?'SELECTED':v.mode,keys:input.keys,revision:input.revision});d.state.set('webView:'+h.viewId,{...h,pointer});d.store.removeWebView(h.pointer);return {status:'OK'};
    }
    const trackedActions=new Set(['reconfirm','importCheck','import','preview','prepare','prepareStart','prepareRemaining','apply','messagesList','messagesStart','messagesScan','messagesPrepare','messagesApply','messagesCancel']);
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
        const result=saveView(action,input,fn()),record={...activity,status:'DONE',runId:result?.runId||result?.result?.runId||activity.runId,finishedAt:now(),preparationId:result?.preparationId||'',viewId:result?._view?.viewId||result?.result?._view?.viewId||''};
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
        const j=d.state.get('messageJob');if(j&&(j.runId===a.runId||a.action==='messagesStart'&&j.requestId===requestId)){result.runId=j.runId;result.messageJob={runId:j.runId,status:j.status,total:j.total,totalKnown:!['SCANNING','SCAN_FAILED'].includes(j.status)&&j.rule===j.ruleCount,completed:j.completed,remaining:j.total-j.completed,uncertain:j.pending?.count||0,error:j.error||''};}
      }
      if(result.status==='RUNNING'&&now()-a.at>7*60*1000)result.status='UNKNOWN';
      return result;
    }
    function dispatch(action,input) {
      input=input||{};if(typeof input!=='object'||Array.isArray(input))throw new Error('入力形式が不正です');
      // Read only small owner-scoped checkpoints; status must remain available while a write owns the lock.
      if(action==='resume')return resume(input.requestId);
      if(action==='viewGet')return loadView(input);
      if(action==='confirmationStatus'){try{return d.withLock(()=>confirmationStatus(input.kind,input.token));}catch(e){if(e.code!=='GFM_BUSY')throw e;return {valid:false,reason:'BUSY',message:'別の処理が実行中です。確認状態を再取得します。',serverNow:now()};}}
      if(action==='reconfirm')return d.withLock(()=>tracked(action,input,()=>reconfirm(input)));
      if(action==='viewUpdate')return d.withLock(()=>updateView(input));
      if(action==='boot'){const last=d.state.get('webOutcome');return {navigation:(()=>{const n=navigation();return n?{spreadsheet:n.spreadsheet,sheets:n.sheets}:null;})(),filterJob:d.jobs&&d.state.get('filterJob')?d.jobs.status():null,filterPreparation:(()=>{const p=d.state.get('filterPreparation');return owned(p)?{preparationId:p.preparationId,previousRunId:p.previousRunId||'',runId:p.ticket?.runId||'',status:p.status,phase:p.phase,createdAt:p.createdAt,updatedAt:p.updatedAt,_view:preparationLocator(p.preparationId)}:null;})(),messageJob:d.state.get('messageJob'),unseenOutcome:last&&!last.acknowledged&&last.actor===d.actor()&&last.bookId===d.bookId?last.result:null};}
      if(action==='filterJobStatus'&&d.jobs)return d.jobs.status(input.runId);
      if(action==='filterJobVerification'&&d.jobs)return withNavigation(d.jobs.verification(input.runId));
      if(action==='prepareStatus'&&d.jobs)return readyPreparation(input.preparationId);
      return d.withLock(()=>tracked(action,input,()=>{
        if(action==='prepareRemaining'&&d.jobs){d.state.remove('webApproval');return d.jobs.prepareRemaining(input.runId);}
        if(action==='prepareStart'&&d.jobs){d.state.remove('webApproval');return d.jobs.prepareStart({...input,fresh:!input.previousRunId});}

        if(action==='messagesList')return d.messages.list();
        if(action==='messagesStart')return d.messages.start(input.keys===undefined?null:input.keys,input._requestId);
        if(action==='messagesScan')return d.messages.scan(input.runId);
        if(action==='messagesStatus')return d.messages.status(input.runId);
        if(action==='messagesCancel'){d.state.remove('webMessageApproval');return d.messages.cancel(input.runId);}
        if(action==='messagesPrepare'){
          const ticket=d.messages.prepare(input.runId);return {...d.messages.status(input.runId),...confirmation('webMessageApproval',ticket)};
        }
        if(action==='messagesApply'){
          const receipt=d.state.get('webMessageReceipt');
          if(receipt&&receipt.token===input.token&&receipt.actor===d.actor()&&receipt.bookId===d.bookId)return d.messages.status(receipt.runId);
          const c=checked('webMessageApproval',input.token);d.state.remove('webMessageApproval');
          d.state.set('webMessageReceipt',{token:input.token,runId:c.ticket.runId,actor:d.actor(),bookId:d.bookId});
          return d.messages.apply(c.ticket);
        }
        if(action==='importCheck'){const ticket=d.controller.importAll(false);return {count:ticket.count,total:ticket.total,labelCount:ticket.labelCount,labelTotal:ticket.labelTotal,...confirmation('webImport',ticket)};}
        if(action==='import'){const c=checked('webImport',input.token);d.state.remove('webImport');return d.controller.importAll(true,c.ticket);}
        if(action==='preview'){d.state.remove('webApproval');const result=d.controller.preview();return result;}
        if(action==='prepare'){
          const preview=d.state.get('preview');if(!preview||!input.runId||input.runId!==preview.runId)throw new Error('別の変更確認が行われました。差分を再確認してください');
          const view=d.controller.prepareView(input.keys),ticket=view.ticket;return {...ticket,entries:view.entries,labels:view.labels,...confirmation('webApproval',ticket)};
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
