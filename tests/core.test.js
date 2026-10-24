'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = fs.existsSync(require('node:path').join(__dirname, '../src/Core.js')) ? require('../src/Core.js') : {};
const key = '11111111-1111-4111-8111-111111111111';
const labels = [
  ...['INBOX','UNREAD','SPAM','IMPORTANT','STARRED','TRASH','CATEGORY_SOCIAL'].map(id => ({id,name:id,type:'system'})),
  {id:'Label_1',name:'仕事/重要',type:'user'}, {id:'Label_2',name:'Other',type:'user'}
];
const context = {labels,forwarding:[{forwardingEmail:'dest@example.com',verificationStatus:'accepted'}]};
const base = () => ({id:'old',criteria:{from:'sender@example.com'},action:{removeLabelIds:['INBOX']}});
const row = () => C.importFilter(base(),labels,key);
const state = filters => ({...context,filters});

test('T03 all criteria retain absence, explicit false, zero and search whitespace', () => {
  const f={id:'a',criteria:{from:'=sender',to:'t@example.com',subject:'日本語',query:'  has:attachment  ',negatedQuery:'is:chat',hasAttachment:false,excludeChats:true,size:0,sizeComparison:'unspecified'},action:{addLabelIds:['Label_1'],removeLabelIds:[]}};
  assert.deepEqual(C.toFilter(C.importFilter(f,labels,key),context).filter,{criteria:f.criteria,action:f.action});
  for(const criteria of [{from:'x'},{hasAttachment:false},{size:0,sizeComparison:'larger'}]) {
    const f={id:'a',criteria,action:{}};
    assert.deepEqual(C.toFilter(C.importFilter(f,labels,key),context).filter,{criteria,action:{}});
  }
});
test('T04 full actions and additional labels round-trip', () => {
  const f={id:'a',criteria:{query:'from:x'},action:{addLabelIds:['TRASH','Label_1','STARRED','IMPORTANT','CATEGORY_SOCIAL'],removeLabelIds:['INBOX','UNREAD','SPAM'],forward:'dest@example.com'}};
  const r=C.importFilter(f,labels,key);
  assert.equal(r.UserLabel,'仕事/重要');
  assert.deepEqual(C.toFilter(r,context).filter,{criteria:f.criteria,action:f.action});
  r.MarkImportant=false;r.NeverImportant=true;r.UserLabel='Other';r.Archive=false;
  const out=C.toFilter(r,context).filter;
  assert.deepEqual(new Set(out.action.addLabelIds),new Set(['TRASH','Label_2','STARRED','CATEGORY_SOCIAL']));
  assert.deepEqual(new Set(out.action.removeLabelIds),new Set(['UNREAD','SPAM','IMPORTANT']));
});
test('editable columns override raw JSON; untouched known keys and unknown keys survive', () => {
  const f={id:'a',criteria:{from:'x',subject:'',future:{v:1}},action:{futureAction:false,addLabelIds:[]}};
  const r=C.importFilter(f,labels,key);r.From='y';
  const out=C.toFilter(r,context);
  assert.equal(out.filter.criteria.from,'y');assert.equal(out.filter.criteria.subject,'');
  assert.deepEqual(out.filter.criteria.future,{v:1});assert.equal(out.filter.action.futureAction,false);
  assert.ok(out.unknown.length===2);
  assert.equal(C.plan([r],state([f]))[0].operation,'ERROR');
  r.From='x';assert.equal(C.plan([r],state([f]))[0].operation,'NOOP');
  r.Status='無効';assert.equal(C.plan([r],state([f]))[0].operation,'DELETE');
});
test('stable normalization treats only label arrays as sets, retains scalar distinctions', () => {
  assert.equal(C.stable(C.normalize({criteria:{from:'x'},action:{addLabelIds:['B','A','A']}})),C.stable(C.normalize({action:{addLabelIds:['A','B']},criteria:{from:'x'}})));
  assert.notEqual(C.stable({hasAttachment:false}),C.stable({}));
  assert.notEqual(C.stable({size:0}),C.stable({}));
});
test('T10 remote-only filter including deleted sheet row is never a DELETE', () => {
  const p=C.plan([],state([base()]));assert.equal(p[0].operation,'REMOTE_ONLY');assert.equal(p[0].before.id,'old');
});
test('statuses map to CREATE/NOOP/REPLACE/DELETE and keep immutable keys', () => {
  const r=row();assert.equal(C.plan([r],state([base()]))[0].operation,'NOOP');
  r.Subject='changed';assert.equal(C.plan([r],state([base()]))[0].operation,'REPLACE');
  r.Status='無効';assert.equal(C.plan([r],state([base()]))[0].operation,'DELETE');
  r.Status='削除予定';assert.equal(C.plan([r],state([]))[0].operation,'NOOP');
  r.Status='有効';assert.equal(C.plan([r],state([]))[0].operation,'CREATE');
});
test('equivalent remote rules are adopted by unique ID; ambiguous matches block', () => {
  const r=row();r.GmailFilterId='';
  let p=C.plan([r],state([base()]));assert.equal(p[0].operation,'NOOP');assert.equal(p[0].matchedId,'old');
  p=C.plan([r],state([base(),{...base(),id:'other'}]));assert.equal(p[0].operation,'ERROR');
});
test('T12 rejects invalid inputs before producing mutations', () => {
  const patches=[{Status:'oops'},{HasAttachment:'yes'},{SizeBytes:-1},{SizeBytes:'2.1'},{SizeComparison:'bad'},{UserLabel:'missing'},{ForwardTo:'unverified@example.com'},{MarkImportant:true,NeverImportant:true},{AdditionalAddLabelIds:'oops'},{AdditionalAddLabelIds:'["unknown"]'},{AdditionalAddLabelIds:'["INBOX"]'},{From:'',OriginalJson:'',OriginalRowJson:''}];
  for(const patch of patches) {const r={...row(),...patch};assert.equal(C.plan([r],state([base()]))[0].operation,'ERROR',JSON.stringify(patch));}
});
test('duplicate keys or Gmail IDs block all implicated rows; invalid UUID blocked', () => {
  const r=row();assert.ok(C.plan([r,{...r}],state([base()])).filter(e=>e.operation==='ERROR').length===2);
  const r2={...r,RuleKey:'22222222-2222-4222-8222-222222222222'};
  assert.ok(C.plan([r,r2],state([base()])).filter(e=>e.operation==='ERROR').length===2);
  assert.equal(C.plan([{...r,RuleKey:'bad'}],state([base()]))[0].operation,'ERROR');
});
test('T14 at 1000 filters REPLACE is blocked and no delete-first fallback', () => {
  const filters=Array.from({length:1000},(_,i)=>({...base(),id:i===0?'old':String(i)}));
  const r=row();r.Subject='new';assert.equal(C.plan([r],state(filters))[0].operation,'ERROR');
});
test('T17 forwarding and trash are included in risk and non-atomic warning', () => {
  const r=row();r.MoveToTrash=true;r.ForwardTo='dest@example.com';
  const e=C.plan([r],state([base()]))[0];assert.equal(e.operation,'REPLACE');assert.ok(e.risks.includes('TRASH'));assert.ok(e.risks.includes('FORWARD'));assert.ok(e.warnings.length);
});
test('T18 formula strings and leading apostrophes round-trip without changing their text', () => {
  for(const value of ['=IMPORTXML("x")',"'literal",'+1','-1','@x','日本語\n特殊','',false,0]) {
    if(typeof value!=='string'||value==='')continue;
    const f={id:'f',criteria:{subject:value},action:{}};
    assert.equal(C.toFilter(C.importFilter(f,labels,key),context).filter.criteria.subject,value);
  }
});
module.exports={labels,context,key,base,row,state};
