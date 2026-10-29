/* Durable owner/book-scoped filter execution. Properties hold only small checkpoints;
 * immutable approval and append-only execution records live in the spreadsheet. */
var GFMJobs=(function(){
  'use strict';
  function create(d){
    const C=typeof module!=='undefined'?require('./Core'):GFMCore,L=typeof module!=='undefined'?require('./Labels'):GFMLabels;
    const P=typeof module!=='undefined'?require('./ApplyPolicy'):GFMApplyPolicy;
    const authoritative=a=>a?.policy===P.name,queued=(a,e)=>e.operation!=='REMOTE_ONLY'&&!!e.ruleKey&&(authoritative(a)||changed(e));
    const terminal=j=>['OK','PAUSED','CANCELLED'].includes(j.status),changed=e=>!['NOOP','REMOTE_ONLY'].includes(e.operation)||!!e.matchedId;
    const digest=v=>d.hash(C.stable(v)),config=(rs,ls)=>({filters:C.config(rs),labels:L.config(ls)}),remote=s=>digest(C.remote(s));
    const stamp=()=>new Date(d.now()).toISOString();
    function identity(j){if(j.actor!==d.actor()||j.bookId!==d.bookId)throw Error('保存済みジョブの実行者・所有者またはスプレッドシートが一致しません');}
    function head(j){j.updatedAt=d.now();d.state.set('filterJob',j);}
    function history(j,result){try{d.store.history({runId:j.runId,at:stamp(),actor:j.actor,command:'FILTER_JOB',result,error:j.error||'',snapshotId:j.ticket.snapshotId,verification:JSON.stringify({filters:j.filters,labels:j.labels,phase:j.phase,diagnostic:j.diagnostic||null,verification:j.verification||null,report:!!j.verification})});}catch(_){j.historyWarning=true;head(j);}}
    function view(j){return C.clone({runId:j.runId,preparationId:j.ticket.jobApproval?.runId||'',status:j.status,phase:j.phase,completed:j.filters.completed+j.labels.completed,filters:j.filters,labels:j.labels,remaining:j.filters.remaining+j.labels.remaining,uncertain:j.uncertain||(['CREATE','DELETE','LABEL'].includes(j.intentPhase)?1:0),error:j.error||'',updatedAt:j.updatedAt,heartbeat:j.heartbeat,leaseUntil:j.leaseUntil,recovered:!!j.recovered,timings:j.timings,diagnostic:j.diagnostic||null,policy:j.ticket.policy,verification:j.verification||null,job:true});}
    function cleanupTransfer(a){
      const saved=d.state.get('cleanup'),binding=a.legacyCleanup;
      if(!saved&&!binding)return null;
      if(!saved||!binding||digest(saved)!==digest(binding.source))throw Error('中断した置換の復旧記録が変更されています');
      identity(binding);const source=binding.source,entries=a.entries.filter(e=>e.cleanup),old=a.state.filters.find(f=>f.id===source.oldId),fresh=a.state.filters.find(f=>f.id===source.newId);
      if(entries.length!==1||entries[0].operation!=='DELETE'||entries[0].ruleKey!==source.ruleKey||entries[0].before?.id!==source.oldId||entries[0].keepId!==source.newId||!a.keys.includes(source.ruleKey)||!old||!fresh||source.oldId===source.newId||digest(C.normalize(old))!==source.beforeHash||digest(C.normalize(fresh))!==source.afterHash)throw Error('中断した置換の承認対象・旧新IDが一致しません');
      return {sourceHash:digest(source),ruleKey:source.ruleKey,oldId:source.oldId,newId:source.newId,afterHash:source.afterHash};
    }
    function finishLegacyCleanup(j,a,live,rows){
      const c=j.legacyCleanup;if(!c)return;
      const binding=a.legacyCleanup,saved=d.state.get('cleanup');identity(binding);
      if(digest(binding.source)!==c.sourceHash||saved&&digest(saved)!==c.sourceHash||d.state.get('pending')||d.state.get('labelPending'))throw Error('中断した置換の復旧記録が変更されています');
      const fresh=live.filters.find(f=>f.id===c.newId);
      if(live.filters.some(f=>f.id===c.oldId)||!fresh||digest(C.normalize(fresh))!==c.afterHash||rows.filter(r=>r.RuleKey===c.ruleKey&&r.GmailFilterId===c.newId).length!==1)throw Error('中断した置換の完了照合に失敗しました');
      // This is reconciliation of the approved deletion, never a fresh mutation.
      // Keep the immutable association on the job after removing the old journal.
      d.state.remove('cleanup');
    }
    function accept(ticket,approved){
      const old=d.state.get('filterJob');
      if(old){identity(old);if(old.runId===ticket.runId)return view(old);if(!terminal(old)||old.uncertain||old.status==='PAUSED'&&old.intentPhase&&ticket.previousRunId!==old.runId)throw Error('保存済みジョブの進捗・結果不明を先に確認してください');}
      const prepared=d.state.get('prepared');
      if(!prepared||C.stable(prepared)!==C.stable(ticket)||!ticket.jobApproval)throw Error('承認準備が失効しました。再確認してください');
      if(d.now()-ticket.preparedAt>=15*60*1000)throw Error('確認の期限が切れました。再確認してください');
      if(!approved)return {status:'CANCELLED',completed:0,runId:ticket.runId};
      if(d.state.get('pending')||d.state.get('labelPending'))throw Error('中断操作を先に復旧してください');
      const legacyCleanup=d.state.get('cleanup')||ticket.legacyCleanupHash?cleanupTransfer(d.store.readJobData(ticket.jobApproval)):null;
      if(legacyCleanup&&ticket.legacyCleanupHash!==legacyCleanup.sourceHash)throw Error('中断した置換の承認記録が一致しません');
      const j={runId:ticket.runId,legacyCleanup,ticket:C.clone(ticket),actor:d.actor(),bookId:d.bookId,status:'ACCEPTED',phase:'SHEET_READ',createdAt:d.now(),updatedAt:d.now(),heartbeat:d.now(),leaseUntil:0,attempts:0,runs:0,timings:{},filters:{planned:ticket.jobCounts?.filters||0,completed:0,remaining:ticket.jobCounts?.filters||0},labels:{planned:ticket.jobCounts?.labels||0,completed:0,remaining:ticket.jobCounts?.labels||0}};
      head(j);d.state.remove('prepared');d.state.remove('preview');
      try{d.scheduler.ensure();}catch(_){j.status='PAUSED';j.error='自動実行トリガーを登録できません。権限を確認して残りの差分を再確認してください';head(j);}
      history(j,j.status);return view(j);
    }
    function status(runId){
      let j=d.state.get('filterJob');if(!j||runId&&j.runId!==runId)throw Error('この実行ジョブは見つかりません');identity(j);
      if(!terminal(j)&&(!d.scheduler.exists()||j.status==='RUNNING'&&j.leaseUntil<d.now()||j.status!=='RUNNING'&&d.now()-j.updatedAt>5*60*1000)){
        // Fence repairs against a trigger still writing. Runtime provides the same script lock.
        try{return d.withLock(()=>{j=d.state.get('filterJob');identity(j);if(j.status==='RUNNING'&&j.leaseUntil>=d.now())return view(j);const stale=j.status!=='RUNNING'&&d.now()-j.updatedAt>5*60*1000;
          if(stale&&(j.repairs||0)>=3){j.status='PAUSED';j.error='自動実行トリガーの更新が停止しています。権限・実行割り当てを確認してください';j.leaseUntil=0;head(j);d.scheduler.clear();history(j,'PAUSED');return view(j);}
          if(stale){j.repairs=(j.repairs||0)+1;d.scheduler.clear();}
          j.status='WAITING';j.recovered=true;j.leaseUntil=0;d.scheduler.ensure();head(j);return view(j);});}catch(_){return view(j);}
      }
      return view(j);
    }
    function prepareStart(input){
      input=input||{};const active=d.state.get('filterJob');if(active&&!terminal(active))throw Error('受付済みジョブの進捗を確認してください');
      const previousRunId=input.previousRunId||(d.applyPolicy===P.name&&input.fresh&&active?.status==='PAUSED'?active.runId:'');
      const preparationId=d.uuid(),request=d.store.writeJobData(preparationId,{runId:input.runId||'',keys:input.keys===undefined?null:input.keys,previousRunId,preserveScope:!input.fresh,reconfirmationFrom:input.reconfirmationFrom||null});
      const p={runId:preparationId,preparationId,actor:d.actor(),bookId:d.bookId,status:'PREPARING',phase:'READ',request,createdAt:d.now(),updatedAt:d.now(),runs:0,previousRunId};
      d.state.remove('prepared');d.state.set('filterPreparation',p);d.scheduler.ensure();return {preparationId,status:p.status,phase:p.phase};
    }
    function prepareRemaining(runId){
      const j=d.state.get('filterJob');if(!j||j.runId!==runId)throw Error('保存済みジョブは見つかりません');identity(j);
      if(!terminal(j))return view(j);
      const a=d.store.readJobData(j.ticket.jobApproval);
      return prepareStart({keys:a.keys.filter(Boolean),previousRunId:runId});
    }
    function recoverAssociation(kind,key,approvedId,reconciledId,values){
      // Editable definitions may change before fresh confirmation; identity may
      // only be the approved association or the uniquely reconciled receipt.
      const rows=d.store.readRows(),labels=d.store.readLabelRows(),field=kind==='LABEL'?'GmailLabelId':'GmailFilterId',keyField=kind==='LABEL'?'LabelKey':'RuleKey',matches=(kind==='LABEL'?labels:rows).filter(r=>r[keyField]===key);
      if(matches.length!==1||![approvedId||'',reconciledId||''].includes(matches[0][field]||''))throw Error('復旧対象のID関連付けが変更されています。上書きせず確認してください');
      if(d.store.batchJobPatches)d.store.batchJobPatches([{kind,key,values}],rows,labels);
      else if(kind==='LABEL')d.store.updateLabelRow(key,values);else d.store.updateRow(key,values);
    }
    function recoveryForPreparation(runId){
      const j=d.state.get('filterJob');if(!j||j.runId!==runId||!terminal(j))throw Error('復旧元のジョブが変化しています');identity(j);
      const a=d.store.readJobData(j.ticket.jobApproval),m=j.checkpoint?d.store.readJobData(j.checkpoint):null,i=m?.intent;
      const intent=i?.phase==='PATCH'?i.resume:i,e=intent?.entry;
      // Reference-only PATCH intents have no API entry to recover. The approved
      // legacy deletion may nevertheless be complete and still need readback.
      if(!e){if(j.legacyCleanup){const live=d.gmail.read();if(!live.filters.some(f=>f.id===j.legacyCleanup.oldId))finishLegacyCleanup(j,a,live,d.store.readRows());}j.uncertain=0;head(j);return [];}
      const live=d.gmail.read(),extras=[];
      if(e.kind==='LABEL'){
        const known=new Set(a.state.labels.map(l=>l.id)),id=intent.newId||e.matchedId;
        const candidates=live.labels.filter(l=>l.type==='user'&&(id?l.id===id:e.operation==='CREATE'?!known.has(l.id)&&l.name===e.after.name:l.id===e.after.id&&l.name===e.after.name));
        if(candidates.length!==1)throw Error('ラベルの結果不明を解決できません。再作成せず履歴を確認してください');
        const original=a.labelRows.filter(r=>r.LabelKey===e.labelKey);if(original.length!==1)throw Error('承認したラベルのキーが一意ではありません');
        recoverAssociation('LABEL',e.labelKey,original[0].GmailLabelId,candidates[0].id,{GmailLabelId:candidates[0].id,SyncedName:candidates[0].name,SyncedAt:stamp(),Result:'復旧確認済み'});
      }else{
        let id=intent.newId||e.matchedId||'';
        if(['CREATE','CREATED'].includes(intent.phase)||['CREATE','REPLACE'].includes(e.operation)){
          const known=new Set(intent.knownFilterIds||a.state.filters.map(f=>f.id).concat((m.createdFilters||[]).filter(f=>f.id!==id).map(f=>f.id)));
          const candidates=live.filters.filter(f=>id?f.id===id&&!known.has(f.id)&&C.equal(f,e.after):!known.has(f.id)&&C.equal(f,e.after));
          if(candidates.length!==1)throw Error('作成結果が不明です。自動再作成せず照合が必要です');id=candidates[0].id;
          const old=e.before&&live.filters.find(f=>f.id===e.before.id);
          if(old){if(!C.equal(old,e.before))throw Error('置換途中の旧フィルターが変更されています');extras.push({...C.clone(e),operation:'DELETE',after:null,keepId:id,jobCleanup:true,warnings:['中断した置換の旧フィルターを削除します。照合済みの新フィルターを維持します']});}
        }else if(e.operation==='DELETE'){
          const old=live.filters.find(f=>f.id===e.before.id);if(old&&!C.equal(old,e.before))throw Error('削除対象が変更されています');id=e.keepId||(old?e.before.id:'');
        }
        const original=a.rows.filter(r=>r.RuleKey===e.ruleKey);if(original.length!==1)throw Error('承認したフィルターのキーが一意ではありません');
        recoverAssociation('FILTER',e.ruleKey,original[0].GmailFilterId,id,{GmailFilterId:id,SyncedAt:stamp(),Result:'復旧確認済み・残りを再確認'});
        if(j.legacyCleanup&&!live.filters.some(f=>f.id===j.legacyCleanup.oldId))finishLegacyCleanup(j,a,live,d.store.readRows());
      }
      j.uncertain=0;j.recovered=true;head(j);return extras;
    }
    function preparationView(p){
      const result={preparationId:p.preparationId,previousRunId:p.previousRunId||'',createdAt:p.createdAt,status:p.status,phase:p.phase,error:p.error||'',timings:p.timings||{},updatedAt:p.updatedAt,recovered:!!p.recovered};
      if(['READY','BLOCKED','NOOP'].includes(p.status)){const a=d.store.readJobData(p.approval);return {...result,runId:a.runId,summary:a.summary,ticket:p.ticket,entries:a.entries,labels:L.plan(a.labelRows,a.state.labels).labels,reconfirmation:a.reconfirmation,dependencies:[...new Map(a.entries.filter(e=>e.kind!=='LABEL').map(e=>a.bindings?.[e.ruleKey]).filter(Boolean).map(ref=>[ref.key,ref])).values()]};}return result;
    }
    function prepareStatus(id){
      let p=d.state.get('filterPreparation');if(!p||p.preparationId!==id)throw Error('準備中の確認は見つかりません');identity(p);
      if(p.status==='PREPARING'&&(!d.scheduler.exists()||d.now()-p.updatedAt>5*60*1000)){
        try{return d.withLock(()=>{p=d.state.get('filterPreparation');if(!p||p.preparationId!==id)throw Error('別の確認準備が開始されています');identity(p);
          if(p.status!=='PREPARING')return preparationView(p);
          const stale=d.now()-p.updatedAt>5*60*1000;
          if(stale&&(p.repairs||0)>=3){p.status='PAUSED';p.error='確認準備の自動実行が停止しています。権限・実行割り当てを確認して取得し直してください';d.scheduler.clear();}
          else {if(stale){p.repairs=(p.repairs||0)+1;d.scheduler.clear();}d.scheduler.ensure();p.recovered=true;}
          p.updatedAt=d.now();d.state.set('filterPreparation',p);return preparationView(p);
        });}catch(e){if(!p||p.preparationId!==id)throw e;identity(p);return preparationView(p);}
      }
      return preparationView(p);
    }
    function prepareRun(p){
      identity(p);const started=d.now(),phase=p.phase;try{
        if(d.now()-p.createdAt>15*60*1000||++p.runs>20)throw Error('準備の期限が切れました。再確認してください');
        if(p.phase==='READ'){
          const request=d.store.readJobData(p.request),extras=request.previousRunId?recoveryForPreparation(request.previousRunId):[],sync=typeof module!=='undefined'?require('./Sync'):GFMSync,a=sync.create(d).capturePreparation(request.runId,request.keys);
          if(request.previousRunId&&request.preserveScope!==false){const previous=d.state.get('filterJob'),original=d.store.readJobData(previous.ticket.jobApproval),allowed=new Set(original.keys);if(a.keys.some(k=>!allowed.has(k)))throw Error('元の選択範囲外の依存ラベルが必要です。選択を再確認してください');}
          if(extras.length){a.entries=[...a.entries.filter(e=>e.kind==='LABEL'),...extras,...a.entries.filter(e=>e.kind!=='LABEL')];a.summary.DELETE+=extras.length;}
          if(request.reconfirmationFrom){
            const original=d.store.readJobData(request.reconfirmationFrom),key=e=>e.ruleKey||e.key,before=new Map(original.entries.map(e=>[key(e),e])),after=new Map(a.entries.map(e=>[key(e),e])),definition=e=>({operation:e.operation,before:e.before,after:e.after,errors:e.errors});
            a.reconfirmation={missing:[...before.keys()].filter(k=>!after.has(k)),invalid:a.entries.filter(e=>e.operation==='ERROR').map(key),changed:[...before.keys()].filter(k=>after.has(k)&&digest(definition(before.get(k)))!==digest(definition(after.get(k))))};
          }
          p.approval=d.store.writeJobData(p.preparationId,a);p.phase='BACKUP';
          if(a.entries.some(e=>e.operation==='ERROR')){p.status='BLOCKED';p.phase='VALIDATION';p.error='入力エラーがあるため全部適用できません。Filters / Labelsの修正先を確認してください';}
          else if(!a.selected&&!a.entries.some(changed)){p.status='NOOP';p.phase='COMPLETE';}
          if(p.status!=='PREPARING')d.scheduler.clear();
        }else if(p.phase==='BACKUP'){
          const a=d.store.readJobData(p.approval);
          if(p.backupStarted){
            // A terminated worker may already have committed this append-only ID.
            // Read it back; never create another backup or overwrite uncertain data.
            if(remote(d.store.readBackup(p.snapshotId))!==remote(a.state))throw Error('保存途中のバックアップが不完全です。履歴を残して取得し直してください');
          }else{
            p.snapshotId=d.uuid();p.backupStarted=true;p.updatedAt=d.now();d.state.set('filterPreparation',p);
            const result=d.store.backup(a.state,p.snapshotId,stamp());
            if(!result||result.id!==p.snapshotId||result.hash!==remote(a.state))throw Error('バックアップ保存の検証に失敗しました');
          }
          p.phase='VERIFY_BACKUP';
        }else if(p.phase==='VERIFY_BACKUP'){
          const a=d.store.readJobData(p.approval);if(remote(d.store.readBackup(p.snapshotId))!==remote(a.state))throw Error('バックアップ読み返しが一致しません');
          const ticket={policy:a.policy,scopeMode:a.scopeMode,legacyCleanupHash:a.legacyCleanup?digest(a.legacyCleanup.source):undefined,runId:a.runId,fingerprint:a.fingerprint,snapshotId:p.snapshotId,summary:a.summary,preparedAt:p.ticket?.preparedAt??d.now(),jobApproval:p.approval,previousRunId:p.previousRunId||'',jobCounts:{filters:a.entries.filter(e=>e.kind!=='LABEL'&&queued(a,e)).length,labels:a.entries.filter(e=>e.kind==='LABEL'&&queued(a,e)).length}};
          if(a.selected){
            let saved;try{saved=d.store.readScope(p.snapshotId);}catch(_){if(p.scopeStarted)throw Error('選択範囲の保存途中です。取得し直してください');}
            if(saved===undefined){p.scopeStarted=true;d.state.set('filterPreparation',p);d.store.writeScope(p.snapshotId,a.keys,stamp());saved=d.store.readScope(p.snapshotId);}
            if(digest(saved)!==digest(a.keys))throw Error('選択対象の読み返しが一致しません');ticket.selection={hash:digest(a.keys),count:a.keys.length};
          }
          // Persist expiry and receipt before issuing READY. Termination after
          // this point must neither renew the deadline nor write scope twice.
          p.ticket=ticket;d.state.set('filterPreparation',p);
          p.phase='READY';p.status='READY';d.state.set('prepared',ticket);d.scheduler.clear();
        }
      }catch(e){p.status='PAUSED';p.error=('確認準備を中断しました。'+String(e.message||e)).slice(0,300);d.scheduler.clear();}
      p.timings=p.timings||{};p.timings[phase]=(p.timings[phase]||0)+Math.max(0,d.now()-started);p.updatedAt=d.now();d.state.set('filterPreparation',p);return {preparationId:p.preparationId,status:p.status,phase:p.phase,error:p.error||''};
    }
    function run(){return d.withLock(()=>{
      const preparation=d.state.get('filterPreparation');if(preparation?.status==='PREPARING')return prepareRun(preparation);
      const j=d.state.get('filterJob');if(!j){d.scheduler.clear();return null;}identity(j);if(terminal(j)){d.scheduler.clear();return view(j);}
      if(j.status==='RUNNING'&&j.leaseUntil>d.now())return view(j);
      if(d.now()-j.createdAt>24*60*60*1000||j.runs>=1000||j.attempts>=5){j.status='PAUSED';j.error='自動継続の上限に達しました。残りの差分を再確認してください';head(j);d.scheduler.clear();history(j,'PAUSED');return view(j);}
      j.status='RUNNING';j.heartbeat=d.now();j.leaseUntil=d.now()+150000;j.runs++;head(j);
      let m=null,a=null,rs,ls,state,entries,loaded=false;
      function counts(){if(!loaded)return;j.filters.completed=entries.slice(0,m.cursor).filter(e=>e.kind!=='LABEL').length;j.labels.completed=entries.slice(0,m.cursor).filter(e=>e.kind==='LABEL').length;j.filters.remaining=j.filters.planned-j.filters.completed;j.labels.remaining=j.labels.planned-j.labels.completed;}
      function save(){counts();j.intentPhase=m.intent?.phase||'';j.checkpoint=d.store.writeJobData(j.runId,m);j.heartbeat=d.now();head(j);}
      function measure(code,fn){const started=d.now();try{return fn();}finally{const elapsedMs=Math.max(0,d.now()-started);j.timings[code]=(j.timings[code]||0)+elapsedMs;if(d.logger){d.logger.emit(j.runId,'TIMING',code,{elapsedMs});if(elapsedMs>=10000)d.logger.emit(j.runId,'SLOW',code,{elapsedMs});}}}
      function pause(message,uncertain){const e=Error(message);e.pause=true;e.uncertain=uncertain?1:0;throw e;}
      function assertRemote(actual){if(authoritative(a)){state=C.clone(actual);return;}if(remote(actual)!==remote(state))pause('実行中にGmailが変更されています。残りの差分を再確認してください');}
      function currentRows(){return measure('SHEET_READ',()=>({rs:d.store.readRows(),ls:d.store.readLabelRows()}));}
      function assertRows(){const live=currentRows();if(digest(config(live.rs,live.ls))!==digest(config(rs,ls)))pause('実行中にシートの定義が変更されています。残りの差分を再確認してください');}
      function applyPatches(patches){
        // Persist proposed values before writing: a response loss can reconcile any
        // subset written without treating our own metadata as an external edit.
        m.intent={phase:'PATCH',patches,resume:m.intent?.phase==='DONE'?{...m.intent,phase:'COMMIT'}:null};save();reconcilePatch();
      }
      function reconcilePatch(){
        const resume=m.intent.resume,patches=m.intent.patches,expectedRs=C.clone(rs),expectedLs=C.clone(ls);
        if(!d.store.batchJobPatches){const live=currentRows();
        for(const p of patches){const original=(p.kind==='LABEL'?ls:rs).find(r=>(p.kind==='LABEL'?r.LabelKey:r.RuleKey)===p.key),actual=(p.kind==='LABEL'?live.ls:live.rs).find(r=>(p.kind==='LABEL'?r.LabelKey:r.RuleKey)===p.key);
          if(!original||!actual)pause('シートの対象行が変更されています');
          for(const [field,value]of Object.entries(p.values)){if(String(actual[field]||'')!==String(original[field]||'')&&String(actual[field]||'')!==String(value||''))pause('実行中にシートが変更されています');actual[field]=original[field];}
        }
        if(digest(config(live.rs,live.ls))!==digest(config(rs,ls)))pause('実行中にシートの定義が変更されています');}
        if(d.store.batchJobPatches)d.store.batchJobPatches(patches,rs,ls);
        else for(const p of patches){if(p.kind==='LABEL')d.store.updateLabelRow(p.key,p.values);else if(p.reference)d.store.setFilterLabel(p.key,rs.find(r=>r.RuleKey===p.key),JSON.parse(p.values.UserLabelRef));else d.store.updateRow(p.key,p.values);}
        for(const p of patches){Object.assign((p.kind==='LABEL'?expectedLs:expectedRs).find(r=>(p.kind==='LABEL'?r.LabelKey:r.RuleKey)===p.key),p.values);Object.assign((p.kind==='LABEL'?m.labelPatches:m.filterPatches)[p.key]||((p.kind==='LABEL'?m.labelPatches:m.filterPatches)[p.key]={}),p.values);}
        rs=expectedRs;ls=expectedLs;if(!d.store.batchJobPatches)assertRows();m.intent=resume||null;save();
      }
      function newStateFilter(f){state.filters.push(C.clone(f));m.createdFilters.push(C.clone(f));}
      function reconcileApi(){
        const i=m.intent,e=i.entry,live=d.gmail.read();
        if(i.phase==='CREATE'){
          const known=new Set(i.knownFilterIds||state.filters.map(f=>f.id)),matches=live.filters.filter(f=>!known.has(f.id)&&C.equal(f,e.after));
          if(matches.length!==1)pause('作成結果が不明です（候補'+matches.length+'件）。自動再作成せず照合が必要です',true);
          const found=matches[0];newStateFilter(found);assertRemote(live);m.intent={phase:'CREATED',entry:e,newId:found.id,knownFilterIds:i.knownFilterIds};save();
        }else if(i.phase==='DELETE'){
          const old=live.filters.find(f=>f.id===e.before.id);
          if(old){if(!authoritative(a)&&!C.equal(old,e.before))pause('削除対象が変更されています');assertRemote(live);assertRows();d.gmail.delete(e.before.id);return;}
          state.filters=state.filters.filter(f=>f.id!==e.before.id);m.deletedFilters.push(e.before.id);assertRemote(live);m.intent={phase:'DONE',entry:e,newId:i.newId||e.keepId||''};save();
        }else if(i.phase==='LABEL'){
          const found=e.operation==='CREATE'?live.labels.filter(l=>!state.labels.some(x=>x.id===l.id)&&l.type==='user'&&l.name===e.after.name):live.labels.filter(l=>l.id===e.after.id&&l.type==='user'&&l.name===e.after.name);
          if(found.length!==1)pause('ラベルの反映結果が不明です。照合してから再確認してください',true);
          const l=found[0],at=state.labels.findIndex(x=>x.id===l.id);if(at<0)state.labels.push(l);else state.labels[at]=l;m.labelChanges[l.id]=l;assertRemote(live);m.intent={phase:'DONE',entry:e,newId:l.id};save();
        }
      }
      function step(){
        if(j.phase==='SHEET_READ'){assertRows();j.phase='DIFF_CHECK';save();return;}
        if(j.phase==='DIFF_CHECK'){measure('DIFF_CHECK',()=>{assertRows();assertRemote(d.gmail.read());if(j.ticket.selection){const keys=d.store.readScope(j.ticket.snapshotId);if(!Array.isArray(keys)||keys.length!==j.ticket.selection.count||digest(keys)!==j.ticket.selection.hash||digest(keys)!==digest(a.keys))pause('保存済みの選択対象が変更されています');}if(digest(config(rs,ls))!==digest(config(a.rows,a.labelRows)))pause('承認したシートの定義が変更されています');});j.phase='BACKUP_CHECK';save();return;}
        if(j.phase==='BACKUP_CHECK'){measure('BACKUP_CHECK',()=>{if(remote(d.store.readBackup(j.ticket.snapshotId))!==remote(a.state))pause('承認済みバックアップの検証が一致しません');});j.phase='REFERENCES';save();return;}
        if(j.phase==='REFERENCES'){
          measure('REFERENCES',()=>{assertRows();const allowed=new Set(a.entries.filter(e=>e.kind==='LABEL').map(e=>e.labelKey)),slice=rs.slice(m.refCursor,m.refCursor+25),patches=[];
            for(const r of slice){const ref=a.bindings[r.RuleKey];if(ref&&allowed.has(ref.key)){const binding={key:ref.key,name:r.UserLabel};if(r.UserLabelRef!==JSON.stringify(binding))patches.push({key:r.RuleKey,reference:true,values:{UserLabel:r.UserLabel,UserLabelRef:JSON.stringify(binding)}});}}
            if(patches.length)applyPatches(patches);m.refCursor+=slice.length;if(m.refCursor>=rs.length)j.phase='APPLY';save();});return;
        }
        if(j.phase==='VERIFY'){
          measure('VERIFY',()=>{assertRows();const live=d.gmail.read();assertRemote(live);finishLegacyCleanup(j,a,state,rs);if(authoritative(a)){const result=P.report(a,rs,ls,live);m.verification=result;j.verification={status:result.status,inScope:result.inScope,outside:result.outside,remoteOnly:result.remoteOnly,at:d.now()};}});j.status='OK';j.leaseUntil=0;save();if(j.verification)keepVerification(j);history(j,j.verification?.status==='DIFFERENCES'?'OK_WITH_DIFFERENCES':'OK');d.scheduler.clear();return;
        }
        measure('GMAIL_UPDATE',()=>{
          if(m.intent?.phase==='PATCH'){reconcilePatch();return;}
          if(m.intent&&['CREATE','DELETE','LABEL'].includes(m.intent.phase)){reconcileApi();return;}
          if(m.intent?.phase==='CREATED'){
            const i=m.intent,e=i.entry;assertRemote(d.gmail.read());
            if(e.operation==='REPLACE'){m.intent={phase:'DELETE',entry:e,newId:i.newId};save();assertRows();d.gmail.delete(e.before.id);return;}
            m.intent={phase:'DONE',entry:e,newId:i.newId};save();return;
          }
          if(m.intent?.phase==='COMMIT'){m.cursor++;m.intent=null;j.uncertain=0;save();return;}
          if(m.intent?.phase==='DONE'){
            const i=m.intent,e=i.entry,id=i.newId;
            if(e.kind==='LABEL')applyPatches([{kind:'LABEL',key:e.labelKey,values:{GmailLabelId:id,SyncedName:e.after.name,SyncedAt:stamp(),Result:e.operation+' OK'}}]);
            else applyPatches([{key:e.ruleKey,values:{GmailFilterId:id,SyncedAt:stamp(),SyncedHash:e.after?digest(C.normalize(e.after)):'',Result:e.operation+' OK'}}]);
            // Metadata reconciliation can be repeated safely. Counting is saved with
            // cursor advancement, so a death before this checkpoint repeats only metadata.
            return;
          }
          if(m.cursor>=entries.length){j.phase='FINAL_REFERENCES';save();return;}
          let e=C.clone(entries[m.cursor]);
          if(authoritative(a)){assertRows();assertRemote(d.gmail.read());e=P.entry(a,e,rs,ls,state);}
          if(e.after?.action)for(const k of ['addLabelIds','removeLabelIds'])if(e.after.action[k])e.after.action[k]=e.after.action[k].map(id=>{if(!id.startsWith('gfm-label:'))return id;const row=ls.find(r=>L.virtualId(r.LabelKey)===id);if(!row?.GmailLabelId)pause('依存するラベルが未確認です');return row.GmailLabelId;});
          assertRemote(d.gmail.read());
          if(authoritative(a)&&e.operation==='NOOP'&&!e.matchedId){m.cursor++;j.uncertain=0;save();return;}
          if(e.kind==='LABEL'){
            if(e.operation==='NOOP'){m.intent={phase:'DONE',entry:e,newId:e.matchedId||e.after.id};save();return;}
            m.intent={phase:'LABEL',entry:e};save();assertRows();if(e.operation==='CREATE')d.gmail.createLabel(e.after.name);else d.gmail.renameLabel(e.after.id,e.after.name);return;
          }
          if(e.operation==='CREATE'||e.operation==='REPLACE'){
            // Keep the current pre-create ID universe across workers and fresh recovery.
            if(state.filters.length>=1000)pause('フィルター上限1000件のため停止しました');m.intent={phase:'CREATE',entry:e,knownFilterIds:state.filters.map(f=>f.id)};save();assertRows();d.gmail.create(e.after);return;
          }
          if(e.operation==='DELETE'){if(e.jobCleanup||e.cleanup){const keep=state.filters.find(f=>f.id===e.keepId);if(!keep)pause('置換後の維持対象が見つかりません');}m.intent={phase:'DELETE',entry:e,newId:e.keepId||''};save();assertRows();d.gmail.delete(e.before.id);return;}
          m.intent={phase:'DONE',entry:e,newId:e.matchedId||e.before?.id||''};save();
        });
      }
      try{
      m=j.checkpoint?d.store.readJobData(j.checkpoint):{filterPatches:{},labelPatches:{},createdFilters:[],deletedFilters:[],labelChanges:{},cursor:0,refCursor:0,intent:null};
      a=d.store.readJobData(j.ticket.jobApproval);
      if(j.legacyCleanup){identity(a.legacyCleanup);if(digest(a.legacyCleanup.source)!==j.legacyCleanup.sourceHash)pause('中断した置換の承認記録が変更されています');const c=d.state.get('cleanup');if(c?digest(c)!==j.legacyCleanup.sourceHash:j.phase!=='VERIFY')pause('中断した置換の復旧記録が変更されています');if(d.state.get('pending')||d.state.get('labelPending'))pause('中断操作が追加されています');}
        try{
        const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
        if(!record(a)||!Array.isArray(a.rows)||!Array.isArray(a.labelRows)||!record(a.state)||!['filters','labels','forwarding'].every(k=>Array.isArray(a.state[k]))||!Array.isArray(a.entries)||!Array.isArray(a.keys)||!record(a.bindings))throw Error('approval shape');
        if(!record(m)||!['filterPatches','labelPatches','labelChanges'].every(k=>record(m[k]))||!['createdFilters','deletedFilters'].every(k=>Array.isArray(m[k]))||!Number.isSafeInteger(m.cursor)||m.cursor<0||!Number.isSafeInteger(m.refCursor)||m.refCursor<0||m.intent&&(!record(m.intent)||!['CREATE','CREATED','DELETE','LABEL','DONE','PATCH','COMMIT'].includes(m.intent.phase)))throw Error('checkpoint shape');
      rs=C.clone(a.rows);ls=C.clone(a.labelRows);state=C.clone(a.state);
      rs.forEach(r=>Object.assign(r,m.filterPatches[r.RuleKey]||{}));ls.forEach(r=>Object.assign(r,m.labelPatches[r.LabelKey]||{}));
      state.filters=state.filters.filter(f=>!m.deletedFilters.includes(f.id)).concat(C.clone(m.createdFilters));
      Object.values(m.labelChanges).forEach(l=>{const i=state.labels.findIndex(x=>x.id===l.id);if(i<0)state.labels.push(l);else state.labels[i]=l;});
      if((a.policy||'')!==(j.ticket.policy||''))throw Error('approval policy');
      entries=a.entries.filter(e=>queued(a,e));const labelEntries=entries.filter(e=>e.kind==='LABEL');
      j.filters.planned=entries.length-labelEntries.length;j.labels.planned=labelEntries.length;
          if(m.cursor>entries.length)throw Error('cursor');loaded=true;
        }catch(_){const e=Error('保存済みジョブの形式が破損しています。検証してから再確認してください');e.code='GFM_DATA_INTEGRITY';throw e;}
        // Each preparation stage gets its own execution; mutation stages are bounded
        // by elapsed time AND a small stage count, including reconciliation/checkpoints.
        const start=d.now(),preparing=!['APPLY','FINAL_REFERENCES','VERIFY'].includes(j.phase);
        if(m.intent?.phase==='PATCH')reconcilePatch();
        for(let n=0;n<(preparing?1:10)&&!terminal(j)&&d.now()-start<(d.maxMillis||90000);n++){
          if(j.phase==='FINAL_REFERENCES'){
            measure('REFERENCES',()=>{assertRows();const slice=rs.slice(m.finalRefCursor||0,(m.finalRefCursor||0)+25),allowed=new Set(a.entries.filter(e=>e.kind==='LABEL').map(e=>e.labelKey)),patches=[];
              for(const r of slice){const ref=a.bindings[r.RuleKey];if(ref&&allowed.has(ref.key)&&r.UserLabel!==ref.name)patches.push({key:r.RuleKey,reference:true,values:{UserLabel:ref.name,UserLabelRef:JSON.stringify(ref)}});}
              if(patches.length)applyPatches(patches);m.finalRefCursor=(m.finalRefCursor||0)+slice.length;if(m.finalRefCursor>=rs.length)j.phase='VERIFY';save();});
          }else step();
        }
        if(!terminal(j)){j.status='WAITING';j.leaseUntil=0;j.attempts=0;save();}
      }catch(err){j.attempts++;const Sheets=typeof module!=='undefined'?require('./Sheets'):GFMSheets,invalid=err.code==='GFM_DATA_INTEGRITY';
        // assertRows and checkpoint recovery can fail before the adapter's write
        // boundary. Apply the same safe classification to reference prechecks.
        if(!invalid&&err.code!=='GFM_REFERENCE_UPDATE'&&(['REFERENCES','FINAL_REFERENCES'].includes(j.phase)||m?.intent?.phase==='PATCH'))err=Sheets.referenceFailure(err,'PRECHECK',m?.intent?.patches?.length||0);
        const safe=Sheets.referenceDiagnostic(err);
        if(safe)j.diagnostic={...safe,operation:'REFERENCE_UPDATE',at:d.now(),attempt:j.attempts};
        j.status=err.pause||invalid||safe&&!safe.retryable||j.attempts>=5?'PAUSED':'WAITING';j.error=safe?'参照情報の更新に失敗しました（'+safe.stage+' / '+safe.code+'）。'+(safe.retryable&&j.attempts<5?'保存済みの更新意図を照合して再試行します。':'状態を確認して残りの差分を再確認してください。'):invalid?'保存済みジョブの検証に失敗しました。破損したデータを再適用せず確認してください':err.pause?err.message:j.attempts>=5?'保存済みジョブの読取・実行障害が続いたため停止しました。状態を確認してください':'処理を中断しました。保存済みの実行意図を次回照合します';j.uncertain=err.uncertain||j.uncertain||(['CREATE','DELETE','LABEL'].includes(m?.intent?.phase||j.intentPhase)?1:0);j.leaseUntil=0;counts();head(j);history(j,j.status);if(d.logger)d.logger.emit(j.runId,err.pause?'REVIEW_REQUIRED':'RECOVERY',j.phase,{});if(terminal(j))d.scheduler.clear();}
      return view(j);
    });}
    function keepVerification(j){
      d.state.set('filterVerification:'+j.runId,{runId:j.runId,actor:j.actor,bookId:j.bookId,checkpoint:j.checkpoint,verification:j.verification});
      const ids=(d.state.get('filterVerificationIndex')||[]).filter(id=>id!==j.runId);ids.push(j.runId);
      while(ids.length>12)d.state.remove('filterVerification:'+ids.shift());d.state.set('filterVerificationIndex',ids);
    }
    function verification(runId){
      const current=d.state.get('filterJob'),j=current?.runId===runId?current:d.state.get('filterVerification:'+runId);
      if(!j||j.runId!==runId)throw Error('この実行ジョブの照合結果は見つかりません');identity(j);
      if(j.status&&j.status!=='OK'||!j.verification||j.checkpoint?.runId!==runId)throw Error('反映後の照合結果はまだありません');
      const m=d.store.readJobData(j.checkpoint);if(!m.verification||!Array.isArray(m.verification.entries))throw Error('照合結果を検証できません');
      return {runId,verification:C.clone(j.verification),entries:C.clone(m.verification.entries),labels:C.clone(m.verification.labels||[])};
    }
    return {prepareRemaining,prepareStart,prepareStatus,accept,status,run,verification};
  }
  return {create};
})();
function GFM_runFilterJob(){try{return GFMRuntime.open().jobs.run();}catch(_){/* No raw service error reaches automatic Cloud logs. Status/lease detects cutoffs. */return null;}}
if(typeof module!=='undefined')module.exports=GFMJobs;
