/* Orchestration depends only on injected synchronous adapters. */
var GFMSync = (function () {
  'use strict';
  function create(d) {
    const C=typeof module!=='undefined'?require('./Core.js'):GFMCore;
    const digest=v=>d.hash(C.stable(v));
    const date=()=>new Date(d.now()).toISOString();
    const log=(runId,command,details)=>d.store.history(Object.assign({runId,at:date(),actor:d.actor(),command},details||{}));
    const patch=(key,values)=>d.store.updateRow(key,values);
    function rows(){return d.store.readRows();}
    function journal(value){d.state.set('pending',value);}
    function contentHash(f){return digest(C.normalize(f));}
    function clearPreview(){d.state.remove('preview');d.state.remove('prepared');}
    function checkBackup(snapshotId,state) {
      const saved=d.store.readBackup(snapshotId);
      if(digest(C.remote(saved))!==digest(C.remote(state)))throw new Error('バックアップ読み返しが一致しません');
    }
    function backup(state) {
      const snapshotId=d.uuid(),result=d.store.backup(state,snapshotId,date());
      if(!result||result.id!==snapshotId||result.count!==state.filters.length||result.hash!==digest(C.remote(state)))throw new Error('バックアップ記録に失敗しました');
      checkBackup(snapshotId,state);return snapshotId;
    }
    function recover() {
      const j=d.state.get('pending');if(!j)return;
      const state=d.gmail.read(),current=rows().filter(r=>r.RuleKey===j.ruleKey);
      if(current.length!==1)throw new Error('中断操作のRuleKeyが不明です。復旧手順を確認してください');
      const r=current[0];
      if(j.stage==='CREATE_INTENT'||j.stage==='CREATED') {
        if(r.GmailFilterId!==j.sourceId&&r.GmailFilterId!==j.oldId&&r.GmailFilterId!==j.newId)throw new Error('中断操作のIDが変更されています。復旧が必要');
        if(contentHash(C.toFilter(r,state).filter)!==j.afterHash)throw new Error('中断操作の設定が変更されています。復旧が必要');
        let found=state.filters.find(f=>j.newId&&f.id===j.newId);
        if(!j.newId){
          const baseline=d.store.readBackup(j.snapshotId),oldIds=new Set(baseline.filters.map(f=>f.id));
          const candidates=state.filters.filter(f=>!oldIds.has(f.id)&&contentHash(f)===j.afterHash);
          if(candidates.length!==1)throw new Error('作成結果が不明です（候補'+candidates.length+'件）。自動再作成は禁止。復旧手順を確認してください');
          found=candidates[0];j.newId=found.id;j.stage='CREATED';journal(j);
        }
        if(!found||contentHash(found)!==j.afterHash)throw new Error('作成済みフィルターが不明/変更済みです。復旧が必要');
        patch(j.ruleKey,{GmailFilterId:j.newId,SyncedAt:date(),SyncedHash:j.afterHash,Result:'ID復旧済み・再プレビュー必要'});
        if(j.oldId&&state.filters.some(f=>f.id===j.oldId))d.state.set('cleanup',j);
        log(j.runId,'RECOVER',{ruleKey:j.ruleKey,oldId:j.oldId,newId:j.newId,result:'ID_RECOVERED',snapshotId:j.snapshotId});
      } else if(j.stage==='DELETE_INTENT') {
        const old=state.filters.find(f=>f.id===j.oldId);
        if(old&&contentHash(old)!==j.beforeHash)throw new Error('削除対象が変更されています。復旧が必要');
        if(!old) {
          patch(j.ruleKey,{GmailFilterId:j.keepId||'',SyncedAt:date(),Result:'削除結果を復旧済み'});
          if(j.cleanup)d.state.remove('cleanup');
        }
        log(j.runId,'RECOVER',{ruleKey:j.ruleKey,oldId:j.oldId,newId:j.keepId||'',result:old?'DELETE_NOT_COMPLETED':'DELETE_RECOVERED',snapshotId:j.snapshotId});
      } else throw new Error('不明な操作ジャーナル。復旧が必要');
      d.state.remove('pending');clearPreview();
    }
    function build(rs,state) {
      let entries=C.plan(rs,state);
      const cleanup=d.state.get('cleanup');
      if(cleanup) {
        const old=state.filters.find(f=>f.id===cleanup.oldId),r=rs.find(r=>r.RuleKey===cleanup.ruleKey);
        const fresh=state.filters.find(f=>f.id===cleanup.newId);
        if(!r||r.GmailFilterId!==cleanup.newId||!fresh||contentHash(fresh)!==cleanup.afterHash||r.Status!=='有効'||contentHash(C.toFilter(r,state).filter)!==cleanup.afterHash||(old&&contentHash(old)!==cleanup.beforeHash)) {
          entries.unshift({ruleKey:cleanup.ruleKey,operation:'ERROR',before:old||null,after:null,warnings:[],risks:[],errors:['中断した置換の設定が変化しています。復旧手順を確認してください']});
        } else if(old) {
          entries=entries.filter(e=>!(e.operation==='REMOTE_ONLY'&&e.before.id===old.id));
          entries.unshift({ruleKey:cleanup.ruleKey,operation:'DELETE',before:old,after:null,matchedId:'',cleanup:true,keepId:cleanup.newId,warnings:['中断したREPLACEの旧フィルター削除。新フィルターは維持'],risks:[],errors:[]});
        } else d.state.remove('cleanup');
      }
      return entries;
    }
    function snapshot() {
      const rs=rows(),state=d.gmail.read(),entries=build(rs,state);
      const fingerprint=digest({rows:C.config(rs),state:C.remote(state),entries});
      return {rows:rs,state,entries,fingerprint};
    }
    function summary(entries) {
      const s={CREATE:0,REPLACE:0,DELETE:0,NOOP:0,ERROR:0,REMOTE_ONLY:0,TRASH:0,FORWARD:0};
      entries.forEach(e=>{s[e.operation]++;e.risks.forEach(r=>s[r]++);});return s;
    }
    function checkedPreview() {
      const saved=d.state.get('preview');if(!saved)throw new Error('差分を再プレビューしてください');
      const current=snapshot();
      if(saved.fingerprint!==current.fingerprint)throw new Error('プレビュー後に設定またはGmailが変更されています。再プレビューしてください');
      if(current.entries.some(e=>e.operation==='ERROR'))throw new Error('入力エラーがあります。Diffを確認してください');
      return Object.assign(current,{runId:saved.runId});
    }
    function importAll(approved,ticket) {
      if(d.state.get('pending')||d.state.get('cleanup'))throw new Error('中断状態を先に差分プレビューで復旧してください');
      const rs=rows(),state=d.gmail.read();
      const known=new Set(rs.map(r=>r.GmailFilterId).filter(Boolean));
      const missing=state.filters.filter(f=>!known.has(f.id));
      const fingerprint=digest({rows:C.config(rs),state:C.remote(state)});
      if(!approved)return {count:missing.length,total:state.filters.length,fingerprint};
      if(ticket&&ticket.fingerprint!==fingerprint)throw new Error('取り込み確認後に変更されています。再確認してください');
      clearPreview();const runId=d.uuid(),snapshotId=backup(state);
      log(runId,'IMPORT',{result:'START',snapshotId});
      // Pre-build every row before any append so malformed/oversize inputs fail safely.
      const imported=missing.map(f=>Object.assign(C.importFilter(f,state.labels,d.uuid()),{SyncedAt:date(),SyncedHash:contentHash(f),Result:'取り込み済み'}));
      d.store.appendRows(imported);
      const actual=rows();
      if(state.filters.some(f=>actual.filter(r=>r.GmailFilterId===f.id).length!==1))throw new Error('全件取り込みの読み返しに失敗しました。再実行してください');
      d.state.set('importComplete',{at:date(),count:state.filters.length});
      log(runId,'IMPORT',{result:'OK',snapshotId,verification:'全件ID一致'});
      return {count:missing.length,total:state.filters.length,runId,snapshotId};
    }
    function preview() {
      clearPreview();recover();d.store.ensureKeys(d.uuid);
      const current=snapshot(),runId=d.uuid();
      d.store.writeDiff(runId,current.entries);
      d.state.set('preview',{runId,fingerprint:current.fingerprint,at:date()});
      log(runId,'PREVIEW',{result:current.entries.some(e=>e.operation==='ERROR')?'ERROR':'OK',verification:JSON.stringify(summary(current.entries))});
      return {runId,entries:current.entries,summary:summary(current.entries)};
    }
    function prepare() {
      d.state.remove('prepared');
      if(d.state.get('pending'))throw new Error('中断操作があります。再プレビューしてください');
      const current=checkedPreview();
      const snapshotId=backup(current.state);
      const ticket={runId:current.runId,fingerprint:current.fingerprint,snapshotId,summary:summary(current.entries),preparedAt:d.now()};
      d.state.set('prepared',ticket);return C.clone(ticket);
    }
    function apply(ticket,approved) {
      const prepared=d.state.get('prepared');
      if(!prepared||C.stable(ticket)!==C.stable(prepared))throw new Error('承認準備が失効しました。再プレビューしてください');
      if(!approved){clearPreview();log(ticket.runId,'APPLY',{result:'CANCELLED',snapshotId:ticket.snapshotId});return {status:'CANCELLED',completed:0};}
      if(d.now()-prepared.preparedAt>15*60*1000)throw new Error('承認待ちが15分を超えました。再プレビューしてください');
      const current=checkedPreview();checkBackup(ticket.snapshotId,current.state);
      if(d.state.get('pending'))throw new Error('中断操作があります。再プレビューしてください');
      clearPreview();
      const start=d.now();let completed=0,mutations=0,status='OK',error='';
      const expectedRows=C.clone(current.rows),expectedState=C.clone(current.state);
      const assertRows=()=>{if(digest(C.config(rows()))!==digest(C.config(expectedRows)))throw new Error('実行中にFiltersが変更されました。再プレビューが必要');};
      const assertState=state=>{if(digest(C.remote(state))!==digest(C.remote(expectedState)))throw new Error('実行中にGmailが変更されました。再プレビューが必要');};
      function ownPatch(key,values){assertRows();patch(key,values);Object.assign(expectedRows.find(r=>r.RuleKey===key),values);assertRows();}
      log(ticket.runId,'APPLY',{result:'START',snapshotId:ticket.snapshotId,verification:JSON.stringify(ticket.summary)});
      try {
        for(const e of current.entries) {
          if(e.operation==='REMOTE_ONLY')continue;
          // Verified unchanged rules need no per-row Gmail reads or sheet writes.
          if(e.operation==='NOOP'&&!e.matchedId&&(e.before||!current.rows.find(r=>r.RuleKey===e.ruleKey).GmailFilterId)){completed++;continue;}
          d.notify(e.operation+' '+(completed+1));
          if(d.now()-start>=(d.maxMillis||240000)||mutations>=(d.maxOperations||50)){status='PARTIAL';break;}
          assertRows();
          const live=d.gmail.read();
          assertState(live);
          let newId=e.matchedId||(e.before?e.before.id:'');
          if(e.operation==='CREATE'||e.operation==='REPLACE') {
            if(live.filters.length>=1000)throw new Error('フィルター上限1000件。作成を中止');
            let j={runId:ticket.runId,ruleKey:e.ruleKey,stage:'CREATE_INTENT',sourceId:current.rows.find(r=>r.RuleKey===e.ruleKey).GmailFilterId||'',oldId:e.before?e.before.id:'',beforeHash:e.before?contentHash(e.before):'',afterHash:contentHash(e.after),snapshotId:ticket.snapshotId};
            journal(j);
            const fresh=d.gmail.create(e.after);
            if(!fresh||!fresh.id)throw new Error('作成応答のIDが不明');
            newId=fresh.id;j.newId=newId;j.stage='CREATED';journal(j);
            expectedState.filters.push({id:newId,...C.clone(e.after)});
            const afterCreate=d.gmail.read(),created=afterCreate.filters.find(f=>f.id===newId);
            if(!created||!C.equal(created,e.after))throw new Error('新規作成の事後検証に失敗');
            assertState(afterCreate);
            ownPatch(e.ruleKey,{GmailFilterId:newId,SyncedAt:date(),SyncedHash:contentHash(e.after),Result:'作成済み・処理中'});
            if(e.operation==='REPLACE') {
              d.state.set('cleanup',j);
              j={...j,stage:'DELETE_INTENT',cleanup:true,keepId:newId};journal(j);
              const old=afterCreate.filters.find(f=>f.id===e.before.id);
              if(!old||!C.equal(old,e.before))throw new Error('旧フィルターが変化したため削除を停止');
              d.gmail.delete(e.before.id);
              expectedState.filters=expectedState.filters.filter(f=>f.id!==e.before.id);
            }
            mutations++;
          } else if(e.operation==='DELETE') {
            journal({runId:ticket.runId,ruleKey:e.ruleKey,stage:'DELETE_INTENT',oldId:e.before.id,beforeHash:contentHash(e.before),snapshotId:ticket.snapshotId,cleanup:!!e.cleanup,keepId:e.keepId||''});
            d.gmail.delete(e.before.id);expectedState.filters=expectedState.filters.filter(f=>f.id!==e.before.id);newId=e.keepId||'';mutations++;
          }
          const after=d.gmail.read();
          assertState(after);
          if(e.operation==='DELETE') {
            if(after.filters.some(f=>f.id===e.before.id))throw new Error('削除後もフィルターが残存');
          } else if(e.after) {
            const f=after.filters.find(f=>f.id===newId);
            if(!f||!C.equal(f,e.after))throw new Error('適用後の内容が一致しません');
            if(e.operation==='REPLACE'&&after.filters.some(f=>f.id===e.before.id))throw new Error('置換後に旧フィルターが残存');
          }
          ownPatch(e.ruleKey,{GmailFilterId:newId,SyncedAt:date(),SyncedHash:e.after?contentHash(e.after):'',Result:e.operation==='NOOP'&&!e.after?'削除済み/無効':e.operation+' OK'});
          log(ticket.runId,'APPLY',{ruleKey:e.ruleKey,oldId:e.before?e.before.id:'',newId,result:e.operation+' OK',snapshotId:ticket.snapshotId,verification:'OK',risk:e.risks.join(',')});
          d.state.remove('pending');if(e.cleanup||e.operation==='REPLACE')d.state.remove('cleanup');
          completed++;
        }
        const verification=verify(ticket.runId);
        if(status==='OK'&&!verification.ok)status='RECOVERY_REQUIRED';
      } catch(err) {
        status=d.state.get('pending')?'RECOVERY_REQUIRED':'PARTIAL';error=err.message;
        try{log(ticket.runId,'APPLY',{result:status,error,snapshotId:ticket.snapshotId});}catch(logError){error+=' / 履歴書き込み失敗: '+logError.message;}
      }
      log(ticket.runId,'APPLY',{result:status,error,snapshotId:ticket.snapshotId,verification:'completed='+completed});
      return {status,completed,error,runId:ticket.runId};
    }
    function verify(runId) {
      const current=snapshot();
      const unresolved=current.entries.filter(e=>!['NOOP','REMOTE_ONLY'].includes(e.operation));
      const result={ok:unresolved.length===0&&!d.state.get('pending'),unresolved,remoteOnly:current.entries.filter(e=>e.operation==='REMOTE_ONLY').length};
      log(runId||d.uuid(),'VERIFY',{result:result.ok?'OK':'UNRESOLVED',verification:JSON.stringify({unresolved:unresolved.length,remoteOnly:result.remoteOnly})});return result;
    }
    return {importAll,preview,prepare,apply,verify};
  }
  return {create};
})();
if(typeof module!=='undefined')module.exports=GFMSync;
