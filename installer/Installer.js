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
      const names=['Core','Labels','Sync','Sheets','Gmail','Messages','Runtime','Menu','Web','Index','Styles','Client','appsscript'];
      if(!Array.isArray(d.files)||d.files.length!==names.length||names.some(name=>d.files.filter(f=>f.name===name).length!==1)||d.files.some(f=>typeof f.source!=='string'||f.type!==(f.name==='appsscript'?'JSON':['Index','Styles','Client'].includes(f.name)?'HTML':'SERVER_JS')))throw new Error('同梱ソースが不完全です。npm run buildを再実行してください');
      return {files:C.clone(d.files),hash:fingerprint(d.files)};
    }
    function save(s){d.state.set(s);if(C.stable(d.state.get())!==C.stable(s))throw new Error('インストール状態の読み返しが不一致です');}
    function actor(){const email=String(d.email()||'').toLowerCase();if(!email)throw new Error('実行者のメールアドレスを確認できません');return email;}
    function destination(){
      const input=String(d.destination?d.destination()||'':'').trim();if(!input)return '';
      if(/^[A-Za-z0-9_-]{10,}$/.test(input))return input;
      const match=input.match(/^https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|folders\/)([A-Za-z0-9_-]{10,})(?:[/?#].*)?$/);
      if(!match)throw new Error('保存先にはGoogle DriveのフォルダIDまたはフォルダURLを指定してください');return match[1];
    }
    function load(){
      const s=d.state.get();if(s&&s.owner!==actor())throw new Error('初回の実行者/所有者と異なるアカウントです');
      if(!s)return {owner:actor(),phase:'NEW',folderId:destination()};
      if(!s.folderPlaced&&['NEW','CREATING_SPREADSHEET','SHEET_CREATED'].includes(s.phase)&&destination()!==(s.folderId||''))throw new Error('作成途中に保存先が変更されています。初回の設定へ戻して再開してください');
      return s;
    }
    function validateFolder(id){
      const folder=d.drive.folder(id);
      if(!folder||folder.id!==id||folder.mimeType!=='application/vnd.google-apps.folder'||folder.trashed)throw new Error('保存先のフォルダが存在しないか、利用できません');
      if(folder.driveId)throw new Error('共有ドライブは未対応です。マイドライブ内のフォルダを指定してください');
      if(!folder.capabilities||folder.capabilities.canAddChildren!==true)throw new Error('保存先フォルダへの書き込み権限がありません');
    }
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
        if(s.folderId)validateFolder(s.folderId);
        s.phase='CREATING_SPREADSHEET';save(s);
        const book=d.books.create();s.spreadsheetId=book.getId();s.phase='SHEET_CREATED';save(s);
      }
      const book=bookFor(s);
      if(s.phase==='SHEET_CREATED'){
        if(!s.folderPlaced){if(s.folderId){validateFolder(s.folderId);d.drive.move(s.spreadsheetId,s.folderId);}s.folderPlaced=true;save(s);}
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
  function createDrive(d){
    function request(method,id,query){
      const options={method,headers:{Authorization:'Bearer '+d.token()},muteHttpExceptions:true};
      if(method==='patch'){options.contentType='application/json';options.payload='{}';}
      const response=d.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?'+query,options),status=response.getResponseCode();
      if(status<200||status>=300)throw new Error('保存先のGoogle Drive API HTTP '+status+'。フォルダとアクセス権限を確認してください');
      return JSON.parse(response.getContentText());
    }
    const parents=id=>request('get',id,'fields=id,parents');
    return {
      folder:id=>request('get',id,'supportsAllDrives=true&fields=id,name,mimeType,trashed,driveId,capabilities(canAddChildren)'),
      move(id,folderId){
        const current=parents(id);if((current.parents||[]).includes(folderId))return;
        const remove=(current.parents||[]).length?'&removeParents='+encodeURIComponent(current.parents.join(',')):'';
        request('patch',id,'addParents='+encodeURIComponent(folderId)+remove+'&fields=id,parents');
        if(!(parents(id).parents||[]).includes(folderId))throw new Error('保存先フォルダへの配置の読み返しが一致しません');
      }
    };
  }
  function runtime(){
    const props=PropertiesService.getScriptProperties(),key='GFM_INSTALL_STATE';
    const hash=text=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
    return create({files:GFMInstallPayload,hash,email:()=>Session.getEffectiveUser().getEmail(),destination:()=>props.getProperty('GFM_DESTINATION_FOLDER_ID')||'',
      state:{get:()=>{const v=props.getProperty(key);return v?JSON.parse(v):null;},set:s=>props.setProperty(key,JSON.stringify(s))},
      withLock(fn){const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw new Error('別のインストール処理が実行中です');try{return fn();}finally{lock.releaseLock();}},
      books:{create:()=>SpreadsheetApp.create('Gmail Filter Manager'),open:id=>SpreadsheetApp.openById(id)},
      setup:book=>{
        const sheets=book.getSheets();
        if(sheets.length===1&&sheets[0].getLastRow()===0&&!book.getSheetByName('Filters'))sheets[0].setName('Filters');
        GFMSheets.create({book,app:SpreadsheetApp,hash,uuid:()=>Utilities.getUuid()}).setup();
      },
      projects:createProjects({token:()=>ScriptApp.getOAuthToken(),fetch:(url,options)=>UrlFetchApp.fetch(url,options)}),
      drive:createDrive({token:()=>ScriptApp.getOAuthToken(),fetch:(url,options)=>UrlFetchApp.fetch(url,options)})
    });
  }
  return {create,createProjects,createDrive,runtime};
})();
function GFM_install(){const result=GFMInstaller.runtime().install();console.log('Spreadsheet: '+result.spreadsheetUrl+'\nBound script ID: '+result.scriptId);return result;}
function GFM_updateInstalledCode(){const result=GFMInstaller.runtime().update();console.log('Spreadsheet: '+result.spreadsheetUrl+'\nBound script ID: '+result.scriptId);return result;}
if(typeof module!=='undefined')module.exports=GFMInstaller;
