var GFMSheets = (function () {
  'use strict';
  const core=()=>typeof module!=='undefined'?require('./Core.js'):GFMCore;
  function schemasValue(){return {
    Filters:core().columns,
    Labels:(typeof module!=='undefined'?require('./Labels'):GFMLabels).columns,
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
    function migrateFilterHeader() {
      const s=d.book.getSheetByName('Filters');if(!s||!s.getLastRow())return;
      const old=C.columns.slice(0,-1),actual=s.getRange(1,1,1,old.length).getValues()[0];
      if(s.getLastColumn()===old.length&&actual.every((v,i)=>v===old[i])&&!s.getRange(1,1,1,old.length).getFormulas()[0].some(Boolean))write(s,1,C.columns.length,[['UserLabelRef']]);
    }
    function setup() {
      migrateFilterHeader();
      Object.keys(schemas).forEach(name=>{const s=d.book.getSheetByName(name);if(s&&s.getLastRow()>0)assertHeader(s,name);});
      Object.keys(schemas).forEach(name=>{
        const s=d.book.getSheetByName(name)||d.book.insertSheet(name);
        if(s.getLastRow()===0)write(s,1,1,[schemas[name]]);
        capacity(s,1001,schemas[name].length);s.setFrozenRows(1);s.setColumnWidths(1,schemas[name].length,150);
        s.getRange(1,1,1,schemas[name].length).setBackground('#17324d').setFontColor('#ffffff').setFontWeight('bold');
        s.getRange(2,1,s.getMaxRows()-1,schemas[name].length).setNumberFormat('@').setWrapStrategy(d.app.WrapStrategy.CLIP);
        if(name==='Filters') {
          const system=['RuleKey','GmailFilterId','SyncedAt','SyncedHash','Result','OriginalJson','OriginalRowJson','UserLabelRef'];
          system.forEach(k=>{const col=C.columns.indexOf(k)+1;s.getRange(2,col,s.getMaxRows()-1,1).setBackground('#eef2f6');protect(s,col,1,'GFM:Filters:'+k);});
          s.hideColumns(C.columns.indexOf('OriginalJson')+1,3);
          const validation=(col,values)=>s.getRange(2,C.columns.indexOf(col)+1,s.getMaxRows()-1,1).setDataValidation(d.app.newDataValidation().requireValueInList(values,true).setAllowInvalid(false).build());
          validation('Status',['有効','無効','削除予定']);validation('SizeComparison',['larger','smaller','unspecified']);
          ['HasAttachment','ExcludeChats',...Object.keys(C.actionFlags)].forEach(k=>validation(k,['TRUE','FALSE']));
        } else if(name==='Labels') {
          ['LabelKey','GmailLabelId','SyncedName','SyncedAt','Result'].forEach(k=>{const col=schemas.Labels.indexOf(k)+1;s.getRange(2,col,s.getMaxRows()-1,1).setBackground('#eef2f6');protect(s,col,1,'GFM:Labels:'+k);});
        } else protect(s,1,schemas[name].length,'GFM:'+name);
        if(name==='Diff'&&!s.getFilter())s.getRange(1,1,s.getMaxRows(),schemas[name].length).createFilter();
      });
      const labelSheet=sheet('Labels'),filterSheet=sheet('Filters');
      filterSheet.getRange(2,C.columns.indexOf('UserLabel')+1,filterSheet.getMaxRows()-1,1).setDataValidation(d.app.newDataValidation().requireValueInRange(labelSheet.getRange(2,2,labelSheet.getMaxRows()-1,1),true).setAllowInvalid(true).build());
      d.app.flush();
    }
    function ensureLabelSchema(){
      const f=d.book.getSheetByName('Filters');
      if(!d.book.getSheetByName('Labels')||!f||f.getLastColumn()!==C.columns.length)setup();
      assertHeader(sheet('Labels'),'Labels');assertHeader(sheet('Filters'),'Filters');
    }
    function labelAnchors(){
      const s=sheet('Labels'),raw=table('Labels'),anchors=s.createDeveloperMetadataFinder().withKey('GFM_LABEL').find();
      raw.forEach((r,i)=>{if(!r[0]||!token(r[0]))return;const found=anchors.filter(m=>m.getValue()===token(r[0]));if(found.length>1)throw Error('LabelKeyの行メタデータが重複しています');if(!found.length)s.getRange((i+2)+':'+(i+2)).addDeveloperMetadata('GFM_LABEL',token(r[0]),d.app.DeveloperMetadataVisibility.DOCUMENT);});d.app.flush();
    }
    function readLabelRows(){
      const raw=table('Labels');sheet('Labels').createDeveloperMetadataFinder().withKey('GFM_LABEL').find().forEach(m=>{const row=m.getLocation().getRow(),i=row?row.getRow()-2:-1;if(i<0||!raw[i]||token(raw[i][0])!==m.getValue())throw Error('LabelKeyと行メタデータが不一致です');});
      return raw.filter(r=>r.some(v=>v!=='')).map(r=>Object.fromEntries(schemas.Labels.map((k,i)=>[k,r[i]])));
    }
    function ensureLabelKeys(uuid){const s=sheet('Labels');table('Labels').forEach((r,i)=>{if(r.some(v=>v!=='')&&!r[0])write(s,i+2,1,[[uuid()]]);});d.app.flush();labelAnchors();readLabelRows();}
    function appendLabelRows(rows){append('Labels',rows.map(r=>schemas.Labels.map(k=>r[k])));labelAnchors();const actual=readLabelRows();for(const r of rows){const found=actual.filter(a=>a.LabelKey===r.LabelKey);if(found.length!==1||schemas.Labels.some(k=>String(found[0][k])!==stringify(r[k])))throw Error('Labels書き込みの読み返しが不一致');}}
    function atomicFields(name,metadata,key,patch){
      const cols=schemas[name],matches=sheet(name).createDeveloperMetadataFinder().withKey(metadata).withValue(token(key)).find();if(matches.length!==1)throw Error(name+'の行メタデータが不明/重複しています');
      const values=Array(cols.length).fill(null);for(const k of Object.keys(patch)){if(!cols.includes(k))throw Error('不正な列');const v=stringify(patch[k]);if(v.length>limit)throw Error('セルが長すぎます');values[cols.indexOf(k)]=v;}
      const response=d.api.Spreadsheets.Values.batchUpdateByDataFilter({valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:matches[0].getId()}},majorDimension:'ROWS',values:[values]}]},d.book.getId());
      if(!response||response.totalUpdatedRows!==1||response.totalUpdatedSheets!==1)throw Error(name+'の行更新が不一致です');d.app.flush();
    }
    function updateLabelRow(key,patch){
      if(Object.keys(patch).some(k=>!['GmailLabelId','SyncedName','SyncedAt','Result'].includes(k)))throw Error('ラベルのシステム列以外は更新できません');
      if(readLabelRows().filter(r=>r.LabelKey===key).length!==1)throw Error('LabelKeyが不明/重複しています');atomicFields('Labels','GFM_LABEL',key,patch);
      const r=readLabelRows().find(r=>r.LabelKey===key);if(!r||Object.keys(patch).some(k=>String(r[k])!==stringify(patch[k])))throw Error('ラベル更新の読み返しが不一致');
    }
    function setFilterLabel(key,expected,ref){
      const actual=readRows().filter(r=>r.RuleKey===key);if(actual.length!==1||C.stable(C.config(actual))!==C.stable(C.config([expected])))throw Error('フィルターが変更されています。参照更新を停止しました');
      const patch={UserLabelRef:ref?JSON.stringify(ref):''};if(ref)patch.UserLabel=ref.name;
      atomicFields('Filters','GFM',key,patch);const found=readRows().find(r=>r.RuleKey===key);if(!found||Object.keys(patch).some(k=>String(found[k])!==patch[k]))throw Error('参照名の読み返しが一致しません');
    }
    function batchJobPatches(patches,expectedRows,expectedLabels){
      if(!Array.isArray(patches)||patches.length>25)throw Error('参照・メタデータ更新は25行以内です');
      const L=typeof module!=='undefined'?require('./Labels'):GFMLabels;
      const before={Filters:readRows(),Labels:readLabelRows()},expected={Filters:C.clone(expectedRows),Labels:C.clone(expectedLabels)},after=C.clone(expected);
      const anchors={};const data=[],seen=new Set();
      for(const p of patches){
        const name=p.kind==='LABEL'?'Labels':'Filters',keyField=p.kind==='LABEL'?'LabelKey':'RuleKey',metadata=p.kind==='LABEL'?'GFM_LABEL':'GFM';
        if(seen.has(name+':'+p.key))throw Error('更新キーが重複しています');seen.add(name+':'+p.key);
        const original=expected[name].filter(r=>r[keyField]===p.key),actual=before[name].filter(r=>r[keyField]===p.key),target=after[name].filter(r=>r[keyField]===p.key);
        if(original.length!==1||actual.length!==1)throw Error('更新する行のキーが不明です');
        const allowed=name==='Labels'?['GmailLabelId','SyncedName','SyncedAt','Result']:p.reference?['UserLabel','UserLabelRef']:C.columns.filter(k=>!C.editable.includes(k)&&k!=='RuleKey');
        const values=Array(schemas[name].length).fill(null);
        for(const [field,value]of Object.entries(p.values)){
          if(!allowed.includes(field)||stringify(value).length>limit)throw Error('更新列またはセル長が不正です');
          // A previous API response may have been lost after some intended cells
          // were written. Only approved old/new values are accepted on replay.
          if(stringify(actual[0][field])!==stringify(original[0][field])&&stringify(actual[0][field])!==stringify(value))throw Error('実行中にシートが変更されています');
          actual[0][field]=original[0][field];target[0][field]=stringify(value);values[schemas[name].indexOf(field)]=stringify(value);
        }
        if(!anchors[name])anchors[name]=sheet(name).createDeveloperMetadataFinder().withKey(metadata).find();
        const match=anchors[name].filter(m=>m.getValue()===token(p.key));if(match.length!==1)throw Error('行メタデータが不明または重複しています');
        data.push({dataFilter:{developerMetadataLookup:{metadataId:match[0].getId()}},majorDimension:'ROWS',values:[values]});
      }
      const cfg=t=>C.stable({filters:C.config(t.Filters),labels:L.config(t.Labels)});
      if(cfg(before)!==cfg(expected))throw Error('実行中にシートの定義が変更されています');
      if(!data.length)return;
      const response=d.api.Spreadsheets.Values.batchUpdateByDataFilter({valueInputOption:'RAW',data},d.book.getId());
      if(!response||response.totalUpdatedRows!==patches.length)throw Error('一括メタデータ更新の件数が一致しません');
      // No flush per row: the Values API completes its batch before readback.
      const actual={Filters:readRows(),Labels:readLabelRows()};if(cfg(actual)!==cfg(after))throw Error('一括更新の読み返しが一致しません');
      for(const p of patches){const name=p.kind==='LABEL'?'Labels':'Filters',field=p.kind==='LABEL'?'LabelKey':'RuleKey',r=actual[name].find(r=>r[field]===p.key);if(!r||Object.keys(p.values).some(k=>stringify(r[k])!==stringify(p.values[k])))throw Error('一括更新のシステム列読み返しが一致しません');}
    }
    function chunkRows(id,at,kind,filterId,text) {
      const parts=Math.max(1,Math.ceil(text.length/limit)),hash=d.hash(text);
      return Array.from({length:parts},(_,i)=>[id,at,kind,filterId,i+1,parts,text.slice(i*limit,(i+1)*limit),hash]);
    }
    function dataIntegrity(message){const error=Error(message);error.code='GFM_DATA_INTEGRITY';return error;}
    function assemble(rs) {
      if(!rs.length)throw dataIntegrity('バックアップが不完全です');
      const n=Number(rs[0].Parts),hash=rs[0].Hash;
      if(!Number.isSafeInteger(n)||n<1||rs.length!==n||rs.some(r=>Number(r.Parts)!==n||r.Hash!==hash))throw dataIntegrity('バックアップの分割データが不完全です');
      rs=rs.slice().sort((a,b)=>Number(a.Part)-Number(b.Part));
      if(rs.some((r,i)=>Number(r.Part)!==i+1))throw dataIntegrity('バックアップの分割番号が破損しています');
      const text=rs.map(r=>r.Json).join('');if(d.hash(text)!==hash)throw dataIntegrity('バックアップのハッシュが不一致・破損しています');return text;
    }
    function blob(text) {
      const id='blob-'+d.uuid();append('Backup',chunkRows(id,new Date().toISOString(),'BLOB','',text));
      if(assemble(blobRecords(id))!==text)throw new Error('メタデータの保存失敗');
      return 'gfm-blob:'+id;
    }
    function snapshotRecords(id) {
      const s=sheet('Backup'),n=s.getLastRow()-1;if(n<1)return [];
      // Locate only this immutable ID; do not transfer historical checkpoint or
      // message bodies. Coalesce adjacent rows into one range read.
      const indices=s.getRange(2,1,n,1).createTextFinder(id).matchEntireCell(true).matchCase(true).useRegularExpression(false).findAll().map(r=>r.getRow()).sort((a,b)=>a-b),groups=[];
      for(const row of indices){const last=groups[groups.length-1];if(last&&last.end+1===row)last.end=row;else groups.push({start:row,end:row});}
      const result=[];
      for(const group of groups){const range=s.getRange(group.start,1,group.end-group.start+1,schemas.Backup.length);
        if(range.getFormulas().some(r=>r.some(Boolean)))throw Error('メタデータの保存行に数式があります');
        for(const values of range.getValues()){const record=Object.fromEntries(schemas.Backup.map((k,i)=>[k,values[i]]));if(record.SnapshotId!==id)throw Error('メタデータの保存先が一致しません');result.push(record);}
      }
      return result;
    }
    function blobRecords(id){const records=snapshotRecords(id);if(records.some(r=>r.Kind!=='BLOB'))throw Error('メタデータの保存種別が一致しません');return records;}
    function decodeBlob(value) {
      if(typeof value==='string'&&value.startsWith('gfm-blob:'))return assemble(blobRecords(value.slice(9)));
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
        // A1 row notation leaves columns unbounded; a full-width numeric range is still bounded.
        if(!found.length)s.getRange((i+2)+':'+(i+2)).addDeveloperMetadata('GFM',token(r[0]),d.app.DeveloperMetadataVisibility.DOCUMENT);
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
      Object.keys(patch).forEach(k=>{if(!C.columns.includes(k)||C.editable.includes(k))throw new Error('システム列以外は更新できません: '+k);const value=stringify(patch[k]);if(value.length>limit)throw new Error('セルが長すぎます');values[C.columns.indexOf(k)]=value;});
      if(!Object.keys(patch).length)return;
      // A metadata ID follows its row when the user sorts. RAW + null skips other cells.
      const response=d.api.Spreadsheets.Values.batchUpdateByDataFilter({valueInputOption:'RAW',data:[{dataFilter:{developerMetadataLookup:{metadataId:matches[0].getId()}},majorDimension:'ROWS',values:[values]}]},d.book.getId());
      if(!response||response.totalUpdatedRows!==1||response.totalUpdatedSheets!==1)throw new Error('RuleKeyの行が更新できません。削除/並替えを確認してください');
      d.app.flush();
      const found=readRows().find(r=>r.RuleKey===key);
      if(!found||Object.keys(patch).some(k=>String(found[k])!==stringify(patch[k])))throw new Error('システム列更新の読み返しが不一致');
    }
    function readHistory(offset,limit,runId){const all=records('History').filter(r=>!runId||r.RunId===runId).reverse();return {items:all.slice(offset,offset+limit),total:all.length};}
    function ensureKeys(uuid) {
      const raw=table('Filters'),s=sheet('Filters');
      raw.forEach((r,i)=>{if(r.some(v=>v!=='')&&!r[0])write(s,i+2,1,[[uuid()]]);});d.app.flush();ensureAnchors();
    }
    function decodeSnapshot(id,requireComplete) {
      const all=snapshotRecords(id);
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
      if(snapshotRecords(id).length)throw new Error('SnapshotIdの上書きは禁止');
      const hash=d.hash(C.stable(C.remote(state)));
      const values=[...chunkRows(id,at,'CONTEXT','',JSON.stringify({labels:state.labels,forwarding:state.forwarding}))];
      state.filters.forEach(f=>values.push(...chunkRows(id,at,'FILTER',f.id,JSON.stringify(f))));
      values.push(...chunkRows(id,at,'MANIFEST','',JSON.stringify({count:state.filters.length,ids:state.filters.map(f=>f.id),hash})));
      append('Backup',values);decodeSnapshot(id,false);
      append('Backup',[[id,at,'COMPLETE','',1,1,JSON.stringify({count:state.filters.length}),hash]]);
      decodeSnapshot(id,true);return {id,hash,count:state.filters.length};
    }
    function readScope(id){return JSON.parse(assemble(snapshotRecords(id).filter(r=>r.Kind==='SCOPE')));}
    function writeScope(id,keys,at){
      const all=snapshotRecords(id);
      if(all.filter(r=>r.Kind==='COMPLETE').length!==1||all.some(r=>r.Kind==='SCOPE'))throw new Error('選択対象の保存先が不完全か保存済みです');
      const text=JSON.stringify(keys);append('Backup',chunkRows(id,at,'SCOPE','',text));if(C.stable(readScope(id))!==C.stable(keys))throw new Error('選択対象の読み返しが一致しません');
    }
    function readMessageData(pointer) {
      const p=pointer,s=sheet('Backup');
      if(!p||!Number.isSafeInteger(p.row)||p.row<2||!Number.isSafeInteger(p.parts)||p.parts<1||p.parts>1000||p.row+p.parts-1>s.getLastRow())throw dataIntegrity('既存メールの保存先が不正です');
      const range=s.getRange(p.row,1,p.parts,schemas.Backup.length);
      if(range.getFormulas().some(r=>r.some(Boolean)))throw dataIntegrity('保存済みの既存メールデータに数式があります');
      const rs=range.getValues().map(r=>Object.fromEntries(schemas.Backup.map((k,i)=>[k,r[i]])));
      if(rs.some(r=>r.SnapshotId!==p.runId||r.Kind!=='MESSAGES'||r.GmailFilterId!==p.id||r.Hash!==p.hash))throw dataIntegrity('既存メールの保存済みデータが変更されています');
      const text=assemble(rs);try{return JSON.parse(text);}catch(_){throw dataIntegrity('保存済みデータのJSONが破損しています');}
    }
    function writeMessageData(runId,value) {
      const text=JSON.stringify(value),id=d.uuid(),s=sheet('Backup');
      const values=chunkRows(runId,new Date().toISOString(),'MESSAGES',id,text);
      if(values.length>1000)throw new Error('既存メールデータが大きすぎます');
      const pointer={runId,id,row:s.getLastRow()+1,parts:values.length,hash:d.hash(text)};
      append('Backup',values);
      if(C.stable(readMessageData(pointer))!==C.stable(value))throw new Error('既存メールデータの読み返しが一致しません');return pointer;
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
    return {batchJobPatches,writeJobData:writeMessageData,readJobData:readMessageData,writeMessageData,readMessageData,setup,ensureLabelSchema,readLabelRows,appendLabelRows,updateLabelRow,ensureLabelKeys,setFilterLabel,readRows,appendRows,updateRow,readHistory,ensureKeys,writeDiff,history,backup,writeScope,readScope,readBackup:id=>decodeSnapshot(id,true),open:name=>sheet(name).activate()};
  }
  // GAS file evaluation order is unspecified: resolve Core only when used.
  return {create,get schemas(){return schemasValue();}};
})();
if(typeof module!=='undefined')module.exports=GFMSheets;
