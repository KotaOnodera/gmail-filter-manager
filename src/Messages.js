/* Existing-message operations. Discovery is read-only; approved work uses saved message IDs. */
var GFMMessages = (function () {
  'use strict';
  const core=()=>typeof module!=='undefined'?require('./Core'):GFMCore;
  function expression(value) {
    if(typeof value!=='string'||!value.trim()||/[\\\r\n\x00-\x1f]/.test(value))throw new Error('検索条件を安全に変換できません');
    const stack=[];let quoted=false;
    for(const ch of value){if(ch==='"'){quoted=!quoted;continue;}if(quoted)continue;if(ch==='('||ch==='{')stack.push(ch);else if(ch===')'||ch==='}'){if(stack.pop()!==(ch===')'?'(':'{'))throw new Error('検索条件の括弧が不正です');}}
    if(quoted||stack.length)throw new Error('検索条件の引用符・括弧が不正です');return value.trim();
  }
  function query(c,before) {
    const allowed=['from','to','subject','query','negatedQuery','hasAttachment','excludeChats','size','sizeComparison'];
    if(!c||Object.keys(c).some(k=>!allowed.includes(k)))throw new Error('未対応の検索条件があります');
    const terms=[];
    if(c.from)terms.push('from:('+expression(c.from)+')');
    if(c.to){const v=expression(c.to);terms.push('{to:('+v+') cc:('+v+') bcc:('+v+')}');}
    if(c.subject){const v=expression(c.subject).replace(/\s+/g,' ');if(v.includes('"'))throw new Error('件名の引用符を安全に変換できません');terms.push('subject:"'+v+'"');}
    if(c.query)terms.push('('+expression(c.query)+')');
    if(c.negatedQuery)terms.push('-('+expression(c.negatedQuery)+')');
    for(const k of ['hasAttachment','excludeChats'])if(c[k]!==undefined&&typeof c[k]!=='boolean')throw new Error('検索条件の真偽値が不正です');
    if(c.hasAttachment)terms.push('has:attachment');if(c.excludeChats)terms.push('-is:chat');
    if(c.sizeComparison&&c.sizeComparison!=='unspecified'){
      if(!['larger','smaller'].includes(c.sizeComparison)||!Number.isSafeInteger(c.size)||c.size<0)throw new Error('サイズ条件が不正です');terms.push(c.sizeComparison+':'+c.size);
    }
    if(!terms.length||!Number.isSafeInteger(before)||before<=0)throw new Error('検索条件が空または不正です');
    return terms.join(' ')+' before:'+before+' -in:spam -in:trash -in:drafts -in:sent';
  }
  function actions(action,labels) {
    const user=new Set(labels.filter(l=>l.type==='user').map(l=>l.id)),ignored=[];
    const add=[...new Set(action.addLabelIds||[])].filter(id=>{if(user.has(id))return true;ignored.push('追加: '+id);return false;});
    const remove=[...new Set(action.removeLabelIds||[])].filter(id=>{if(['INBOX','UNREAD'].includes(id))return true;ignored.push('除外: '+id);return false;});
    Object.keys(action).filter(k=>!['addLabelIds','removeLabelIds'].includes(k)).forEach(k=>ignored.push(k==='forward'?'転送: '+action[k]:k+': '+JSON.stringify(action[k])));
    return {action:{addLabelIds:add,removeLabelIds:remove},ignored};
  }
  function create(d) {
    const L=typeof module!=='undefined'?require('./Labels'):GFMLabels;
    const C=core(),saveData=(runId,v)=>d.store.writeMessageData(runId,v),readData=p=>d.store.readMessageData(p);
    const maxSteps=d.messageMaxSteps||5,batchSize=Math.min(100,d.messageBatchSize||100),maxMillis=d.messageMaxMillis||20000;
    function list(before) {
      d.store.ensureLabelSchema();
      const original=d.store.readRows(),remote=d.gmail.read(),labelRows=d.store.readLabelRows();before=before||Math.floor(d.now()/1000);
      const labelPlan=L.plan(labelRows,remote.labels),resolved=L.resolve(original,labelRows,labelPlan.labels,remote.labels),rows=resolved.rows;
      const entries=rows.filter(r=>r.Status==='有効').map(r=>{
        const entry={key:r.RuleKey,title:r.NameOrNote||r.From||r.Subject||r.Query||r.RuleKey,errors:[],ignored:[],eligible:false};
        try {
          if(resolved.errors[r.RuleKey])throw new Error(resolved.errors[r.RuleKey]);
          const ref=resolved.refs[r.RuleKey],dependency=ref&&labelPlan.entries.find(e=>e.labelKey===ref.key);
          if(dependency&&(dependency.operation!=='NOOP'||dependency.errors.length))throw new Error('先にラベル設定をGmailへ反映してください');
          if(!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(r.RuleKey)||rows.filter(x=>x.RuleKey===r.RuleKey).length!==1)throw new Error('RuleKeyが不正または重複しています');
          const filter=C.toFilter(r,remote).filter;Object.assign(entry,actions(filter.action,remote.labels),{filter,query:query(filter.criteria,before)});
          entry.eligible=!!(entry.action.addLabelIds.length||entry.action.removeLabelIds.length);
        }catch(e){entry.errors.push(e.message);}
        return entry;
      });return {entries,labels:remote.labels};
    }
    function jobFor(runId) {const j=d.state.get('messageJob');if(!j||j.runId!==runId)throw new Error('既存メールの実行IDが一致しません。保存済みの処理を確認してください');return j;}
    function summary(j) {return {kind:'MESSAGES',runId:j.runId,status:j.status,total:j.total,completed:j.completed,remaining:j.total-j.completed,uncertain:j.pending?j.pending.count:0,error:j.error||'',scanRule:j.rule,ruleCount:j.ruleCount,revision:j.revision};}
    function commit(j) {
      j.revision=(j.revision||0)+1;
      // Save a small checkpoint before logging or issuing any Gmail mutation.
      d.state.set('messageJob',j);
      d.store.history({runId:j.runId,at:new Date(d.now()).toISOString(),actor:d.actor(),command:'MESSAGES',result:j.status,error:j.error||'',snapshotId:j.runId,verification:JSON.stringify({...summary(j),cursor:j.cursor||null,offset:j.offset||0,head:j.head||null})});
    }
    function status(runId) {
      const j=jobFor(runId),plan=readData(j.plan),counts=readData(j.counts);
      return {...summary(j),entries:plan.entries.map((e,i)=>({...e,count:counts[i]})),labels:plan.labels,before:j.before};
    }
    function unchanged(j) {
      const saved=readData(j.plan),live=list(j.before);
      const current=saved.entries.map(e=>live.entries.find(x=>x.key===e.key));
      if(C.stable(current)!==C.stable(saved.entries))throw new Error('選択したフィルターの定義またはラベルが変更されています。中止して対象を再検索してください');
    }
    function start(keys) {
      const previous=d.state.get('messageJob');if(previous&&!['OK','CANCELLED'].includes(previous.status))throw new Error('保存済みの既存メール処理があります。続行または中止してください');
      const before=Math.floor(d.now()/1000),view=list(before);
      if(keys!==null&&(!Array.isArray(keys)||!keys.length||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!view.entries.some(e=>e.key===k))))throw new Error('既存メールへ適用する選択が不正です');
      const chosen=keys===null?view.entries:view.entries.filter(e=>keys.includes(e.key));
      if(chosen.some(e=>e.errors.length)||keys!==null&&chosen.some(e=>!e.eligible))throw new Error('選択対象に入力エラーまたは実行できる処理がありません');
      const entries=chosen.filter(e=>e.eligible);if(!entries.length)throw new Error('既存メールに適用できる有効なフィルターがありません');
      const runId=d.uuid(),j={runId,status:'SCANNING',before,rule:0,ruleCount:entries.length,pageToken:'',head:null,cursor:null,offset:0,total:0,completed:0,pending:null,revision:0};
      j.plan=saveData(runId,{entries,labels:view.labels});j.counts=saveData(runId,entries.map(()=>0));commit(j);return status(runId);
    }
    function scan(runId) {
      let j=jobFor(runId);if(!['SCANNING','SCAN_FAILED'].includes(j.status))throw new Error('検索を続行できる状態ではありません');
      const plan=readData(j.plan),counts=readData(j.counts),startTime=d.now();j.status='SCANNING';j.error='';
      try {
        for(let steps=0;steps<maxSteps&&d.now()-startTime<maxMillis&&j.rule<plan.entries.length;steps++){
          const entry=plan.entries[j.rule],page=d.gmail.listMessages(entry.query,j.pageToken);
          if(!page||!Array.isArray(page.ids)||page.ids.length>500||page.ids.some(id=>typeof id!=='string'||!id)||new Set(page.ids).size!==page.ids.length||typeof page.nextPageToken!=='string'||page.nextPageToken&&page.nextPageToken===j.pageToken)throw new Error('メール検索の応答が不正です');
          const head=page.ids.length?saveData(runId,{ids:page.ids,action:entry.action,ruleKey:entry.key,next:j.head}):j.head;
          counts[j.rule]+=page.ids.length;j.total+=page.ids.length;j.head=head;j.pageToken=page.nextPageToken;
          if(!j.pageToken)j.rule++;
          j.counts=saveData(runId,counts);
          if(j.rule===plan.entries.length){j.status='READY';j.cursor=j.head;}
          commit(j);
        }
        // A saved final page may outlive a failed History append/readback.
        if(j.rule===plan.entries.length&&j.status!=='READY'){j.status='READY';j.cursor=j.head;commit(j);}
      }catch(e){j=jobFor(runId);j.status='SCAN_FAILED';j.error=e.message;commit(j);}
      return status(runId);
    }
    function prepare(runId) {
      const j=jobFor(runId);if(!['READY','PARTIAL','FAILED','RUNNING'].includes(j.status))throw new Error('検索完了後に実行内容を確認してください');unchanged(j);
      const ticket={runId,revision:j.revision,at:d.now(),nonce:d.uuid()};d.state.set('messageApproval',ticket);return ticket;
    }
    function apply(ticket) {
      const saved=d.state.get('messageApproval');if(!saved||C.stable(saved)!==C.stable(ticket)||d.now()-ticket.at>15*60*1000)throw new Error('既存メール処理の確認が失効しました。再確認してください');
      let j=jobFor(ticket.runId);if(j.revision!==ticket.revision||!['READY','PARTIAL','FAILED','RUNNING'].includes(j.status))throw new Error('既存メール処理の状態が変更されています');
      unchanged(j);d.state.remove('messageApproval');const startTime=d.now();
      // Intent persistence must succeed before entering the mutation loop.
      j.status='RUNNING';j.error='';commit(j);
      try {
        for(let steps=0;steps<maxSteps&&j.cursor&&d.now()-startTime<maxMillis;steps++){
          const page=readData(j.cursor),ids=page.ids.slice(j.offset,j.offset+batchSize);
          if(!ids.length)throw new Error('保存済みの対象メールが不正です');
          j.pending={count:ids.length,ruleKey:page.ruleKey};commit(j);
          d.gmail.modifyMessages(ids,page.action);
          j.completed+=ids.length;j.offset+=ids.length;j.pending=null;
          if(j.offset===page.ids.length){j.cursor=page.next;j.offset=0;}
          j.status=j.cursor?'PARTIAL':'OK';commit(j);
        }
        if(!j.cursor&&j.status!=='OK'){j.status='OK';commit(j);}
        else if(j.status==='RUNNING'){j.status='PARTIAL';commit(j);}
      }catch(e){j=jobFor(ticket.runId);j.status='FAILED';j.error=e.message;commit(j);}
      return status(j.runId);
    }
    function cancel(runId) {const j=jobFor(runId);if(['OK','CANCELLED'].includes(j.status))throw new Error('この処理は終了しています');j.status='CANCELLED';d.state.remove('messageApproval');commit(j);return status(runId);}
    return {list,start,scan,status,prepare,apply,cancel};
  }
  return {query,actions,create};
})();
if(typeof module!=='undefined')module.exports=GFMMessages;
