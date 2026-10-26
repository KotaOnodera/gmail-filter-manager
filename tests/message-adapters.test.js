'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Gmail=require('../src/Gmail'),Sheets=require('../src/Sheets'),{fakeSheets}=require('./fake-sheets'),{hash,key}=require('./helpers');
test('Gmail message adapter requests a bounded ID page and never touches threads or unsupported actions',()=>{
  let sent;
  const adapter=Gmail.create({Users:{Messages:{list(user,options){assert.equal(user,'me');assert.deepEqual(options,{q:'from:(sender@example.com)',maxResults:500,includeSpamTrash:false,pageToken:'p2'});return {messages:[{id:'a',threadId:'thread-with-unmatched-message'}],nextPageToken:'p3',resultSizeEstimate:9999};},batchModify(body,user){sent={body,user};}},Labels:{list(){return {labels:[{id:'Label_1',type:'user'},{id:'STARRED',type:'system'}]};}}}});
  assert.equal(typeof adapter.listMessages,'function');assert.deepEqual(adapter.listMessages('from:(sender@example.com)','p2'),{ids:['a'],nextPageToken:'p3'});
  adapter.modifyMessages(['a'],{addLabelIds:['Label_1'],removeLabelIds:['INBOX','UNREAD']});assert.deepEqual(sent,{user:'me',body:{ids:['a'],addLabelIds:['Label_1'],removeLabelIds:['INBOX','UNREAD']}});
  for(const action of [{addLabelIds:['STARRED'],removeLabelIds:[]},{addLabelIds:[],removeLabelIds:['SPAM']},{addLabelIds:['Label_1'],removeLabelIds:[],forward:'dest@example.com'}])assert.throws(()=>adapter.modifyMessages(['a'],action));
  assert.throws(()=>adapter.modifyMessages([],{}));assert.throws(()=>adapter.modifyMessages(['a','a'],{addLabelIds:['Label_1'],removeLabelIds:[]}));
});
test('message data round-trips above property/cell limits using bounded, hash-checked Backup ranges',()=>{
  const f=fakeSheets(),store=Sheets.create({...f,hash,uuid:()=>key});store.setup();assert.equal(typeof store.writeMessageData,'function');
  const data={text:'x'.repeat(90000),ids:Array.from({length:1000},(_,i)=>'message-'+i)};
  const pointer=store.writeMessageData('run-1',data);assert.ok(JSON.stringify(pointer).length<500);assert.deepEqual(store.readMessageData(pointer),data);
  store.writeMessageData('run-2',{keep:'other run'});assert.deepEqual(store.readMessageData(pointer),data);
  const sheet=f.sheets.get('Backup');sheet.values[pointer.row-1][6]='tampered';assert.throws(()=>store.readMessageData(pointer));
  assert.throws(()=>store.readMessageData({...pointer,parts:10000000}));
});
