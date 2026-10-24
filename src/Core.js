/* Pure functions; shared unchanged by Apps Script V8 and Node tests. */
var GFMCore = (function () {
  'use strict';
  const criteriaFields = {From:'from',To:'to',Subject:'subject',Query:'query',NegatedQuery:'negatedQuery',HasAttachment:'hasAttachment',ExcludeChats:'excludeChats',SizeBytes:'size',SizeComparison:'sizeComparison'};
  const actionFlags = {Archive:['removeLabelIds','INBOX'],MarkRead:['removeLabelIds','UNREAD'],NeverSpam:['removeLabelIds','SPAM'],MarkImportant:['addLabelIds','IMPORTANT'],NeverImportant:['removeLabelIds','IMPORTANT'],Star:['addLabelIds','STARRED'],MoveToTrash:['addLabelIds','TRASH']};
  const editable = ['Status','NameOrNote',...Object.keys(criteriaFields),'UserLabel',...Object.keys(actionFlags),'ForwardTo','AdditionalAddLabelIds','AdditionalRemoveLabelIds'];
  const columns = ['RuleKey',...editable,'GmailFilterId','SyncedAt','SyncedHash','Result','OriginalJson','OriginalRowJson'];
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  const blank = v => v === '' || v === undefined || v === null;
  const clone = v => JSON.parse(JSON.stringify(v));
  function stable(value) {
    if (Array.isArray(value)) return '['+value.map(stable).join(',')+']';
    if (value && typeof value === 'object') return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  function normalize(filter) {
    const f = {criteria:clone(filter.criteria || {}),action:clone(filter.action || {})};
    ['addLabelIds','removeLabelIds'].forEach(k=>{if(own(f.action,k)) f.action[k]=[...new Set(f.action[k])].sort();});
    return f;
  }
  const equal = (a,b) => stable(normalize(a))===stable(normalize(b));
  function jsonObject(text,label) {
    if(blank(text)) return {};
    let value;
    try { value=JSON.parse(text); } catch (_) { throw new Error(label+': JSON構文が不正'); }
    if(!value || Array.isArray(value) || typeof value!=='object') throw new Error(label+': JSONオブジェクトが必要');
    return value;
  }
  function ids(value,label) {
    if(blank(value)) return [];
    let result;
    try { result=JSON.parse(value); } catch (_) { throw new Error(label+': JSON配列が必要'); }
    if(!Array.isArray(result) || result.some(id=>typeof id!=='string'||!id)) throw new Error(label+': ラベルIDの文字列配列が必要');
    return [...new Set(result)];
  }
  function bool(value,label,tri) {
    if(blank(value)) return tri ? undefined : false;
    if(value===true || value==='TRUE' || value==='true') return true;
    if(value===false || value==='FALSE' || value==='false') return false;
    throw new Error(label+': 空欄/TRUE/FALSEで入力');
  }
  function scalar(value,col) {
    if(col==='HasAttachment'||col==='ExcludeChats') return bool(value,col,true);
    if(col==='SizeBytes') {
      if(blank(value))return undefined;
      if((typeof value!=='number'&&typeof value!=='string') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)>2147483647)throw new Error('SizeBytes: 0〜2147483647の整数が必要');
      return Number(value);
    }
    if(blank(value)) return undefined;
    if(typeof value!=='string')throw new Error(col+': 文字列が必要');
    return value;
  }
  function importFilter(filter,labels,key) {
    const r={};columns.forEach(k=>r[k]='');
    r.RuleKey=key;r.Status='有効';r.GmailFilterId=filter.id;
    const c=filter.criteria||{},a=filter.action||{};
    Object.keys(criteriaFields).forEach(col=>{const field=criteriaFields[col];if(own(c,field))r[col]=c[field];});
    const add=a.addLabelIds||[],remove=a.removeLabelIds||[];
    Object.keys(actionFlags).forEach(col=>{const [list,id]=actionFlags[col];r[col]=(a[list]||[]).includes(id);});
    const user=add.map(id=>labels.find(l=>l.id===id&&l.type==='user')).find(Boolean);
    if(user)r.UserLabel=user.name;
    const mappedAdd=Object.values(actionFlags).filter(x=>x[0]==='addLabelIds').map(x=>x[1]);
    const mappedRemove=Object.values(actionFlags).filter(x=>x[0]==='removeLabelIds').map(x=>x[1]);
    r.AdditionalAddLabelIds=JSON.stringify(add.filter(id=>!mappedAdd.includes(id)&&(!user||id!==user.id)));
    r.AdditionalRemoveLabelIds=JSON.stringify(remove.filter(id=>!mappedRemove.includes(id)));
    r.ForwardTo=a.forward||'';
    r.OriginalJson=JSON.stringify({criteria:c,action:a});
    r.OriginalRowJson=JSON.stringify(Object.fromEntries(editable.map(k=>[k,r[k]])));
    return r;
  }
  function toFilter(row,context) {
    const raw=jsonObject(row.OriginalJson,'OriginalJson'), baseline=jsonObject(row.OriginalRowJson,'OriginalRowJson');
    const f={criteria:clone(raw.criteria||{}),action:clone(raw.action||{})};
    const changed=col=>!own(baseline,col)||stable(scalarComparable(row[col],col))!==stable(scalarComparable(baseline[col],col));
    Object.keys(criteriaFields).forEach(col=>{
      const val=scalar(row[col],col),key=criteriaFields[col];
      if(changed(col)){if(val===undefined)delete f.criteria[key];else f.criteria[key]=val;}
    });
    if(!Object.keys(f.criteria).length || !Object.values(f.criteria).some(v=>v!==''&&v!==undefined&&v!==null))throw new Error('検索条件が空です');
    if(own(f.criteria,'sizeComparison')&&!['larger','smaller','unspecified'].includes(f.criteria.sizeComparison))throw new Error('SizeComparisonが不正');
    if(own(f.criteria,'size')!==own(f.criteria,'sizeComparison'))throw new Error('SizeBytesとSizeComparisonを両方指定してください');
    const flags={};Object.keys(actionFlags).forEach(k=>flags[k]=bool(row[k],k,false));
    if(flags.MarkImportant&&flags.NeverImportant)throw new Error('MarkImportantとNeverImportantは相反します');
    const extraAdd=ids(row.AdditionalAddLabelIds,'AdditionalAddLabelIds'),extraRemove=ids(row.AdditionalRemoveLabelIds,'AdditionalRemoveLabelIds');
    Object.keys(actionFlags).forEach(col=>{const [list,id]=actionFlags[col];if((list==='addLabelIds'?extraAdd:extraRemove).includes(id))throw new Error(id+'は専用列で設定してください');});
    let user;
    if(!blank(row.UserLabel)) {
      const matches=context.labels.filter(l=>l.type==='user'&&l.name===row.UserLabel);
      if(matches.length!==1)throw new Error('UserLabel: 存在しない、または曖昧なラベル名');
      user=matches[0].id;
    }
    const actionCols=[...Object.keys(actionFlags),'UserLabel','AdditionalAddLabelIds','AdditionalRemoveLabelIds'];
    if(actionCols.some(changed)) {
      f.action.addLabelIds=[...extraAdd,...(user?[user]:[])];f.action.removeLabelIds=[...extraRemove];
      Object.keys(actionFlags).forEach(col=>{if(flags[col]){const [list,id]=actionFlags[col];f.action[list].push(id);}});
      ['addLabelIds','removeLabelIds'].forEach(k=>{f.action[k]=[...new Set(f.action[k])];if(!f.action[k].length)delete f.action[k];});
    }
    ['addLabelIds','removeLabelIds'].forEach(k=>{
      if(own(f.action,k)&&(!Array.isArray(f.action[k])||f.action[k].some(id=>typeof id!=='string')))throw new Error(k+': 不正な配列');
      (f.action[k]||[]).forEach(id=>{if(!context.labels.some(l=>l.id===id))throw new Error('存在しないラベルID: '+id);});
    });
    const add=f.action.addLabelIds||[],remove=f.action.removeLabelIds||[];
    if(add.some(id=>remove.includes(id)))throw new Error('同じラベルの追加と除外は相反します');
    if(add.filter(id=>context.labels.some(l=>l.id===id&&l.type==='user')).length>1)throw new Error('ユーザーラベルは1フィルター1個まで');
    if(changed('ForwardTo')){if(blank(row.ForwardTo))delete f.action.forward;else f.action.forward=String(row.ForwardTo);}
    if(f.action.forward && !context.forwarding.some(a=>a.forwardingEmail===f.action.forward&&a.verificationStatus==='accepted'))throw new Error('ForwardTo: Gmailで検証済みの転送先が必要');
    const unknown=[...Object.keys(f.criteria).filter(k=>!Object.values(criteriaFields).includes(k)).map(k=>'criteria.'+k),...Object.keys(f.action).filter(k=>!['addLabelIds','removeLabelIds','forward'].includes(k)).map(k=>'action.'+k)];
    return {filter:f,unknown};
  }
  function scalarComparable(v,col) {
    if(own(criteriaFields,col))return scalar(v,col);
    if(own(actionFlags,col))return bool(v,col,false);
    if(col==='AdditionalAddLabelIds'||col==='AdditionalRemoveLabelIds')return ids(v,col).sort();
    return blank(v)?'':v;
  }
  function config(rows) {
    return rows.map(r=>Object.fromEntries(['RuleKey',...editable,'GmailFilterId','OriginalJson','OriginalRowJson'].map(k=>[k,blank(r[k])?'':r[k]]))).sort((a,b)=>String(a.RuleKey).localeCompare(String(b.RuleKey)));
  }
  function remote(state) {
    return {filters:state.filters.map(f=>({id:f.id,...normalize(f)})).sort((a,b)=>a.id.localeCompare(b.id)),labels:state.labels.map(l=>({id:l.id,name:l.name,type:l.type})).sort((a,b)=>a.id.localeCompare(b.id)),forwarding:state.forwarding.slice().sort((a,b)=>stable(a).localeCompare(stable(b)))};
  }
  function plan(rows,state) {
    const keyCounts={},idCounts={},claimed=new Set(),reserved=new Set(rows.map(r=>r.GmailFilterId).filter(Boolean));
    rows.forEach(r=>{keyCounts[r.RuleKey]=(keyCounts[r.RuleKey]||0)+1;if(r.GmailFilterId)idCounts[r.GmailFilterId]=(idCounts[r.GmailFilterId]||0)+1;});
    let capacity=state.filters.length;
    const desiredCounts={};
    rows.filter(r=>r.Status==='有効').forEach(r=>{try{const signature=stable(normalize(toFilter(r,state).filter));desiredCounts[signature]=(desiredCounts[signature]||0)+1;}catch(_){/* Each row reports its validation error below. */}});
    const entries=rows.slice().sort((a,b)=>String(a.RuleKey).localeCompare(String(b.RuleKey))).map(r=>{
      const before=state.filters.find(f=>f.id===r.GmailFilterId)||null;
      if(before)claimed.add(before.id);
      const e={ruleKey:r.RuleKey,operation:'ERROR',before,after:null,matchedId:'',warnings:[],risks:[],errors:[]};
      try {
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.RuleKey))throw new Error('RuleKeyはUUIDが必要');
        if(keyCounts[r.RuleKey]>1)throw new Error('RuleKeyが重複');
        if(r.GmailFilterId&&idCounts[r.GmailFilterId]>1)throw new Error('GmailFilterIdが重複');
        if(!['有効','無効','削除予定'].includes(r.Status))throw new Error('Statusが不正');
        // Disabled rules retain arbitrary original definitions, including future fields.
        if(r.Status!=='有効'){e.operation=before?'DELETE':'NOOP';return e;}
        const converted=toFilter(r,state);e.after=converted.filter;
        if(desiredCounts[stable(normalize(e.after))]>1){
          e.warnings.push('同等の定義がFilters内に複数あります');
          if(!before)throw new Error('未紐付けの同等定義が重複しています。RuleKey/IDを確認してください');
        }
        if(before)e.operation=equal(before,e.after)?'NOOP':'REPLACE';
        else {
          const candidates=state.filters.filter(f=>!claimed.has(f.id)&&!reserved.has(f.id)&&equal(f,e.after));
          if(candidates.length>1)throw new Error('同等フィルターが複数あります。IDを明示してください');
          if(candidates.length===1){e.operation='NOOP';e.matchedId=candidates[0].id;claimed.add(e.matchedId);e.warnings.push('同等フィルターのIDを紐付けます');}
          else e.operation='CREATE';
        }
        if(['CREATE','REPLACE'].includes(e.operation)){
          if(converted.unknown.length)throw new Error('未認識フィールドを再作成できません: '+converted.unknown.join(', '));
          if(capacity>=1000)throw new Error('フィルター上限1000件: 削除先行は禁止');
          if(e.operation==='CREATE')capacity++;
          if((e.after.action.addLabelIds||[]).includes('TRASH'))e.risks.push('TRASH');
          if(e.after.action.forward)e.risks.push('FORWARD');
          if(e.operation==='REPLACE')e.warnings.push('更新は非原子的です。新旧フィルターが一時的に同時に有効になり、転送等の副作用が重複する場合があります');
        }
      } catch(err){e.operation='ERROR';e.errors.push(err.message);}
      return e;
    });
    state.filters.filter(f=>!claimed.has(f.id)).forEach(f=>entries.push({ruleKey:'',operation:'REMOTE_ONLY',before:f,after:null,matchedId:'',warnings:['Gmail側のみ。自動削除禁止。取り込み操作で復旧してください'],risks:[],errors:[]}));
    return entries;
  }
  return {columns,editable,criteriaFields,actionFlags,stable,normalize,equal,clone,blank,importFilter,toFilter,config,remote,plan};
})();
if(typeof module!=='undefined')module.exports=GFMCore;
