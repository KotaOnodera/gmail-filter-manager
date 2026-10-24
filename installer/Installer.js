/* Standalone installer. Production runtime never reads Gmail or downloads source code. */
var GFMInstaller = (function () {
  'use strict';
  const core=()=>typeof module!=='undefined'?require('../src/Core.js'):GFMCore;
  function create(d) {
    const C=core();
    function fingerprint(files){
      if(!Array.isArray(files))throw new Error('GASソースの取得に失敗しました');
      const normalized=files.map(f=>({name:f.name,type:f.type,source:f.type==='JSON'?C.stable(JSON.parse(f.source)):f.source.replace(/\r\n/g,'\n').trimEnd()})).sort((a,b)=>a.name.localeCompare(b.name));
      return d.hash(C.stable(normalized));
    }
    function payload(){
      const names=['Core','Sync','Sheets','Gmail','Menu','appsscript'];
      if(!Array.isArray(d.files)||d.files.length!==names.length||names.some(name=>d.files.filter(f=>f.name===name).length!==1)||d.files.some(f=>typeof f.source!=='string'||f.type!==(f.name==='appsscript'?'JSON':'SERVER_JS')))throw new Error('同梱ソースが不完全です。npm run buildを再実行してください');
      return {files:C.clone(d.files),hash:fingerprint(d.files)};
    }
    function save(s){d.state.set(s);if(C.stable(d.state.get())!==C.stable(s))throw new Error('インストール状態の読み返しが不一致です');}
    function actor(){const email=String(d.email()||'').toLowerCase();if(!email)throw new Error('実行者のメールアドレスを確認できません');return email;}
    function load(){const s=d.state.get();if(s&&s.owner!==actor())throw new Error('初回の実行者/所有者と異なるアカウントです');return s||{owner:actor(),phase:'NEW'};}
    function bookFor(s){const book=d.books.open(s.spreadsheetId),owner=book.getOwner();if(!owner||String(owner.getEmail()).toLowerCase()!==actor())throw new Error('スプレッドシート所有者が異なります');return book;}
    function projectFor(s){const project=d.projects.get(s.scriptId);if(project.scriptId!==s.scriptId||project.parentId!==s.spreadsheetId)throw new Error('GASの親スプレッドシートへの紐付けが一致しません');return project;}
    function initialContent(files,target){
      const actual=fingerprint(files);if(actual===target.hash||files.length===0)return actual;
      // projects.create produces no script files and a base manifest. Never adopt user code.
      if(files.length===1&&files[0].name==='appsscript'&&files[0].type==='JSON'){
        const manifest=JSON.parse(files[0].source),keys=['timeZone','dependencies','exceptionLogging','runtimeVersion'];
        if(Object.keys(manifest).every(k=>keys.includes(k))&&Object.keys(manifest.dependencies||{}).length===0)return actual;
      }
      throw new Error('初期配置先が空のGASではないか、手動変更されています。自動上書きを停止します');
    }
    function result(s,book){return {status:'COMPLETE',spreadsheetId:s.spreadsheetId,spreadsheetUrl:book.getUrl(),scriptId:s.scriptId,sourceHash:s.installedHash};}
    function installInternal(s,target){
      if(s.phase==='CREATING_SPREADSHEET'||s.phase==='CREATING_SCRIPT')throw new Error('前回の作成結果が不明です。自動再作成は行いません。復旧手順を確認してください');
      if(s.phase==='NEW'){
        s.phase='CREATING_SPREADSHEET';save(s);
        const book=d.books.create();s.spreadsheetId=book.getId();s.phase='SHEET_CREATED';save(s);
      }
      const book=bookFor(s);
      if(s.phase==='SHEET_CREATED'){
        d.setup(book);s.phase='SHEET_READY';save(s);
      }
      if(s.phase==='SHEET_READY'){
        s.phase='CREATING_SCRIPT';save(s);
        let project;
        try{project=d.projects.create(s.spreadsheetId);}catch(err){if(err.definitive){s.phase='SHEET_READY';save(s);}throw err;}
        if(!project||!project.scriptId)throw new Error('GAS作成結果のIDが不明です。復旧手順を確認してください');
        s.scriptId=project.scriptId;s.phase='BOUND';save(s);
      }
      projectFor(s);
      if(s.phase==='COMPLETE'){
        if(s.installedHash!==target.hash)throw new Error('同梱バージョンが変わりました。更新はGFM_updateInstalledCodeを明示実行してください');
        if(fingerprint(d.projects.content(s.scriptId).files)!==s.installedHash)throw new Error('配置済みソースが手動変更されています。自動上書きを停止します');
        return result(s,book);
      }
      if(s.phase==='BOUND'){
        s.baseHash=initialContent(d.projects.content(s.scriptId).files,target);s.targetHash=target.hash;s.phase='UPLOADING';save(s);
      }
      if(s.phase!=='UPLOADING'||s.targetHash!==target.hash)throw new Error('中断中に同梱ソースが変更されています。以前のバージョンで再開してください');
      let actual=fingerprint(d.projects.content(s.scriptId).files);
      if(actual!==target.hash){
        if(actual!==s.baseHash)throw new Error('配置先ソースが変更されています。自動上書きを停止します');
        d.projects.put(s.scriptId,target.files);actual=fingerprint(d.projects.content(s.scriptId).files);
      }
      if(actual!==target.hash)throw new Error('配置ソースの読み返しが一致しません');
      s.phase='COMPLETE';s.installedHash=target.hash;delete s.baseHash;delete s.targetHash;save(s);return result(s,book);
    }
    function install(){return d.withLock(()=>installInternal(load(),payload()));}
    function update(){return d.withLock(()=>{
      const s=load(),target=payload();if(s.phase!=='COMPLETE')throw new Error('インストール未完了です。GFM_installを実行してください');
      bookFor(s);projectFor(s);
      if(fingerprint(d.projects.content(s.scriptId).files)!==s.installedHash)throw new Error('配置先に手動変更があります。更新を停止します');
      if(target.hash===s.installedHash)return result(s,bookFor(s));
      // Freeze both old and new hashes before the idempotent PUT.
      s.baseHash=s.installedHash;s.targetHash=target.hash;s.phase='UPLOADING';save(s);return installInternal(s,target);
    });}
    function recover(options){return d.withLock(()=>{
      const s=load();if(!['CREATING_SPREADSHEET','CREATING_SCRIPT'].includes(s.phase))throw new Error('復旧が必要な作成中断状態ではありません');
      if(s.phase==='CREATING_SPREADSHEET'){
        if(options.notCreated===true){s.phase='NEW';}
        else {if(!options.spreadsheetId)throw new Error('復旧先spreadsheetIdが必要です');s.spreadsheetId=options.spreadsheetId;bookFor(s);s.phase='SHEET_CREATED';}
      }else{
        bookFor(s);
        if(options.notCreated===true){s.phase='SHEET_READY';}
        else {if(!options.scriptId)throw new Error('復旧先scriptIdが必要です');s.scriptId=options.scriptId;projectFor(s);initialContent(d.projects.content(s.scriptId).files,payload());s.phase='BOUND';}
      }
      save(s);return {phase:s.phase,spreadsheetId:s.spreadsheetId||'',scriptId:s.scriptId||''};
    });}
    return {install,update,recover};
  }
  function createProjects(d){
    function request(method,suffix,body){
      const options={method,headers:{Authorization:'Bearer '+d.token()},muteHttpExceptions:true};
      if(body){options.contentType='application/json';options.payload=JSON.stringify(body);}
      const response=d.fetch('https://script.googleapis.com/v1/projects'+suffix,options),status=response.getResponseCode();
      if(status<200||status>=300){const error=new Error('Apps Script API HTTP '+status+'。APIの有効化・利用許可・対象プロジェクトを確認してください');error.definitive=[400,401,403,404,409,429].includes(status);throw error;}
      return JSON.parse(response.getContentText());
    }
    const path=id=>'/'+encodeURIComponent(id);
    return {create:parentId=>request('post','',{title:'Gmail Filter Manager',parentId}),get:id=>request('get',path(id)),content:id=>request('get',path(id)+'/content'),put:(id,files)=>request('put',path(id)+'/content',{files})};
  }
  function runtime(){
    const props=PropertiesService.getScriptProperties(),key='GFM_INSTALL_STATE';
    const hash=text=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
    return create({files:GFMInstallPayload,hash,email:()=>Session.getEffectiveUser().getEmail(),
      state:{get:()=>{const v=props.getProperty(key);return v?JSON.parse(v):null;},set:s=>props.setProperty(key,JSON.stringify(s))},
      withLock(fn){const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw new Error('別のインストール処理が実行中です');try{return fn();}finally{lock.releaseLock();}},
      books:{create:()=>SpreadsheetApp.create('Gmail Filter Manager'),open:id=>SpreadsheetApp.openById(id)},
      setup:book=>{
        const sheets=book.getSheets();
        if(sheets.length===1&&sheets[0].getLastRow()===0&&!book.getSheetByName('Filters'))sheets[0].setName('Filters');
        GFMSheets.create({book,app:SpreadsheetApp,hash,uuid:()=>Utilities.getUuid()}).setup();
      },
      projects:createProjects({token:()=>ScriptApp.getOAuthToken(),fetch:(url,options)=>UrlFetchApp.fetch(url,options)})
    });
  }
  return {create,createProjects,runtime};
})();
function GFM_install(){const result=GFMInstaller.runtime().install();console.log('Spreadsheet: '+result.spreadsheetUrl+'\nBound script ID: '+result.scriptId);return result;}
function GFM_updateInstalledCode(){const result=GFMInstaller.runtime().update();console.log('Spreadsheet: '+result.spreadsheetUrl+'\nBound script ID: '+result.scriptId);return result;}
if(typeof module!=='undefined')module.exports=GFMInstaller;
