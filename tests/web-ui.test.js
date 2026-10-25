'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('Web page includes mobile accessible entry points and a valid self-contained client',()=>{
  const read=n=>fs.readFileSync(path.join(__dirname,'../'+n+'.html'),'utf8'),html=read('Index'),css=read('Styles'),client=read('Client');
  assert.ok(html.includes('lang="ja"'));assert.ok(html.includes('aria-live="polite"'));assert.ok(html.includes('id="main"'));
  for(const command of ['import','all','selected','history'])assert.ok(html.includes('data-command="'+command+'"'),'operation available in initial HTML: '+command);
  for(const text of ['インポート','全部適用','選んで部分適用','実行ログ'])assert.ok(html.includes(text));
  assert.ok(!client.includes("rpc('save'")&&!client.includes("rpc('new'")&&!client.includes("rpc('list'"));
  assert.ok(css.includes('safe-area-inset-bottom'));assert.ok(!client.includes('.innerHTML'));assert.ok(client.includes('GFM_web'));new vm.Script(client.replace(/^<script>\s*/,'').replace(/\s*<\/script>\s*$/,''));
});
