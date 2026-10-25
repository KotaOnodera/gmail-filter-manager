# Gmail Filter Manager

GmailフィルターをGoogleスプレッドシートで編集し、差分確認と承認を経て手動同期するApps Scriptアプリです。**スプレッドシートと、それに紐付くGASの作成もコードに含まれています。**

## 導入の流れ

1. このリポジトリを取得し、`npm run build` でGASインストーラーを生成する。
2. 生成したコードをスタンドアロンのApps Scriptプロジェクトへ配置する。
3. 管理対象アカウントで `GFM_install` を実行する。
4. 実行ログのURLを開き、スプレッドシートの「Gmail管理」メニューを使う。

GFM_installは専用スプレッドシートの作成、Filters / Diff / History / Backupの準備、紐付けGASの作成、同梱ソースの配置・読み返しまで行います。スプレッドシートの手動作成や作成先IDのハードコードは不要です。同じインストーラーの再実行では同じ作成先を利用し、Gmailは変更しません。Googleアカウントの認証とApps Script APIの利用許可は初回に必要です。

**スプレッドシートの保存先は利用者ごとに設定できます。** 初回実行前に、インストーラーの「プロジェクトの設定 → スクリプトプロパティ」に `GFM_DESTINATION_FOLDER_ID` を追加し、保存先フォルダのIDまたはURLを設定してください。未設定ならマイドライブ直下です。設定値はGitHubへ保存されません。詳しくは[保存先の設定](docs/setup.md#保存先の設定)を参照してください。

**インストーラーのGAS自体も任意のフォルダへ配置できます。** 作成後にGoogle Driveで「Gmail Filter Manager Installer」を選び、「移動」で保存先を指定してください。上記のスクリプトプロパティはスプレッドシート専用で、インストーラー自身は移動しません。詳しくは[インストーラー自体の保存先](docs/setup.md#インストーラー自体の保存先)を参照してください。

## 検証・ビルド・配置

Node.js 22以上。追加のnpm依存はありません。

```sh
git clone https://github.com/KotaOnodera/gmail-filter-manager.git
cd gmail-filter-manager
npm test
npm run check

npm install --global @google/clasp
clasp login
clasp create-script --type standalone --title "Gmail Filter Manager Installer" --rootDir dist/installer
npm run build
clasp --ignore .clasp.installerignore show-file-status
clasp --ignore .clasp.installerignore push
```

Apps Scriptエディタでインストーラーの `GFM_install` を実行します。初回のAPI有効化と権限については[導入手順](docs/setup.md)を確認してください。

buildはdist/installer/Code.jsとappsscript.jsonを生成します。実行時にGitHubからコードを取得せず、ビルド時点の運用ソースを同梱します。GitHub Actionsも検証とビルドを実行し、gas-installer成果物を保存します。通常運用にWebアプリのデプロイは不要です。

## フィルターの管理

- 既存フィルター全件を取り込み、条件・アクションと原本JSONを保持する。
- 有効 / 無効 / 削除予定で管理し、行削除だけではGmail側を削除しない。
- Dry Run → 直前バックアップ → 明示承認 → 適用 → 事後検証の順に処理する。
- プレビュー後のシート/Gmail変更を検出する。Gmail側だけの設定はREMOTE_ONLYで表示し、自動削除しない。
- 途中失敗を記録し、作成結果が不明な場合に二重作成しない。

初回取り込み後、Filtersの編集可能列を変更し、「差分をプレビュー」でDiffを確認します。「差分を適用」のYes/No確認に承認した場合だけGmailへ反映します。50変更または4分を目安に停止した場合は、次のDry Runと承認で続行します。

## 構成

| パス | 内容 |
| --- | --- |
| installer/ | スプレッドシート作成・GAS紐付け・コード配置・更新 |
| src/Core.js | 原本マージ、入力検証、正規化、差分 |
| src/Sync.js | 取り込み、承認付き同期、バックアップ、復旧 |
| src/Sheets.js | 4シート、行メタデータでのID更新、追記履歴 |
| src/Gmail.js | 拡張Gmailサービス |
| src/Menu.js | メニュー、所有者確認、排他制御 |
| appsscript.json | 運用用GASのサービスと権限 |
| scripts/ | 配布コード生成・オフライン検証 |
| tests/ | 合成データによる単体・モック統合・障害テスト |

[導入・更新](docs/setup.md) · [列定義](docs/schema.md) · [復旧](docs/recovery.md) · [検証結果](docs/test-report.md) · [設計](docs/design.md) · [インストーラー設計](docs/installer-design.md)

## 制約と権限

単一所有者が自分のGmailを管理する用途です。他の編集者・共有ドライブはサポートしません。

インストーラーはdrive、spreadsheets、script.projects、script.external_request、userinfo.emailを要求します。Drive権限は保存先フォルダの確認と作成したスプレッドシートの配置に使い、Gmail権限は要求しません。運用用GASはgmail.settings.basic、gmail.labels、spreadsheets、script.container.ui、userinfo.emailを使用し、Driveフォルダ操作やメール本文取得は行いません。

Sheets APIで行のシステム列を更新するため、OAuthは全スプレッドシートを対象とする権限です。運用コードの接続先は現在のコンテナIDに限定しています。

Gmailのフィルター上限は1000件です。更新は非原子的で、新旧フィルターが一時的に並存し、転送等の副作用が重なる場合があります。未知フィールドは原本に保持し、未認識フィールドの再作成は停止します。ラベルの自動作成、転送先の新規登録、バックアップの自動削除はしません。

実アカウントでのGAS/OAuth/APIの確認は導入時に行ってください。自動テストはGoogleサービスをモック化しています。配置済みGASを手動変更した場合、インストーラーは更新で上書きせず停止します。
