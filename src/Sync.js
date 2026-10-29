/* Orchestration depends only on injected synchronous adapters. */
var GFMSync = (function () {
  'use strict';
  function create(d) {
    const C=typeof module!=='undefined'?require('./Core.js'):GFMCore;
    const L=typeof module!=='undefined'?require('./Labels'):GFMLabels;
    const digest=v=>d.hash(C.stable(v));
    const date=()=>new Date(d.now()).toISOString();
    const log=(runId,command,details)=>d.store.history(Object.assign({runId,at:date(),actor:d.actor(),command},details||{}));
    const patch=(key,values)=>d.store.updateRow(key,values);
    function rows(){return d.store.readRows();}
    function labelRows(){return d.store.readLabelRows();}
    function ready(){d.store.ensureLabelSchema();d.store.ensureLabelKeys(d.uuid);}
    function allConfig(rs,lrs){return {filters:C.config(rs),labels:L.config(lrs)};}
    function resolve(rs,lrs,state){const lp=L.plan(lrs,state.labels);return {...L.resolve(rs,lrs,lp.labels,state.labels),labelPlan:lp,planState:{...state,labels:lp.labels}};}
    function syncReferences(rs,lrs,state,allowed,write){
      const resolved=resolve(rs,lrs,state);
      for(const r of rs){const ref=resolved.refs[r.RuleKey];if(ref&&allowed.has(ref.key)&&(r.UserLabel!==ref.name||r.UserLabelRef!==JSON.stringify(ref)))write(r,ref);}
    }
    function recoverLabel(){
      const j=d.state.get('labelPending');if(!j)return;
      const state=d.gmail.read(),lrs=labelRows(),r=lrs.find(r=>r.LabelKey===j.labelKey);
      if(!r||r.Name!==j.name)throw Error('中断したラベル定義が変更されています。履歴を確認してください');
      let found=state.labels.find(l=>l.id===j.newId||l.id===j.oldId&&j.operation!=='CREATE');
      if(j.operation==='CREATE'&&!found){const oldIds=new Set(d.store.readBackup(j.snapshotId).labels.map(l=>l.id));const candidates=state.labels.filter(l=>!oldIds.has(l.id)&&l.type==='user'&&l.name===j.name);if(candidates.length!==1)throw Error('ラベル作成結果が不明です。自動再作成せず履歴を確認してください');found=candidates[0];}
      if(!found||found.type!=='user')throw Error('中断したラベルが不明です');
      if(found.name!==j.name){if(j.operation==='REPLACE'&&found.name===j.beforeName){d.state.remove('labelPending');clearPreview();return;}throw Error('中断したラベルの名前が変更されています');}
      d.store.updateLabelRow(r.LabelKey,{GmailLabelId:found.id,SyncedName:r.Name,SyncedAt:date(),Result:'復旧済み'});r.GmailLabelId=found.id;
      syncReferences(rows(),lrs,state,new Set([r.LabelKey]),(row,ref)=>d.store.setFilterLabel(row.RuleKey,row,ref));
      log(j.runId,'LABEL_RECOVER',{ruleKey:L.entryKey(r.LabelKey),oldId:j.oldId,newId:found.id,result:'OK',snapshotId:j.snapshotId});
      d.state.remove('labelPending');clearPreview();
    }
    function journal(value){if(d.bookId){value.actor=d.actor();value.bookId=d.bookId;}d.state.set('pending',value);}
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
      if(j.actor!==undefined&&j.actor!==d.actor()||j.bookId!==undefined&&j.bookId!==d.bookId)throw Error('中断操作の実行者・スプレッドシートが一致しません');
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
    function build(rs,state,selectedKeys,lrs) {
      const resolved=resolve(rs,lrs||[],state);rs=resolved.rows;state=resolved.planState;
      let entries=C.plan(rs,state,selectedKeys).map(e=>resolved.errors[e.ruleKey]?{...e,operation:'ERROR',errors:[resolved.errors[e.ruleKey]]}:e);
      const cleanup=d.state.get('cleanup');
      if(cleanup) {
        const old=state.filters.find(f=>f.id===cleanup.oldId),r=rs.find(r=>r.RuleKey===cleanup.ruleKey);
        const fresh=state.filters.find(f=>f.id===cleanup.newId);
        if(!r||r.GmailFilterId!==cleanup.newId||!fresh||contentHash(fresh)!==cleanup.afterHash||r.Status!=='有効'||contentHash(C.toFilter(r,state).filter)!==cleanup.afterHash||(old&&contentHash(old)!==cleanup.beforeHash)) {
          entries.unshift({ruleKey:cleanup.ruleKey,operation:'ERROR',before:old||null,after:null,warnings:[],risks:[],errors:['中断した置換の設定が変化しています。復旧手順を確認してください']});
        } else if(old) {
          entries=entries.filter(e=>e.ruleKey!==cleanup.ruleKey&&!(e.operation==='REMOTE_ONLY'&&e.before.id===old.id));
          entries.unshift({ruleKey:cleanup.ruleKey,operation:'DELETE',before:old,after:null,matchedId:'',cleanup:true,keepId:cleanup.newId,warnings:['中断したREPLACEの旧フィルター削除。新フィルターは維持'],risks:[],errors:[]});
        } else if(d.state.get('filterJob')?.legacyCleanup?.sourceHash!==digest(cleanup))d.state.remove('cleanup');
      }
      return [...resolved.labelPlan.entries,...entries];
    }
    function legacyCleanupApproval(entries,state){
      const source=d.state.get('cleanup');if(!source)return null;
      if(source.actor!==undefined&&source.actor!==d.actor()||source.bookId!==undefined&&source.bookId!==d.bookId)throw Error('中断操作の実行者・スプレッドシートが一致しません');
      const baseline=d.store.readBackup(source.snapshotId),old=baseline.filters.find(f=>f.id===source.oldId),fresh=state.filters.find(f=>f.id===source.newId);
      const known=new Set(baseline.filters.map(f=>f.id)),matches=state.filters.filter(f=>!known.has(f.id)&&contentHash(f)===source.afterHash);
      if(!old||contentHash(old)!==source.beforeHash||!fresh||matches.length!==1||matches[0].id!==source.newId||source.oldId===source.newId)throw Error('中断した置換の旧・新IDをバックアップと照合できません');
      const cleanup=entries.filter(e=>e.cleanup&&e.ruleKey===source.ruleKey&&e.operation==='DELETE'&&e.before?.id===source.oldId&&e.keepId===source.newId);
      if(cleanup.length!==1)throw Error('中断した置換の削除対象を明示的に再確認してください');
      return {actor:d.actor(),bookId:d.bookId,source:C.clone(source)};
    }
    function snapshot() {
      const rs=rows(),lrs=labelRows(),state=d.gmail.read(),entries=build(rs,state,undefined,lrs);
      const fingerprint=digest({rows:allConfig(rs,lrs),state:C.remote(state),entries});
      return {rows:rs,labelRows:lrs,state,entries,fingerprint};
    }
    function summary(entries) {
      const s={CREATE:0,REPLACE:0,DELETE:0,NOOP:0,ERROR:0,REMOTE_ONLY:0,TRASH:0,FORWARD:0};
      entries.forEach(e=>{s[e.operation]++;e.risks.forEach(r=>s[r]++);});return s;
    }
    function checkedPreview() {
      const saved=d.state.get('preview');if(!saved)throw new Error('差分を再プレビューしてください');
      const current=snapshot();
      if(saved.fingerprint!==current.fingerprint)throw new Error('プレビュー後に設定またはGmailが変更されています。再プレビューしてください');
      return Object.assign(current,{runId:saved.runId});
    }
    function expandedKeys(current,keys){
      if(keys===null)return null;
      if(!Array.isArray(keys)||!keys.length||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||current.entries.filter(e=>e.ruleKey===k).length!==1))throw Error('適用する対象の選択が不正です');
      const selected=new Set(keys),resolved=resolve(current.rows,current.labelRows,current.state);
      for(const key of keys){const e=current.entries.find(e=>e.ruleKey===key);if(e.kind==='LABEL'||['DELETE','ERROR'].includes(e.operation))continue;const ref=resolved.refs[key];if(ref)selected.add(L.entryKey(ref.key));}
      const cleanup=d.state.get('cleanup');if(cleanup&&!selected.has(cleanup.ruleKey))throw Error('中断した復旧対象を含めて選択してください');
      return [...selected].sort();
    }
    function targets(current,keys) {
      const entries=keys===null?current.entries:build(current.rows,current.state,keys,current.labelRows).filter(e=>keys.includes(e.ruleKey));
      if(entries.some(e=>e.operation==='ERROR'))throw new Error('選択対象に入力エラーがあります。スプシとDiffを確認してください');
      return entries;
    }
    function importAll(approved,ticket) {
      ready();
      if(d.state.get('pending')||d.state.get('cleanup')||d.state.get('labelPending'))throw new Error('中断状態を先に差分プレビューで復旧してください');
      const rs=rows(),lrs=labelRows(),state=d.gmail.read();
      const known=new Set(rs.map(r=>r.GmailFilterId).filter(Boolean));
      const missing=state.filters.filter(f=>!known.has(f.id));
      const missingLabels=state.labels.filter(l=>l.type==='user'&&!lrs.some(r=>r.GmailLabelId===l.id||!r.GmailLabelId&&r.Name===l.name));
      const fingerprint=digest({rows:allConfig(rs,lrs),state:C.remote(state)});
      if(!approved)return {count:missing.length,total:state.filters.length,labelCount:missingLabels.length,labelTotal:state.labels.filter(l=>l.type==='user').length,fingerprint};
      if(ticket&&ticket.fingerprint!==fingerprint)throw new Error('取り込み確認後に変更されています。再確認してください');
      clearPreview();const runId=d.uuid(),snapshotId=backup(state);
      log(runId,'IMPORT',{result:'START',snapshotId});
      // Pre-build every row before any append so malformed/oversize inputs fail safely.
      const imported=missing.map(f=>Object.assign(C.importFilter(f,state.labels,d.uuid()),{SyncedAt:date(),SyncedHash:contentHash(f),Result:'取り込み済み'}));
      d.store.appendLabelRows(missingLabels.map(l=>({LabelKey:d.uuid(),Name:l.name,Note:'',GmailLabelId:l.id,SyncedName:l.name,SyncedAt:date(),Result:'取り込み済み'})));
      d.store.appendRows(imported);
      const actual=rows();
      if(state.filters.some(f=>actual.filter(r=>r.GmailFilterId===f.id).length!==1))throw new Error('全件取り込みの読み返しに失敗しました。再実行してください');
      d.state.set('importComplete',{at:date(),count:state.filters.length});
      log(runId,'IMPORT',{result:'OK',snapshotId,verification:'全件ID一致'});
      return {count:missing.length,total:state.filters.length,labelCount:missingLabels.length,labelTotal:state.labels.filter(l=>l.type==='user').length,runId,snapshotId};
    }
    function preview() {
      ready();clearPreview();recoverLabel();recover();d.store.ensureKeys(d.uuid);
      const current=snapshot(),runId=d.uuid();
      d.store.writeDiff(runId,current.entries);
      d.state.set('preview',{runId,fingerprint:current.fingerprint,at:date()});
      log(runId,'PREVIEW',{result:current.entries.some(e=>e.operation==='ERROR')?'ERROR':'OK',verification:JSON.stringify(summary(current.entries))});
      return {runId,entries:current.entries,summary:summary(current.entries),labels:resolve(current.rows,current.labelRows,current.state).planState.labels};
    }
    function capturePreparation(runId,selectedKeys) {
      ready();d.store.ensureKeys(d.uuid);
      if(d.state.get('pending')||d.state.get('labelPending'))throw Error('中断操作を先に復旧してください');
      const current=runId?checkedPreview():snapshot();
      if(runId&&current.runId!==runId)throw Error('別の差分が表示されています。再確認してください');
      const keys=expandedKeys(current,selectedKeys===undefined||selectedKeys===null?null:selectedKeys),entries=keys===null?current.entries:targets(current,keys);
      return {policy:d.applyPolicy,scopeMode:keys===null?'ALL':'SELECTED',legacyCleanup:legacyCleanupApproval(entries,current.state),runId:runId||d.uuid(),fingerprint:current.fingerprint,summary:summary(entries),rows:current.rows,labelRows:current.labelRows,state:current.state,entries,keys:keys===null?entries.map(e=>e.ruleKey):keys,selected:keys!==null,bindings:resolve(current.rows,current.labelRows,current.state).refs};
    }
    function prepareView(selectedKeys) {
      d.state.remove('prepared');
      if(d.state.get('pending')||d.state.get('labelPending'))throw new Error('中断操作があります。再プレビューしてください');
      const current=checkedPreview();
      const keys=expandedKeys(current,selectedKeys===undefined||selectedKeys===null?null:selectedKeys);
      const entries=targets(current,keys);
      const snapshotId=backup(current.state);
      const ticket={policy:d.applyPolicy,scopeMode:keys===null?'ALL':'SELECTED',runId:current.runId,fingerprint:current.fingerprint,snapshotId,summary:summary(entries),preparedAt:d.now()};
      if(keys!==null){const canonical=keys.slice().sort();d.store.writeScope(snapshotId,canonical,date());const actual=d.store.readScope(snapshotId);if(C.stable(actual)!==C.stable(canonical))throw new Error('選択対象の保存に失敗しました');ticket.selection={hash:digest(canonical),count:canonical.length};}
      ticket.jobCounts={filters:entries.filter(e=>e.kind!=='LABEL'&&e.operation!=='REMOTE_ONLY'&&(d.applyPolicy==='SHEET_AUTHORITATIVE'||e.operation!=='NOOP'||e.matchedId)).length,labels:entries.filter(e=>e.kind==='LABEL'&&(d.applyPolicy==='SHEET_AUTHORITATIVE'||e.operation!=='NOOP'||e.matchedId)).length};
      if(d.store.writeJobData)ticket.jobApproval=d.store.writeJobData(ticket.runId,{policy:d.applyPolicy,scopeMode:ticket.scopeMode,legacyCleanup:legacyCleanupApproval(entries,current.state),rows:current.rows,labelRows:current.labelRows,state:current.state,entries,keys:keys===null?entries.map(e=>e.ruleKey):keys,bindings:resolve(current.rows,current.labelRows,current.state).refs});
      if(d.state.get('cleanup'))ticket.legacyCleanupHash=digest(d.state.get('cleanup'));
      d.state.set('prepared',ticket);return {ticket:C.clone(ticket),entries:C.clone(entries),labels:C.clone(resolve(current.rows,current.labelRows,current.state).planState.labels)};
    }
    function prepare(selectedKeys){return prepareView(selectedKeys).ticket;}
    function apply(ticket,approved) {
      const prepared=d.state.get('prepared');
      if(!prepared||C.stable(ticket)!==C.stable(prepared))throw new Error('承認準備が失効しました。再プレビューしてください');
      if(!approved){clearPreview();log(ticket.runId,'APPLY',{result:'CANCELLED',snapshotId:ticket.snapshotId});return {status:'CANCELLED',completed:0};}
      if(d.now()-prepared.preparedAt>=15*60*1000)throw new Error('承認待ちが15分を超えました。再プレビューしてください');
      const current=checkedPreview();checkBackup(ticket.snapshotId,current.state);
      let keys=null;
      if(ticket.selection){keys=d.store.readScope(ticket.snapshotId);if(!Array.isArray(keys)||keys.length!==ticket.selection.count||digest(keys)!==ticket.selection.hash)throw new Error('保存済みの選択対象が一致しません');}
      current.entries=targets(current,keys);
      if(C.stable(summary(current.entries))!==C.stable(ticket.summary))throw new Error('承認した選択対象の差分が一致しません');
      if(d.state.get('pending')||d.state.get('labelPending'))throw new Error('中断操作があります。再プレビューしてください');
      clearPreview();
      const start=d.now();let completed=0,mutations=0,status='OK',error='',remaining=null;
      const expectedRows=C.clone(current.rows),expectedLabelRows=C.clone(current.labelRows),expectedState=C.clone(current.state);
      const assertRows=()=>{if(digest(allConfig(rows(),labelRows()))!==digest(allConfig(expectedRows,expectedLabelRows)))throw new Error('実行中にFiltersが変更されました。再プレビューが必要');};
      const assertState=state=>{if(digest(C.remote(state))!==digest(C.remote(expectedState)))throw new Error('実行中にGmailが変更されました。再プレビューが必要');};
      function ownLabelPatch(key,values){assertRows();d.store.updateLabelRow(key,values);Object.assign(expectedLabelRows.find(r=>r.LabelKey===key),values);assertRows();}
      function ownReference(row,ref){assertRows();d.store.setFilterLabel(row.RuleKey,row,ref);Object.assign(row,{UserLabel:ref.name,UserLabelRef:JSON.stringify(ref)});assertRows();}
      function ownPatch(key,values){assertRows();patch(key,values);Object.assign(expectedRows.find(r=>r.RuleKey===key),values);assertRows();}
      log(ticket.runId,'APPLY',{result:'START',snapshotId:ticket.snapshotId,verification:JSON.stringify({...ticket.summary,scope:keys?'SELECTED':'ALL',selected:keys?keys.length:undefined})});
      try {
        // Freeze legacy ID-to-key associations before any create changes a label's stored ID.
        // Keep the user's displayed value here; approved renames update it only after API readback.
        const labelKeys=new Set(current.entries.filter(e=>e.kind==='LABEL').map(e=>e.labelKey));
        const bindings=resolve(expectedRows,expectedLabelRows,expectedState).refs;
        for(const row of expectedRows){const target=bindings[row.RuleKey];if(target&&labelKeys.has(target.key)){const binding={key:target.key,name:row.UserLabel};if(row.UserLabelRef!==JSON.stringify(binding))ownReference(row,binding);}}
        for(const planned of current.entries) {
          if(planned.kind==='LABEL'){
            const e=planned,r=expectedLabelRows.find(r=>r.LabelKey===e.labelKey);
            if(e.operation==='NOOP'&&!e.matchedId){syncReferences(expectedRows,expectedLabelRows,expectedState,new Set([e.labelKey]),ownReference);completed++;continue;}
            if(d.now()-start>=(d.maxMillis||240000)||mutations>=(d.maxOperations||50)){status='PARTIAL';break;}
            assertRows();assertState(d.gmail.read());
            let id=e.matchedId||e.after.id;
            if(e.operation!=='NOOP'){
              const j={runId:ticket.runId,labelKey:e.labelKey,name:r.Name,operation:e.operation,oldId:r.GmailLabelId||'',beforeName:e.before?.name||'',snapshotId:ticket.snapshotId};d.state.set('labelPending',j);
              const result=e.operation==='CREATE'?d.gmail.createLabel(r.Name):d.gmail.renameLabel(id,r.Name);if(!result||!result.id||e.operation==='REPLACE'&&result.id!==id)throw Error('ラベル反映応答のIDが不明です');
              id=result.id;d.state.set('labelPending',{...j,newId:id});
              if(e.operation==='CREATE')expectedState.labels.push({id,name:r.Name,type:'user'});else expectedState.labels.find(l=>l.id===id).name=r.Name;
              mutations++;
            }
            assertState(d.gmail.read());
            ownLabelPatch(e.labelKey,{GmailLabelId:id,SyncedName:r.Name,SyncedAt:date(),Result:e.operation+' OK'});
            syncReferences(expectedRows,expectedLabelRows,expectedState,new Set([e.labelKey]),ownReference);
            log(ticket.runId,'LABEL_APPLY',{ruleKey:e.ruleKey,oldId:e.before?.id||'',newId:id,result:e.operation+' OK',snapshotId:ticket.snapshotId,verification:JSON.stringify({before:e.before?.name||'',after:r.Name})});
            d.state.remove('labelPending');completed++;continue;
          }
          const e=C.clone(planned);
          if(e.after)for(const name of ['addLabelIds','removeLabelIds'])if(e.after.action?.[name])e.after.action[name]=e.after.action[name].map(id=>{if(!id.startsWith('gfm-label:'))return id;const lr=expectedLabelRows.find(r=>L.virtualId(r.LabelKey)===id);if(!lr?.GmailLabelId)throw Error('依存ラベルの作成が未完了です');return lr.GmailLabelId;});
          const resolved=resolve(expectedRows,expectedLabelRows,expectedState),ref=resolved.refs[e.ruleKey];
          if(ref){const raw=expectedRows.find(r=>r.RuleKey===e.ruleKey);if(raw.UserLabel!==ref.name||raw.UserLabelRef!==JSON.stringify(ref))ownReference(raw,ref);}
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
        const verification=verify(ticket.runId,keys);remaining=verification.remaining;
        if(status==='OK'&&!verification.ok)status='RECOVERY_REQUIRED';
      } catch(err) {
        status=d.state.get('pending')||d.state.get('labelPending')?'RECOVERY_REQUIRED':'PARTIAL';error=err.message;
        try{log(ticket.runId,'APPLY',{result:status,error,snapshotId:ticket.snapshotId});}catch(logError){error+=' / 履歴書き込み失敗: '+logError.message;}
      }
      log(ticket.runId,'APPLY',{result:status,error,snapshotId:ticket.snapshotId,verification:'completed='+completed});
      return {status,completed,error,runId:ticket.runId,remaining};
    }
    function verify(runId,selectedKeys) {
      const current=snapshot();
      const entries=selectedKeys?build(current.rows,current.state,selectedKeys,current.labelRows).filter(e=>selectedKeys.includes(e.ruleKey)):current.entries;
      const unresolved=entries.filter(e=>!['NOOP','REMOTE_ONLY'].includes(e.operation));
      const remaining=selectedKeys?current.entries.filter(e=>!selectedKeys.includes(e.ruleKey)&&(!['NOOP','REMOTE_ONLY'].includes(e.operation)||(e.operation==='NOOP'&&e.matchedId))).length:0;
      const result={ok:unresolved.length===0&&!d.state.get('pending')&&!d.state.get('labelPending'),unresolved,remoteOnly:current.entries.filter(e=>e.operation==='REMOTE_ONLY').length,remaining};
      log(runId||d.uuid(),'VERIFY',{result:result.ok?'OK':'UNRESOLVED',verification:JSON.stringify({unresolved:unresolved.length,remoteOnly:result.remoteOnly,remaining})});return result;
    }
    return {capturePreparation,importAll,preview,prepare,prepareView,apply,verify};
  }
  return {create};
})();
if(typeof module!=='undefined')module.exports=GFMSync;
