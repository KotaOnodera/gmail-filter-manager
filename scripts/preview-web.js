/* Local-only synthetic fixture. Never uploaded to GAS. */
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const C=require('../src/Core'),W=require('../src/Web'),S=require('../src/Sheets'),Sync=require('../src/Sync'),Messages=require('../src/Messages'),{fakeSheets}=require('../tests/fake-sheets'),{harness,hash,labels}=require('../tests/helpers');
const root=path.resolve(__dirname,'..'),h=harness(),f=fakeSheets();
const store=S.create({...f,hash,uuid:()=>crypto.randomUUID()});store.setup();
store.appendRows(h.rows);
const extra=[{id:'newsletter',criteria:{from:'newsletter@example.com'},action:{addLabelIds:['Label_1','STARRED'],removeLabelIds:['INBOX'],forward:'dest@example.com'}},{id:'receipt',criteria:{subject:'領収書'},action:{addLabelIds:['STARRED']}}];
h.data.filters.push(...extra);store.appendRows(extra.map(x=>C.importFilter(x,labels,crypto.randomUUID())));
if(process.env.GFM_PREVIEW_CHANGES==='1'){const rows=f.sheets.get('Filters').values;rows[1][C.columns.indexOf('Subject')]='最初の変更';rows[2][C.columns.indexOf('Subject')]='残す変更';}
if(process.env.GFM_PREVIEW_LABELS==='1'){
  const existing=crypto.randomUUID(),fresh=crypto.randomUUID();
  store.appendLabelRows([{LabelKey:existing,Name:process.env.GFM_PREVIEW_LONG==='1'?'Finances/MoneyForwardME/MonthlyReport/Service'.repeat(4):'仕事/経理',GmailLabelId:'Label_1',SyncedName:'仕事'},{LabelKey:fresh,Name:'新規/請求書'}]);
  store.appendRows([{RuleKey:crypto.randomUUID(),Status:'有効',From:'billing@example.com',UserLabel:'新規/請求書',Archive:true,MarkRead:true}]);
}
const deps={...h.deps,store,now:()=>Date.now(),actor:()=> 'owner@example.com',bookId:'book',withLock:fn=>fn(),version:r=>hash(C.stable(C.config([r])))};deps.controller=Sync.create(deps);
let messageWrites=0;
deps.gmail.listMessages=(query,token)=>({ids:token?['message-c']:['message-a','message-b'],nextPageToken:token?'':'page2'});
deps.gmail.modifyMessages=(ids,action)=>{messageWrites++;if(action.removeLabelIds.some(id=>!['INBOX','UNREAD'].includes(id)))throw Error('Unexpected action');};
deps.messageMaxSteps=1;deps.messageBatchSize=1;deps.messages=Messages.create(deps);
const web=W.create(deps);
let loseMessageResponse=process.env.GFM_PREVIEW_LOST_MESSAGES==='1';
let loseApplyResponse=process.env.GFM_PREVIEW_LOST_APPLY==='1';
function html(){return fs.readFileSync(path.join(root,'Index.html'),'utf8').replace('<?!= styles ?>',fs.readFileSync(path.join(root,'Styles.html'),'utf8')).replace('<?!= session ?>',fs.readFileSync(path.join(root,'Session.html'),'utf8')).replace('<?!= client ?>','<script>window.GFM_LOCAL=true;</script>'+fs.readFileSync(path.join(root,'Client.html'),'utf8'));}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html());return;}
  if(req.method==='GET'&&req.url==='/test-stats'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({messageWrites}));return;}
  if(req.method==='POST'&&req.url==='/api'){let data='';try{for await(const chunk of req){data+=chunk;if(data.length>200000)throw new Error('Too large');}const {command,input}=JSON.parse(data);res.setHeader('Content-Type','application/json');const result=web.dispatch(command,input);if(['apply','messagesApply','messagesScan'].includes(command)&&process.env.GFM_PREVIEW_HOLD_MS)await new Promise(resolve=>setTimeout(resolve,Math.min(120000,Number(process.env.GFM_PREVIEW_HOLD_MS)||0)));if(command==='messagesApply'&&loseMessageResponse){loseMessageResponse=false;throw new Error('テスト用の通信断: 既存メールの処理後に応答を喪失');}if(command==='apply'&&loseApplyResponse){loseApplyResponse=false;throw new Error('テスト用の通信断: サーバー処理後の応答を喪失');}res.end(JSON.stringify({data:result}));}catch(err){res.end(JSON.stringify({error:err.message}));}return;}
  res.statusCode=404;res.end('Not found');
});
server.listen(Number(process.env.GFM_PREVIEW_PORT||4179),'127.0.0.1',()=>console.log('Synthetic local preview: http://127.0.0.1:'+server.address().port));
