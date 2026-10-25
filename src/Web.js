var GFMWeb = (function () {
  'use strict';
  function create(d) {
    const C=typeof module!=='undefined'?require('./Core'):GFMCore;
    const now=()=>d.now(),digest=v=>d.hash(C.stable(v));
    let context;
    const gmailContext=()=>context||(context=d.gmail.read());
    function exposed(r){const row=Object.fromEntries(['RuleKey',...C.editable,'Result','SyncedAt'].map(k=>[k,r[k]===undefined?'':r[k]]));try{row.unsynced=r.Status!=='有効'?!!r.GmailFilterId:!r.GmailFilterId||r.SyncedHash!==digest(C.normalize(C.toFilter(r,gmailContext()).filter));}catch(_){row.unsynced=true;}return row;}
    function detail(key){const found=d.store.readRows().filter(r=>r.RuleKey===key);if(found.length!==1)throw new Error('フィルターが見つかりません。再読込してください');return {row:exposed(found[0]),version:d.version(found[0]),isNew:false};}
    function invalidate(){['preview','prepared','webApproval','webImport'].forEach(k=>d.state.remove(k));}
    function page(input){return {offset:Math.max(0,Math.min(100000,Number.isSafeInteger(input.offset)?input.offset:0)),limit:20};}
    function validatePatch(patch) {
      if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('入力形式が不正です');
      const p={};Object.keys(patch).forEach(k=>{
        if(!C.editable.includes(k))throw new Error(k+'は編集できません');
        const v=patch[k];if(!['string','number','boolean'].includes(typeof v)||String(v).length>40000)throw new Error(k+'の値または長さが不正です');
        p[k]=typeof v==='boolean'?(v?'TRUE':'FALSE'):String(v);
      });
      if(p.Status!==undefined&&!['有効','無効','削除予定'].includes(p.Status))throw new Error('状態を選択してください');
      return p;
    }
    function validateRow(row){try{C.toFilter(row,d.gmail.read());return [];}catch(err){return [err.message];}}
    function save(input) {
      const p=validatePatch(input.patch),rs=d.store.readRows(),found=rs.filter(r=>r.RuleKey===input.key);
      if(found.length>1)throw new Error('RuleKeyが重複しています');
      const draft=d.state.get('draft:'+input.key);
      if(draft&&draft.version===input.version) {
        if(now()-draft.at>24*60*60*1000)throw new Error('新規作成の期限が切れました');
        const row=Object.fromEntries(C.columns.map(k=>[k,'']));Object.assign(row,{RuleKey:input.key,Status:'有効'},p);
        const target=d.version(row),requestHash=digest(p);
        if(draft.requestHash&&draft.requestHash!==requestHash)throw new Error('新規作成の内容が変更されています。再読込してください');
        if(found.length){if(d.version(found[0])!==target)throw new Error('作成後に変更されています。再読込してください');return {...detail(input.key),warnings:validateRow(found[0])};}
        d.state.set('draft:'+input.key,{...draft,requestHash});invalidate();
        d.store.appendRows([row]);
        d.store.history({runId:d.uuid(),at:new Date(now()).toISOString(),actor:d.actor(),command:'WEB_SAVE',ruleKey:input.key,result:'CREATED'});
        return {...detail(input.key),warnings:validateRow(row)};
      }
      if(found.length!==1||d.version(found[0])!==input.version)throw new Error('他の画面またはスプシで変更されています。再読込してください');
      const row={...found[0],...p},warnings=validateRow(row),changed={};
      Object.keys(p).forEach(k=>{if(String(found[0][k]??'')!==p[k])changed[k]=p[k];});
      invalidate();d.store.updateEditable(input.key,changed);
      d.store.history({runId:d.uuid(),at:new Date(now()).toISOString(),actor:d.actor(),command:'WEB_SAVE',ruleKey:input.key,result:'SAVED'});
      return {...detail(input.key),warnings};
    }
    function confirmation(kind,ticket){const token=d.uuid();d.state.set(kind,{token,ticket,at:now(),actor:d.actor(),bookId:d.bookId});return token;}
    function checked(kind,token){const c=d.state.get(kind);if(!c||!token||c.token!==token||c.actor!==d.actor()||c.bookId!==d.bookId)throw new Error('確認が無効です。もう一度確認してください');if(now()-c.at>15*60*1000)throw new Error('確認の期限が切れました。もう一度確認してください');return c;}
    function dispatch(action,input) {
      input=input||{};if(typeof input!=='object'||Array.isArray(input))throw new Error('入力形式が不正です');
      return d.withLock(()=>{
        if(action==='boot'){const context=d.gmail.read(),rs=d.store.readRows();return {total:rs.length,labels:context.labels,forwarding:context.forwarding.filter(f=>f.verificationStatus==='accepted'),fields:C.editable,account:d.actor()};}
        if(action==='list'){
          const query=String(input.query||'').toLowerCase().slice(0,1000),pg=page(input);
          const all=d.store.readRows(),rs=all.filter(r=>(!input.status||r.Status===input.status)&&['NameOrNote','From','To','Subject','Query','UserLabel'].some(k=>String(r[k]||'').toLowerCase().includes(query)));
          return {items:rs.slice(pg.offset,pg.offset+pg.limit).map(r=>({...exposed(r),version:d.version(r)})),total:rs.length,allTotal:all.length};
        }
        if(action==='detail')return detail(input.key);
        if(action==='new'){
          // A bounded set of draft receipts also provides idempotency for a lost save response.
          const keys=d.state.get('draftKeys')||[],fresh=keys.filter(k=>{const v=d.state.get('draft:'+k);if(!v||now()-v.at>24*60*60*1000){d.state.remove('draft:'+k);return false;}return true;});
          if(fresh.length>=20)throw new Error('新規作成を開きすぎています。24時間後に再試行してください');
          const key=d.uuid(),version=d.uuid(),row=Object.fromEntries(C.editable.map(k=>[k,'']));Object.assign(row,{RuleKey:key,Status:'有効'});
          d.state.set('draft:'+key,{version,at:now()});d.state.set('draftKeys',[...fresh,key]);return {row,version,isNew:true};
        }
        if(action==='save')return save(input);
        if(action==='importCheck'){const ticket=d.controller.importAll(false);return {count:ticket.count,total:ticket.total,token:confirmation('webImport',ticket)};}
        if(action==='import'){const c=checked('webImport',input.token);d.state.remove('webImport');return d.controller.importAll(true,c.ticket);}
        if(action==='preview'){d.state.remove('webApproval');const result=d.controller.preview();return result;}
        if(action==='prepare'){
          const preview=d.state.get('preview');if(!preview||!input.runId||input.runId!==preview.runId)throw new Error('別の変更確認が行われました。差分を再確認してください');
          const ticket=d.controller.prepare();return {...ticket,token:confirmation('webApproval',ticket)};
        }
        if(action==='apply'){
          const last=d.state.get('webOutcome');if(last&&input.token===last.token&&last.actor===d.actor()&&last.bookId===d.bookId)return last.result;
          const c=checked('webApproval',input.token);d.state.remove('webApproval');
          // Consume before the first mutation. A lost response never grants a second apply.
          d.state.set('webOutcome',{token:input.token,actor:d.actor(),bookId:d.bookId,result:{status:'UNKNOWN',runId:c.ticket.runId,completed:0,error:'結果を履歴で確認してください。自動再実行はしません。'}});
          const result={...d.controller.apply(c.ticket,true),runId:c.ticket.runId};
          d.state.set('webOutcome',{token:input.token,actor:d.actor(),bookId:d.bookId,result});return result;
        }
        if(action==='verify')return d.controller.verify();
        if(action==='history'){const p=page(input);return d.store.readHistory(p.offset,p.limit);}
        throw new Error('対応していない操作です');
      });
    }
    return {dispatch};
  }
  return {create};
})();
function GFM_web(action,input){return GFMWeb.create(GFMRuntime.open()).dispatch(action,input);}
function doGet(){
  GFMRuntime.open();
  const t=HtmlService.createTemplateFromFile('Index');
  t.styles=HtmlService.createHtmlOutputFromFile('Styles').getContent();t.client=HtmlService.createHtmlOutputFromFile('Client').getContent();
  return t.evaluate().setTitle('Gmailフィルター管理').addMetaTag('viewport','width=device-width, initial-scale=1');
}
if(typeof module!=='undefined')module.exports=GFMWeb;
