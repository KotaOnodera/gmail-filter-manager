var GFMRuntime = (function () {
  'use strict';
  function migrate(d) {
    const existing=d.target.getProperty('GFM_SPREADSHEET_ID');
    if(existing&&existing!==d.bookId)throw new Error('別のスプレッドシートが設定されています');
    if(d.target.getProperty('GFM_MIGRATED')==='1')return;
    if(!d.source)throw new Error('スプレッドシートからWeb用の初期化を実行してください');
    const values=d.source.getProperties(),keys=Object.keys(values).filter(k=>k.startsWith('GFM:')&&!['GFM:preview','GFM:prepared','GFM:webApproval'].includes(k));
    keys.forEach(k=>{const v=d.target.getProperty(k);if(v!==null&&v!==values[k])throw new Error('状態の移行先に衝突があります: '+k);});
    keys.forEach(k=>{d.target.setProperty(k,values[k]);if(d.target.getProperty(k)!==values[k])throw new Error('状態の移行に失敗しました');});
    ['GFM:preview','GFM:prepared','GFM:webApproval'].forEach(k=>d.target.deleteProperty(k));
    d.target.setProperty('GFM_SPREADSHEET_ID',d.bookId);
    d.target.setProperty('GFM_MIGRATED','1');
    if(d.target.getProperty('GFM_MIGRATED')!=='1')throw new Error('初期化の読み返しに失敗しました');
  }
  function owner(book,email) {
    const person=book.getOwner();
    if(!email||!person||person.getEmail().toLowerCase()!==email.toLowerCase())throw new Error('スプレッドシート所有者のアカウントで実行してください');
  }
  function scheduler(api){
    const own=()=>api.getProjectTriggers().filter(t=>t.getHandlerFunction()==='GFM_runFilterJob');
    return {exists:()=>own().length===1,ensure(){const all=own();all.slice(1).forEach(t=>api.deleteTrigger(t));if(!all.length)api.newTrigger('GFM_runFilterJob').timeBased().everyMinutes(1).create();},clear(){own().forEach(t=>api.deleteTrigger(t));}};
  }
  function create(d) {
    owner(d.book,d.email);
    const C=typeof module!=='undefined'?require('./Core'):GFMCore;
    const SheetsStore=typeof module!=='undefined'?require('./Sheets'):GFMSheets;
    const Sync=typeof module!=='undefined'?require('./Sync'):GFMSync;
    const Messages=typeof module!=='undefined'?require('./Messages'):GFMMessages;
    const state={get:k=>{const s=d.props.getProperty('GFM:'+k);return s===null?null:JSON.parse(s);},set:(k,v)=>{const s=JSON.stringify(v);if((d.byteLength?d.byteLength(s):s.length*3)>8000)throw new Error('永続状態が大きすぎます');d.props.setProperty('GFM:'+k,s);if(d.props.getProperty('GFM:'+k)!==s)throw new Error('永続状態の読み返し不一致');},remove:k=>d.props.deleteProperty('GFM:'+k)};
    const store=d.store||SheetsStore.create({book:d.book,app:d.app,api:d.api,hash:d.hash,uuid:d.uuid});
    const deps={bookId:d.book.getId?d.book.getId():'',store,state,gmail:d.gmail,hash:d.hash,uuid:d.uuid,now:d.now||(()=>Date.now()),actor:()=>d.email,notify:d.notify||(()=>{})};
    function withLock(fn){if(!d.lock.tryLock(1000))throw new Error('別の処理が実行中です。完了後に再実行してください');try{return fn();}finally{d.lock.releaseLock();}}
    deps.withLock=withLock;
    if(d.scheduler)deps.scheduler=d.scheduler;
    if(d.withLogLock){const Logging=typeof module!=='undefined'?require('./Logging'):GFMLogging;deps.logger=Logging.create({...deps,withLogLock:d.withLogLock,sink:d.logSink||(()=>{}),enabled:d.logEnabled,byteLength:d.byteLength});}
    const Jobs=typeof module!=='undefined'?require('./Jobs'):GFMJobs;
    return {...deps,withLock,controller:Sync.create(deps),messages:Messages.create(deps),jobs:d.scheduler?Jobs.create(deps):null,version:row=>d.hash(C.stable(C.config([row])))};
  }
  function initialize(book) {
    book=book||SpreadsheetApp.getActiveSpreadsheet();if(!book)throw new Error('対象スプレッドシートから初期化してください');
    owner(book,Session.getEffectiveUser().getEmail());
    const lock=LockService.getScriptLock();if(!lock.tryLock(1000))throw new Error('別の処理が実行中です');
    try{migrate({source:PropertiesService.getDocumentProperties(),target:PropertiesService.getScriptProperties(),bookId:book.getId()});return {spreadsheetId:book.getId(),ready:true};}finally{lock.releaseLock();}
  }
  function open(options) {
    options=options||{};const props=PropertiesService.getScriptProperties();
    if(props.getProperty('GFM_MIGRATED')!=='1'){if(options.book)initialize(options.book);else throw new Error('GASエディターからGFM_enableWebを実行してください');}
    const id=props.getProperty('GFM_SPREADSHEET_ID');if(!id)throw new Error('対象スプレッドシートが設定されていません');
    const book=options.book||SpreadsheetApp.openById(id);if(book.getId()!==id)throw new Error('対象スプレッドシートが一致しません');
    const hash=text=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
    return create({book,props,email:Session.getEffectiveUser().getEmail(),hash,uuid:()=>Utilities.getUuid(),byteLength:s=>Utilities.newBlob(s).getBytes().length,lock:LockService.getScriptLock(),scheduler:scheduler(ScriptApp),withLogLock:fn=>{const lock=LockService.getUserLock();if(!lock.tryLock(50))return false;try{return fn();}finally{lock.releaseLock();}},logEnabled:()=>props.getProperty('GFM:cloudLoggingEnabled')==='true',logSink:text=>{if(props.getProperty('GFM:cloudLoggingEnabled')==='true')console.log(text);},app:SpreadsheetApp,api:Sheets,gmail:GFMGmail.create(Gmail),notify:options.book?message=>book.toast(message,'Gmail管理',5):()=>{}});
  }
  return {scheduler,migrate,create,initialize,open};
})();
function GFM_enableWeb(){return GFMRuntime.initialize();}
if(typeof module!=='undefined')module.exports=GFMRuntime;
