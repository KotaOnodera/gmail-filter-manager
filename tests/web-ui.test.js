'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('Web page includes mobile accessible entry points and a valid self-contained client',()=>{
  const read=n=>fs.readFileSync(path.join(__dirname,'../'+n+'.html'),'utf8'),html=read('Index'),css=read('Styles'),client=read('Client');
  assert.ok(html.includes('lang="ja"'));assert.ok(html.includes('aria-live="polite"'));assert.ok(html.includes('id="main"'));assert.ok(html.includes('フィルター'));assert.ok(html.includes('変更確認'));assert.ok(html.includes('履歴'));
  assert.ok(css.includes('safe-area-inset-bottom'));assert.ok(!client.includes('.innerHTML'));assert.ok(client.includes('GFM_web'));new vm.Script(client.replace(/^<script>\s*/,'').replace(/\s*<\/script>\s*$/,''));
});
