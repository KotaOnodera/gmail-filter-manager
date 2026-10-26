/* Labels are identified by a stable sheet key, never by their current display name. */
var GFMLabels = (function(){
  'use strict';
  const columns=['LabelKey','Name','Note','GmailLabelId','SyncedName','SyncedAt','Result'];
  const validKey=k=>typeof k==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k);
  const entryKey=k=>'label:'+k;
  const virtualId=k=>'gfm-label:'+k;
  function config(rows){return rows.map(r=>Object.fromEntries(columns.slice(0,5).map(k=>[k,r[k]||'']))).sort((a,b)=>String(a.LabelKey).localeCompare(String(b.LabelKey)));}
  function plan(rows,labels){
    const desired=labels.map(l=>({...l}));
    const entries=rows.slice().sort((a,b)=>String(a.LabelKey).localeCompare(String(b.LabelKey))).map(r=>{
      const before=labels.find(l=>l.id===r.GmailLabelId)||null;
      const e={kind:'LABEL',ruleKey:entryKey(r.LabelKey),labelKey:r.LabelKey,operation:'ERROR',before,after:null,matchedId:'',warnings:[],risks:[],errors:[]};
      try{
        if(!validKey(r.LabelKey)||rows.filter(x=>x.LabelKey===r.LabelKey).length!==1)throw Error('LabelKeyが不正または重複しています');
        if(typeof r.Name!=='string'||!r.Name.trim()||r.Name.length>225||r.Name!==r.Name.trim())throw Error('ラベル名は前後の空白がない1〜225文字で指定してください');
        if(rows.filter(x=>x.Name===r.Name).length!==1)throw Error('希望するラベル名が重複しています');
        if(r.GmailLabelId&&rows.filter(x=>x.GmailLabelId===r.GmailLabelId).length!==1)throw Error('ラベルIDが重複しています');
        if(before&&before.type!=='user')throw Error('システムラベルは変更できません');
        const matches=labels.filter(l=>l.name===r.Name);
        if(matches.some(l=>l.type!=='user'))throw Error('予約済みのシステムラベル名です');
        if(matches.some(l=>l.id!==r.GmailLabelId)&&(r.GmailLabelId||matches.length!==1))throw Error('変更先の名前が別のラベルで使用されています');
        const adopt=!r.GmailLabelId&&matches.length===1?matches[0]:null;
        if(adopt&&rows.some(x=>x.LabelKey!==r.LabelKey&&x.GmailLabelId===adopt.id))throw Error('同名ラベルのIDは別のLabels行が管理しています。先に改名を反映してください');
        const id=before?before.id:adopt?adopt.id:virtualId(r.LabelKey);
        e.after={id,name:r.Name,type:'user'};
        e.operation=before?(before.name===r.Name?'NOOP':'REPLACE'):adopt?'NOOP':'CREATE';
        if(adopt)e.matchedId=adopt.id;
        if(e.operation==='REPLACE')e.warnings.push('このラベルを使うすべてのメール・フィルターに名前変更が反映されます');
        const i=desired.findIndex(l=>l.id===id);if(i>=0)desired[i]={...desired[i],name:r.Name};else desired.push(e.after);
      }catch(err){e.errors.push(err.message);}
      return e;
    });
    return {entries,labels:desired};
  }
  function resolve(filterRows,labelRows,desiredLabels,originalLabels){
    const C=typeof module!=='undefined'?require('./Core'):GFMCore,refs={},errors={};
    const rows=filterRows.map(raw=>{
      const r={...raw};let found=null;
      try{
        let ref=null;
        if(r.UserLabelRef){try{ref=JSON.parse(r.UserLabelRef);}catch(_){throw Error('UserLabelRefが破損しています');}if(!ref||!validKey(ref.key)||typeof ref.name!=='string')throw Error('UserLabelRefが不正です');}
        if(!C.blank(r.UserLabel)){
        if(ref&&r.UserLabel===ref.name){found=labelRows.find(l=>l.LabelKey===ref.key);if(!found)throw Error('参照先のLabels行がありません: '+r.UserLabel);}
        if(!found){
          // Before the first binding, original ID disambiguates a simultaneous label rename.
          let original={},baseline={};try{original=JSON.parse(r.OriginalJson||'{}');baseline=JSON.parse(r.OriginalRowJson||'{}');}catch(_){/* Core validates malformed original data. */}
          if(!ref&&r.UserLabel===baseline.UserLabel){const ids=original.action?.addLabelIds||[];found=labelRows.find(l=>l.GmailLabelId&&ids.includes(l.GmailLabelId));}
          if(!found){const matches=labelRows.filter(l=>l.Name===r.UserLabel);if(matches.length>1)throw Error('参照先ラベル名が重複しています');found=matches[0];}
          if(!found){const old=(originalLabels||[]).find(l=>l.type==='user'&&l.name===r.UserLabel);if(old)found=labelRows.find(l=>l.GmailLabelId===old.id);}
        }
      }
      refs[r.RuleKey]=found?{key:found.LabelKey,name:found.Name}:null;
      if(found){r.UserLabel=found.Name;r.UserLabelRef=JSON.stringify(refs[r.RuleKey]);}
      else r.UserLabelRef='';
      return r;
      }catch(err){errors[r.RuleKey]=err.message;refs[r.RuleKey]=null;return r;}
    });
    return {rows,refs,errors};
  }
  return {columns,validKey,entryKey,virtualId,config,plan,resolve};
})();
if(typeof module!=='undefined')module.exports=GFMLabels;
