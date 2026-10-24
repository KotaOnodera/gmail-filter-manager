var GFMSheets = (function () {
  'use strict';
  const core=()=>typeof module!=='undefined'?require('./Core.js'):GFMCore;
  function schemasValue(){return {
    Filters:core().columns,
    Diff:['RunId','RuleKey','Operation','Before','After','Warnings','Risk','ValidationError'],
    History:['RunId','TimestampTokyo','Actor','Command','RuleKey','BeforeId','AfterId','Result','Error','SnapshotId','Verification','Risk'],
    Backup:['SnapshotId','CapturedAt','Kind','GmailFilterId','Part','Parts','Json','Hash']
  };}
  function create(d) {
    const C=core(),schemas=schemasValue(),limit=40000;
    const stringify=v=>v===undefined||v===null?'':typeof v==='boolean'?(v?'TRUE':'FALSE'):typeof v==='object'?JSON.stringify(v):String(v);
    function sheet(name){const s=d.book.getSheetByName(name);if(!s)throw new Error(name+'がありません。初期設定を実行してください');assertHeader(s,name);return s;}
    function assertHeader(s,name) {
      if(s.getLastRow()===0)throw new Error(name+'のヘッダーがありません');
      const actual=s.getRange(1,1,1,schemas[name].length).getValues()[0];
      if(actual.some((v,i)=>v!==schemas[name][i])||s.getLastColumn()>schemas[name].length)throw new Error(name+'のヘッダーが変更されています。列の追加/削除/並替えを元に戻してください');
      if(s.getRange(1,1,1,schemas[name].length).getFormulas()[0].some(Boolean))throw new Error(name+'のヘッダーに数式があります');
    }
    function capacity(s,row,col) {
      if(s.getMaxRows()<row)s.insertRowsAfter(s.getMaxRows(),row-s.getMaxRows());
      if(s.getMaxColumns()<col)s.insertColumnsAfter(s.getMaxColumns(),col-s.getMaxColumns());
    }
    function write(s,row,col,values) {
      if(!values.length)return;
      const texts=values.map(r=>r.map(stringify));
      if(texts.some(r=>r.some(v=>v.length>limit)))throw new Error('シートのセル長上限を超えます（40000文字）。原本JSON以外は短縮してください');
      capacity(s,row+values.length-1,col+values[0].length-1);
      // RichTextValue treats leading '=' and apostrophes as literal text.
      s.getRange(row,col,texts.length,texts[0].length).setRichTextValues(texts.map(r=>r.map(text=>d.app.newRichTextValue().setText(text).build())));
    }
    function append(name,values) {
      if(!values.length)return;
      const s=sheet(name);write(s,s.getLastRow()+1,1,values);d.app.flush();
      if(s.getLastRow()>100000)d.book.toast(name+'が10万行を超えました。バックアップ容量を確認してください','Gmail管理',10);
    }
    function table(name) {
      const s=sheet(name),n=s.getLastRow()-1;if(n<=0)return [];
      const range=s.getRange(2,1,n,schemas[name].length);
      if(range.getFormulas().some(r=>r.some(Boolean)))throw new Error(name+'に数式があります。プレーンテキストに変更してください');
      return range.getValues();
    }
    function records(name){return table(name).filter(r=>r.some(v=>v!=='')).map(r=>Object.fromEntries(schemas[name].map((k,i)=>[k,r[i]])));}
    function protect(s,col,count,description) {
      const existing=s.getProtections(d.app.ProtectionType.RANGE).some(p=>p.getDescription()===description);
      if(!existing)s.getRange(1,col,s.getMaxRows(),count).protect().setDescription(description).setWarningOnly(true);
    }
    function setup() {
      Object.keys(schemas).forEach(name=>{const s=d.book.getSheetByName(name);if(s&&s.getLastRow()>0)assertHeader(s,name);});
      Object.keys(schemas).forEach(name=>{
        const s=d.book.getSheetByName(name)||d.book.insertSheet(name);
        if(s.getLastRow()===0)write(s,1,1,[schemas[name]]);
        capacity(s,1001,schemas[name].length);s.setFrozenRows(1);s.setColumnWidths(1,schemas[name].length,150);
        s.getRange(1,1,1,schemas[name].length).setBackground('#17324d').setFontColor('#ffffff').setFontWeight('bold');
        s.getRange(2,1,s.getMaxRows()-1,schemas[name].length).setNumberFormat('@').setWrapStrategy(d.app.WrapStrategy.CLIP);
        if(name==='Filters') {
          const system=['RuleKey','GmailFilterId','SyncedAt','SyncedHash','Result','OriginalJson','OriginalRowJson'];
          system.forEach(k=>{const col=C.columns.indexOf(k)+1;s.getRange(2,col,s.getMaxRows()-1,1).setBackground('#eef2f6');protect(s,col,1,'GFM:Filters:'+k);});
          s.hideColumns(C.columns.indexOf('OriginalJson')+1,2);
          const validation=(col,values)=>s.getRange(2,C.columns.indexOf(col)+1,s.getMaxRows()-1,1).setDataValidation(d.app.newDataValidation().requireValueInList(values,true).setAllowInvalid(false).build());
          validation('Status',['有効','無効','削除予定']);validation('SizeComparison',['larger','smaller','unspecified']);
          ['HasAttachment','ExcludeChats',...Object.keys(C.actionFlags)].forEach(k=>validation(k,['TRUE','FALSE']));
        } else protect(s,1,schemas[name].length,'GFM:'+name);
        if(name==='Diff'&&!s.getFilter())s.getRange(1,1,s.getMaxRows(),schemas[name].length).createFilter();
      });
      d.app.flush();
    }
    function chunkRows(id,at,kind,filterId,text) {
      const parts=Math.max(1,Math.ceil(text.length/limit)),hash=d.hash(text);
      return Array.from({length:parts},(_,i)=>[id,at,kind,filterId,i+1,parts,text.slice(i*limit,(i+1)*limit),hash]);
    }
    function assemble(rs) {
      if(!rs.length)throw new Error('バックアップが不完全です');
      const n=Number(rs[0].Parts),hash=rs[0].Hash;
      if(!Number.isSafeInteger(n)||n<1||rs.length!==n||rs.some(r=>Number(r.Parts)!==n||r.Hash!==hash))throw new Error('バックアップの分割データが不完全です');
      rs=rs.slice().sort((a,b)=>Number(a.Part)-Number(b.Part));
      if(rs.some((r,i)=>Number(r.Part)!==i+1))throw new Error('バックアップの分割番号が破損しています');
      const text=rs.map(r=>r.Json).join('');if(d.hash(text)!==hash)throw new Error('バックアップのハッシュが不一致・破損しています');return text;
    }
    function blob(text) {
      const id='blob-'+d.uuid();append('Backup',chunkRows(id,new Date().toISOString(),'BLOB','',text));
      if(assemble(records('Backup').filter(r=>r.SnapshotId===id&&r.Kind==='BLOB'))!==text)throw new Error('メタデータの保存失敗');
      return 'gfm-blob:'+id;
    }
    function decodeBlob(value) {
      if(typeof value==='string'&&value.startsWith('gfm-blob:'))return assemble(records('Backup').filter(r=>r.SnapshotId===value.slice(9)&&r.Kind==='BLOB'));
      return value;
    }
    function readRows() {
      const raw=table('Filters');
      const anchors=sheet('Filters').createDeveloperMetadataFinder().withKey('GFM').find();
      anchors.forEach(m=>{const location=m.getLocation().getRow(),i=location?location.getRow()-2:-1;if(i<0||!raw[i]||token(raw[i][0])!==m.getValue())throw new Error('RuleKeyと行メタデータが不一致です。並替え完了後に再プレビューしてください');});
      return raw.filter(r=>r.some(v=>v!=='')).map(r=>Object.fromEntries(schemas.Filters.map((k,i)=>[k,['OriginalJson','OriginalRowJson'].includes(k)?decodeBlob(r[i]):r[i]])));
    }
    function token(key) {
      const hex=String(key).replace(/-/g,'');if(!/^[0-9a-f]{32}$/i.test(hex))return '';
      const bytes=hex.match(/../g).map(s=>parseInt(s,16)),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';let result='';
      for(let i=0;i<bytes.length;i+=3){const n=(bytes[i]<<16)|((bytes[i+1]||0)<<8)|(bytes[i+2]||0);result+=alphabet[(n>>>18)&63]+alphabet[(n>>>12)&63];if(i+1<bytes.length)result+=alphabet[(n>>>6)&63];if(i+2<bytes.length)result+=alphabet[n&63];}
      return result;
    }
    function ensureAnchors() {
      const s=sheet('Filters'),raw=table('Filters');
      const anchors=s.createDeveloperMetadataFinder().withKey('GFM').find();
      raw.forEach((r,i)=>{
        if(!r[0]||!token(r[0]))return;
        const found=anchors.filter(m=>m.getValue()===token(r[0]));
        if(found.length>1)throw new Error('RuleKeyの行メタデータが重複しています');
        if(!found.length)s.getRange(i+2,1,1,s.getMaxColumns()).addDeveloperMetadata('GFM',token(r[0]),d.app.DeveloperMetadataVisibility.DOCUMENT);
      });
      d.app.flush();readRows();
    }
    function appendRows(rs) {
      // Preflight editable cells before persisting any row.
      rs.forEach(r=>C.columns.filter(k=>!['OriginalJson','OriginalRowJson'].includes(k)).forEach(k=>{if(stringify(r[k]).length>limit)throw new Error(k+'が40000文字を超えています');}));
      const values=rs.map(r=>C.columns.map(k=>['OriginalJson','OriginalRowJson'].includes(k)&&stringify(r[k]).length>limit?blob(stringify(r[k])):r[k]));
      append('Filters',values);
      ensureAnchors();
      const actual=readRows();rs.forEach(r=>{const found=actual.filter(a=>a.RuleKey===r.RuleKey);if(found.length!==1||C.stable(C.config(found))!==C.stable(C.config([Object.fromEntries(C.columns.map(k=>[k,stringify(r[k])]))])))throw new Error('Filters書き込みの読み返しに失敗');});
    }
    function updateRow(key,patch) {
      const rs=readRows();if(rs.filter(r=>r.RuleKey===key).length!==1)throw new Error('RuleKeyが不明または重複しています: '+key);
      const matches=sheet('Filters').createDeveloperMetadataFinder().withKey('GFM').withValue(token(key)).find();
      if(matches.length!==1)throw new Error('RuleKeyの行メタデータがありません。再プレビューしてください');
      const values=Array(C.columns.length).fill(null);
      Object.keys(patch).forEach(k=>{if(!C.columns.includes(k)||C.editable.includes(k))throw new Error('システム列以外は更新できません: '+k);const value=stringify(patch[k]);if(value.length>limit)throw new Error('システム列が長すぎます');values[C.columns.indexOf(k)]=value;});
      // A metadata ID follows its row when the user sorts. RAW + null skips other cells.
      const response=d.api.Spreadsheets.Values.batchUpdateByDataFilter({valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:matches[0].getId()}},majorDimension:'ROWS',values:[values]}]},d.book.getId());
      if(!response||response.totalUpdatedRows!==1||response.totalUpdatedSheets!==1)throw new Error('RuleKeyの行が更新できません。削除/並替えを確認してください');
      d.app.flush();
      const found=readRows().find(r=>r.RuleKey===key);
      if(!found||Object.keys(patch).some(k=>String(found[k])!==stringify(patch[k])))throw new Error('システム列更新の読み返しが不一致');
    }
    function ensureKeys(uuid) {
      const raw=table('Filters'),s=sheet('Filters');
      raw.forEach((r,i)=>{if(r.some(v=>v!=='')&&!r[0])write(s,i+2,1,[[uuid()]]);});d.app.flush();ensureAnchors();
    }
    function decodeSnapshot(id,requireComplete) {
      const all=records('Backup').filter(r=>r.SnapshotId===id);
      if(requireComplete&&all.filter(r=>r.Kind==='COMPLETE').length!==1)throw new Error('バックアップの完了マーカーがありません/不完全です');
      const context=JSON.parse(assemble(all.filter(r=>r.Kind==='CONTEXT')));
      const manifest=JSON.parse(assemble(all.filter(r=>r.Kind==='MANIFEST')));
      const ids=[...new Set(all.filter(r=>r.Kind==='FILTER').map(r=>r.GmailFilterId))];
      const filters=ids.map(filterId=>JSON.parse(assemble(all.filter(r=>r.Kind==='FILTER'&&r.GmailFilterId===filterId))));
      if(filters.length!==manifest.count||filters.some(f=>!f.id)||new Set(filters.map(f=>f.id)).size!==filters.length||C.stable(filters.map(f=>f.id).sort())!==C.stable(manifest.ids.slice().sort()))throw new Error('バックアップ件数/IDが破損しています');
      const result={filters,labels:context.labels,forwarding:context.forwarding};
      if(d.hash(C.stable(C.remote(result)))!==manifest.hash)throw new Error('バックアップ全体のハッシュが不一致');
      return result;
    }
    function backup(state,id,at) {
      if(records('Backup').some(r=>r.SnapshotId===id))throw new Error('SnapshotIdの上書きは禁止');
      const hash=d.hash(C.stable(C.remote(state)));
      const values=[...chunkRows(id,at,'CONTEXT','',JSON.stringify({labels:state.labels,forwarding:state.forwarding}))];
      state.filters.forEach(f=>values.push(...chunkRows(id,at,'FILTER',f.id,JSON.stringify(f))));
      values.push(...chunkRows(id,at,'MANIFEST','',JSON.stringify({count:state.filters.length,ids:state.filters.map(f=>f.id),hash})));
      append('Backup',values);decodeSnapshot(id,false);
      append('Backup',[[id,at,'COMPLETE','',1,1,JSON.stringify({count:state.filters.length}),hash]]);
      decodeSnapshot(id,true);return {id,hash,count:state.filters.length};
    }
    function clipped(value){const s=stringify(value);return s.length<=limit?s:s.slice(0,limit-100)+' … [表示を省略。原本はBackupを参照]';}
    function writeDiff(runId,entries) {
      const s=sheet('Diff');if(s.getLastRow()>1)s.getRange(2,1,s.getLastRow()-1,schemas.Diff.length).clearContent();
      append('Diff',entries.map(e=>[runId,e.ruleKey,e.operation,clipped(e.before),clipped(e.after),clipped(e.warnings.join('\n')),e.risks.join(', '),clipped(e.errors.join('\n'))]));
    }
    function history(e) {
      const at=new Date(e.at||Date.now()),tokyo=new Date(at.getTime()+9*60*60*1000).toISOString().replace('T',' ').slice(0,19)+' JST';
      append('History',[[e.runId,tokyo,e.actor,e.command,e.ruleKey,e.oldId,e.newId,e.result,clipped(e.error),e.snapshotId,clipped(e.verification),e.risk]]);
    }
    return {setup,readRows,appendRows,updateRow,ensureKeys,writeDiff,history,backup,readBackup:id=>decodeSnapshot(id,true),open:name=>sheet(name).activate()};
  }
  // GAS file evaluation order is unspecified: resolve Core only when used.
  return {create,get schemas(){return schemasValue();}};
})();
if(typeof module!=='undefined')module.exports=GFMSheets;
