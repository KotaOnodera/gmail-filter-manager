# テストの見直し（2026-10-29）

## 判断

434ケースをすべて恒久的に残す必要はない。ただし、一括削除や件数を目標にした削減は勧めない。今回の停止・結果不明・強制適用に関係する回帰、Gmail変更の重複防止、ID関連付け、シート保存の検証は残す。まず重複する静的検査を縮小し、次に旧経路を廃止できるか判断する。

今回の変更はCIの削除と見直し結果の記録までとし、テスト自体は削除していない。削除候補と、機能・互換性の廃止を先に決める必要がある候補を区別する。

## 確認した事実

- Nodeの実行結果は42ファイル・434ケース成功、失敗・スキップ0。全体の実行時間は約1秒。個別ケースの時間は並列実行のため加算しない。
- 追加のnpm依存はなく、テストはローカルの偽Gmail・Sheetsと実際のCore/Jobs/Web/Client等を組み合わせて動かす。実Gmailへの適用やGASデプロイの代用にはならない。
- ファイル別ケース一覧と、削減候補・対応する代替検査のコードを確認した。完全なmutation testingや、削除後の全不具合検出率の証明は行っていない。
- `npm run check`は、GASの逆順ロード、入口、マニフェスト・スコープ、アップロード許可リスト、文書リンクを検査する。CI削除後もローカルで実行する。

## 削除・縮小してよい候補

| 対象 | 判断 | 理由・残すもの |
| --- | --- | --- |
| `hardening.test.js` の `GAS scripts load in reverse order without CommonJS or top-level service access` | 削除候補（1ケース） | `scripts/check.js`がより広い全ランタイムを逆順ロードし、`onOpen`等の入口も検査する。スキーマ整合性はSheetsの実動作テストで維持する。ローカルでcheckを必須にする前提。 |
| `web-ui.test.js` の日本語ラベル完全一致、削除済みRPC名の文字列不在、Clientの構文確認 | テスト内の一部を縮小 | 表示文言だけの変更で落ちる。Clientの構文は多数の実Clientテストで読込時に検証する。削除済みコマンドをサーバーが拒否するテストはあるが、Clientがそのコマンドを呼ばないことの代わりにはならない。この静的検査を外すと、古いRPCの呼び出しが混入した場合の専用検出は失う。公開操作の実Clientテストを残す前提で、優先度の低い検査として縮小候補にする。`lang`、`aria-live`、初期操作の存在など固有のHTML契約は残す。ファイル全削除はしない。 |
| `client-views.test.js` の `new user action suppresses old saved-view response and retrieval deadline unlocks retry` | 統合後の削除候補（1ケース） | `client-read-deadline.test.js`が30秒の直前・到達・再試行と遅延応答の拒否を確認する。`final-client-regressions.test.js`も別画面を遅延応答が上書きしないことを検証する。元テストの「タイムアウト後に別操作」条件を残す側へ移してから削除する。 |
| `review-regressions.test.js`、`final-client-regressions.test.js`等の履歴・指摘番号別ファイル | 機能別へ統合。ケースの削除とは別 | 回帰の保存理由は有効。Jobs、Clientの復帰、Sheetsの行特定など、守っている動作のファイルへ移すと探しやすい。`P1`、`F1`の名称だけを根拠に不要とはしない。 |

現時点で、無条件に数十〜数百ケース削除してよいという根拠はない。最初の削減は1ケースと静的アサーションの縮小が確実で、もう1ケースは条件を統合してから削除できる。

## 先に運用・機能の廃止判断が必要なもの

`Sync.apply`の旧同期実行は、本番Runtimeが常にJobsを渡す現在のWeb/Menuの通常経路では使われない。Web/Menuには`d.jobs`がない場合のフォールバックが残り、過去の`pending`はJobsの準備が呼ぶSyncの復旧ヘルパーで照合する。その後、旧置換の`cleanup`を新しいJobsへ移して完了させる。

このため、旧同期適用の速度を測る`hardening.test.js`の `1000 unchanged rules require a bounded number of Gmail reads` は優先度が低い。旧同期経路そのものを廃止するなら、`sync.test.js`・`selection.test.js`・`label-sync.test.js`等の旧実行にだけ関係するケースを同時に整理する。これらのファイルにはインポート、承認、ラベル解決など現在も使う処理が混在するため、ファイル単位では削除しない。

`legacy-job-upgrade.test.js`の26ケースは、保存済みpending/cleanupの互換性を守る。本番には実際に旧ポリシーの停止ジョブが残っているため、今は削除しない。旧同期の新規実行を廃止しても、保存状態を読み取る移行テストまで同時に消せるとは限らない。

## 残すべきテスト

| 分類 | 対象・残す理由 |
| --- | --- |
| スプシ正本 | `authoritative-jobs` / `authoritative-web` / `client-authoritative`。Gmail差分を上書きし、選択範囲を守り、残った差分を提示する。旧承認を勝手に強制適用へ変えない。 |
| 作成結果不明・二重実行 | `jobs` / `legacy-job-upgrade` / `preparation-scope-recovery`。作成応答の喪失、再実行、残り確認、旧ID削除の順序を守る。今回も作成直前のID一覧が失われる実バグを検出した。 |
| シートへの正しい保存 | `adapters` / `reference-update` / `label-store` / `job-integration`。並べ替え・欠損・メタデータ破損・応答喪失が別の行の上書きにつながらないことを検証する。 |
| 画面の停止・復帰 | `client-progress-recovery` / `client-read-deadline` / `client-boot` / `client-message-state` / `client-session`。通信失敗、画面破棄、遅延応答、再読込で適用を再送せずに状況を表示する。層が違うため同じ「再送しない」という名前だけでは重複扱いにしない。 |
| 承認・所有者・対象範囲 | `confirmation-expiry` / `client-confirmation-expiry` / `runtime` / `web-views` / `single-confirmation`等。期限切れや別アカウントの保存データでGmailを変更できないことを確認する。 |
| ビルドと配置物 | `build` / `installer`。実際に生成されたインストーラーのソース同梱漏れや権限混入を検出する。ソース側のcheckとは対象が違うため残す。 |
| フィルター・ラベル変換 | `core` / `labels`。falseと未指定、0、未知のAPI項目、重複ID、ラベル参照などの変換誤りを小さい入力で検出する。Sheets統合テストと役割が異なる。 |
| 既存メールの変更 | `messages` / `message-web` / `message-adapters`。メール変更を使い続けるなら、検索の分割・中断・重複抑止・一括変更の制限を残す。機能ごと廃止するときに整理する。 |

検索・固定操作バー・設定リンクも公開中の機能なので、振る舞いの検証は残す。ただしCSSクラス名や正確な文言への依存は必要な箇所に絞る。実端末の表示崩れやGmail固有の副作用は、偽DOM・偽APIのテストだけでは確認できない。

## 今後の追加基準

- データの誤変更、停止、二重実行、復旧不能を防ぐケースを優先する。
- 既存テストに同じ入力と失敗条件があれば新設せず統合する。
- 文言・CSSの軽微な変更だけなら新しいテストは追加しない。
- 同じ結果でも発生する層・タイミング・保存状態が違えば、削除前にどの不具合を見逃すか確認する。
- マージ前とGAS配置前に、ローカルで `npm test`、`npm run check`、`npm run build` を実行し、PRへ結果を記録する。

## ファイル別の実行ケース数

以下は件数の棚卸し。ケース数が多いことだけを削除理由にはしない。

| ファイル | ケース数 |
| --- | ---: |
| `adapters.test.js` | 11 |
| `authoritative-jobs.test.js` | 18 |
| `authoritative-web.test.js` | 8 |
| `build.test.js` | 2 |
| `client-authoritative.test.js` | 5 |
| `client-boot.test.js` | 6 |
| `client-confirmation-expiry.test.js` | 10 |
| `client-message-state.test.js` | 10 |
| `client-progress-recovery.test.js` | 13 |
| `client-read-deadline.test.js` | 6 |
| `client-search.test.js` | 12 |
| `client-session.test.js` | 6 |
| `client-sticky-actions.test.js` | 9 |
| `client-views.test.js` | 17 |
| `configuration-links.test.js` | 7 |
| `confirmation-expiry.test.js` | 16 |
| `core.test.js` | 12 |
| `final-client-regressions.test.js` | 4 |
| `hardening.test.js` | 4 |
| `installer.test.js` | 20 |
| `integration.test.js` | 2 |
| `job-integration.test.js` | 10 |
| `job-logging.test.js` | 3 |
| `jobs.test.js` | 26 |
| `label-store.test.js` | 3 |
| `label-sync.test.js` | 16 |
| `labels.test.js` | 4 |
| `legacy-job-upgrade.test.js` | 26 |
| `message-adapters.test.js` | 2 |
| `message-web.test.js` | 9 |
| `messages.test.js` | 19 |
| `preparation-scope-recovery.test.js` | 10 |
| `reference-update.test.js` | 13 |
| `review-regressions.test.js` | 3 |
| `runtime.test.js` | 4 |
| `selection.test.js` | 8 |
| `single-confirmation.test.js` | 23 |
| `sync.test.js` | 21 |
| `web-store.test.js` | 3 |
| `web-ui.test.js` | 1 |
| `web-views.test.js` | 17 |
| `web.test.js` | 15 |
| 合計（42ファイル） | 434 |
