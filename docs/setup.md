# 導入・更新手順

スマホから利用する場合は、導入後に[Web画面の利用準備と配置](mobile-web.md)を行ってください。

スプレッドシートと運用用GASは、スタンドアロンのインストーラーから自動作成します。認証情報や作成先IDをソースコードへ書き込む必要はありません。

## 1. 準備

- Node.js 22以上。
- 管理対象Gmailと同じGoogleアカウント。
- [Apps Scriptダッシュボードの設定](https://script.google.com/home/usersettings)でApps Script APIへのアクセスを有効化する。
- インストーラーのGoogle CloudプロジェクトでApps Script APIを有効化する。フォルダを指定する場合はGoogle Drive APIも有効化する。必要ならApps Scriptのプロジェクト設定から自分の標準Cloudプロジェクトを関連付ける。[Google公式説明](https://developers.google.com/apps-script/api/how-tos/enable)

API利用許可とOAuth同意はコードから無承認で有効化できません。Workspace管理ポリシーで制限される場合は管理者側の対応が必要です。

## 2. コードを取得してインストーラーを配置する

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

clasp createでスタンドアロンGASとローカルの.clasp.jsonが作成されます。この段階ではスプレッドシートは作成されません。claspが生成したマニフェストを使用しないよう、createの後にbuildを実行してください。

送信対象はdist/installer内のCode.jsとappsscript.jsonだけです。rootDirがdist/installerであることと、statusでこの2ファイルだけが選ばれることを確認します。.clasp.installerignoreの指定を忘れないでください。pushは対象GASのソース全体を置き換えるため、専用の新規プロジェクトを使用します。

既存の空のスタンドアロンGASを使う場合は、.clasp.installer.example.jsonを.clasp.jsonにコピーして、そのGASのscriptIdを指定します。資格情報はリポジトリに保存しないでください。

claspを使わない場合はnpm run buildの後、新規スタンドアロンGASへ生成したCode.jsの内容とインストーラー用マニフェストを貼り付けます。運用用5ファイルの個別コピーは不要です。

### インストーラー自体の保存先

スタンドアロンのインストーラーもGoogle Drive上のファイルなので、任意のマイドライブ内フォルダへ移動できます。上記のコマンドで作成した後、Google Driveで「Gmail Filter Manager Installer」を選択し、「移動」から保存先フォルダを指定してください。インストールの前後どちらでも移動できます。

スクリプトIDは変わらないため、GASエディタのURL、ローカルの`.clasp.json`、スクリプトプロパティ、Cloudプロジェクトの紐付けを変更する必要はありません。Google Drive APIで自動化する場合は、対象ファイルの現在の`parents`を取得してから、`files.update`の`addParents`と`removeParents`で移動し、移動後の`parents`を確認します。

`GFM_DESTINATION_FOLDER_ID`は、次の手順で作成するスプレッドシートの保存先だけを指定します。インストーラー自身の場所は変更しないため、両方を同じフォルダにまとめる場合も、インストーラーの移動とスプレッドシートの保存先設定をそれぞれ行ってください。運用用GASはスプレッドシートに紐づくので、独立したDriveファイルとして移動する必要はありません。

## 3. GFM_installを実行する

### 保存先の設定

**初回のGFM_install実行前**に、インストーラーのGASエディタで「プロジェクトの設定 → スクリプトプロパティ」を開き、任意で次を追加します。

| プロパティ名 | 値 |
| --- | --- |
| `GFM_DESTINATION_FOLDER_ID` | 保存先フォルダのID、またはGoogle DriveのフォルダURL |

フォルダURLの例は `https://drive.google.com/drive/folders/フォルダID` です。コピーしたIDだけでも使えます。利用者自身のインストーラーに設定するため、コードの書き換えや公開リポジトリへの個別設定の保存は不要です。

- 未設定・空欄: 実行者のマイドライブ直下に作成する。
- 指定あり: フォルダの存在・種類・書き込み権限を確認してから作成し、そのフォルダへ配置する。
- 無効・権限不足: 作成前に停止する。配置途中で失敗した場合は作成済みIDを保持し、別ファイルを増やさず再開する。
- 共有ドライブ: 現在の単一所有者モデルでは非対応。マイドライブ内のフォルダを指定する。

自身の所有フォルダ、または実行アカウントへ直接共有された書き込み可能フォルダを利用してください。リンク共有だけでアクセスし、別途resource keyが必要なフォルダは現在の対象外です。

フォルダの共有権限は保存するファイルにも影響します。Gmailの条件や転送先を記録するため、保存先の共有範囲を確認してください。

この設定は初回の作成先を決めるものです。配置前に設定が変わったら元の設定へ戻すよう要求します。**導入完了後に設定を変えて再実行しても、既存のスプレッドシートを自動で移動しません。** 既存ファイルの保存先はGoogle Drive上で手動変更できます。ファイルIDは変わらないので、その後も同じインストールを利用できます。

### 実行

1. 配置したスタンドアロンGASのエディタを開く。
2. 実行する関数にGFM_installを選んで実行する。
3. 初回のGoogle認証でインストーラー用権限を確認する。
4. 実行ログのSpreadsheet:のURLを開く。

この関数は専用スプレッドシートを作成し、5シートを準備し、Apps Script APIのparentId指定で紐付けたGASを作成します。同梱ソースとマニフェストを配置後、読み返して一致を確認します。[プロジェクト管理API](https://developers.google.com/apps-script/api/how-tos/manage-projects)

最初の空シートはFiltersとして再利用します。既存データや他のファイルは消しません。Gmailへの接続・取り込み・変更はこの段階では行いません。

作成先ID・所有者・段階はインストーラーのScriptPropertiesのGFM_INSTALL_STATEへ保存します。再実行は同じ作成先を利用し、新規ファイルを増やしません。保存済みファイルが開けない場合も新規作成に切り替えません。

## 4. 作成されたスプレッドシートで運用する

1. URLを開くか再読み込みし、Gmail管理メニューを表示する。
2. 最初のメニュー操作で運用用GASの権限を認証する。
3. 既存フィルターを取り込み、FiltersとBackupのCOMPLETE行を確認する。
4. 変更なしでDry Runを実行し、管理対象がNOOPになることを確認する。
5. 編集後はDry Run → Diff確認 → 承認付き適用 → 検証の順に操作する。

運用用GASはGmail v1とSheets v4の拡張サービスをマニフェストで指定しています。標準Cloudプロジェクトを運用側にも紐付ける場合は、Gmail APIとSheets APIをそちらでも有効化します。[拡張サービス](https://developers.google.com/apps-script/guides/services/advanced)

カスタムメニューを使うため、運用コードはコンテナバインド方式です。[Googleの仕様](https://developers.google.com/apps-script/guides/menus)に合わせて、インストーラーが紐付けGASを作成します。

## 5. 権限の分離

| 対象 | スコープ | 用途 |
| --- | --- | --- |
| インストーラー | drive | 指定フォルダの情報・権限確認、作成したファイルの親フォルダ変更 |
| インストーラー | spreadsheets | ファイル作成・5シート準備 |
| インストーラー | script.projects | 紐付けGAS作成・ソース配置・検証・更新 |
| インストーラー | script.external_request | Apps Script APIとGoogle Drive APIへの通信 |
| インストーラー | userinfo.email | 初回実行者との照合 |
| 運用用GAS | gmail.settings.basic | フィルター管理・転送先一覧 |
| 運用用GAS | gmail.labels | ラベルID/名前の一覧 |
| 運用用GAS | gmail.modify | 既存メールの検索とラベル付与・アーカイブ・既読化 |
| 運用用GAS | spreadsheets | 行メタデータを指定した更新 |
| 運用用GAS | script.container.ui | メニューと承認ダイアログ |
| 運用用GAS | userinfo.email | 所有者照合 |

接頭辞はすべてhttps://www.googleapis.com/auth/です。運用用GASにGASプロジェクト/Driveの変更権限を付けず、インストーラーにGmail権限を付けません。インストーラーのdriveはDrive全体に対する権限ですが、実装は利用者が指定したフォルダの確認と、記録済みスプレッドシートの配置だけに使います。外部通信先はApps Script APIとGoogle Drive APIの固定HTTPSホストです。実行時にGitHubや第三者へ設定を送信しません。[Driveのフォルダ移動API](https://developers.google.com/workspace/drive/api/guides/folder)

Sheets APIのbatchUpdateByDataFilterはspreadsheets.currentonlyを受け付けないため、運用側の権限もspreadsheetsです。実装の操作先IDは現在のコンテナに限定しています。[対応スコープ](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdateByDataFilter)

## 6. コード更新

```sh
git pull
npm test
npm run check
npm run build
clasp --ignore .clasp.installerignore push
```

同じインストーラーのGASエディタでGFM_updateInstalledCodeを明示実行します。記録された運用用GASへ新ソースを配置して読み返します。Filters・History・Backupは作り直しません。更新中は同期やシート編集を止めてください。

GFM_installはバージョン変更を検出して明示更新を要求します。運用GASを手動編集した場合はupdateも停止します。手編集を必要な修正としてリポジトリへ取り込み、基準を確認してから更新してください。WebアプリやAPI実行可能ファイルのデプロイは不要です。

既存のコンテナバインドGASへ直接配置する保守用経路では、従来の.clasp.example.jsonと.claspignoreを使用できます。

## 7. エラー時

作成結果不明の場合は状態をリセットして再実行せず、[復旧手順](recovery.md)でファイルとGASを照合します。HTTP 403ではCloud側のAPI有効化、ダッシュボード側の利用許可、OAuth同意を確認してください。
