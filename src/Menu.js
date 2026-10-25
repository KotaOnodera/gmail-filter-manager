var GFMMenu = (function () {
  'use strict';
  function create(d) {
    function apply() {
      const ticket=d.withLock(()=>d.controller.prepare()),s=ticket.summary;
      const message='RunId: '+ticket.runId+'\nCREATE '+(s.CREATE||0)+' / REPLACE '+(s.REPLACE||0)+' / DELETE '+(s.DELETE||0)+'\n危険操作: TRASH '+(s.TRASH||0)+' / 転送 '+(s.FORWARD||0)+'\nGmail側のみ '+(s.REMOTE_ONLY||0)+'件（削除しません）\nバックアップ: '+ticket.snapshotId+'\n更新は非原子的で、新旧フィルターが一時的に同時に有効になります。転送等の副作用が重複する場合があります。\nこの差分を適用しますか？';
      const approved=d.confirm('Gmailへの反映を承認',message);
      const result=d.withLock(()=>d.controller.apply(ticket,approved));d.show('同期結果',result.status+' / 完了 '+result.completed+'件'+(result.error?'\n'+result.error:''));return result;
    }
    function importAll() {
      const ticket=d.withLock(()=>d.controller.importAll(false));
      if(!d.confirm('既存フィルターの取り込み','Gmail全'+ticket.total+'件のうち未登録'+ticket.count+'件をFiltersに追加します。既存行の編集は維持し、Gmailは変更しません。'))return;
      const result=d.withLock(()=>d.controller.importAll(true,ticket));d.show('取り込み完了',result.count+'件を追加しました');return result;
    }
    function preview(){const result=d.withLock(()=>d.controller.preview());d.show('差分プレビュー',JSON.stringify(result.summary)+'\nDiffを確認してください。Gmailは変更していません。');return result;}
    function verify(){const r=d.withLock(()=>d.controller.verify());d.show('検証結果',(r.ok?'管理対象は一致':'未解決の差分 '+r.unresolved.length+'件')+'\nGmail側のみ '+r.remoteOnly+'件');return r;}
    return {apply,importAll,preview,verify};
  }
  function runtime() {
    const book=SpreadsheetApp.getActiveSpreadsheet(),ui=SpreadsheetApp.getUi();
    const d=GFMRuntime.open({book});
    return {...d,confirm:(title,message)=>ui.alert(title,message,ui.ButtonSet.YES_NO)===ui.Button.YES,show:(title,message)=>ui.alert(title,message,ui.ButtonSet.OK)};
  }
  function run(command) {
    // Alerts must be outside the lock; alerts suspend GAS and release locks.
    try {
      const d=runtime();d.notify('処理を開始します');
      if(command==='setup'){d.withLock(()=>d.store.setup());d.show('初期設定完了','4シートを準備しました。システム列は警告付き保護です。');}
      else if(command==='history'||command==='backup')d.store.open(command==='history'?'History':'Backup');
      else {const runner=create(d);runner[command]();}
    } catch(err){SpreadsheetApp.getUi().alert('Gmail管理: 処理停止',String(err.message),SpreadsheetApp.getUi().ButtonSet.OK);}
  }
  return {create,run};
})();
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Gmail管理')
    .addItem('初期設定・シート準備','GFM_setup')
    .addItem('既存フィルターを取り込む（初回・追加）','GFM_import')
    .addItem('差分をプレビュー（Dry Run）','GFM_preview')
    .addItem('差分を適用（承認付き）','GFM_apply')
    .addItem('同期結果を検証','GFM_verify')
    .addItem('Web画面の利用準備','GFM_enableWeb')
    .addSeparator().addItem('履歴を開く','GFM_history').addItem('バックアップを開く','GFM_backup').addToUi();
}
function GFM_setup(){GFMMenu.run('setup');}
function GFM_import(){GFMMenu.run('importAll');}
function GFM_preview(){GFMMenu.run('preview');}
function GFM_apply(){GFMMenu.run('apply');}
function GFM_verify(){GFMMenu.run('verify');}
function GFM_history(){GFMMenu.run('history');}
function GFM_backup(){GFMMenu.run('backup');}
if(typeof module!=='undefined')module.exports=GFMMenu;
