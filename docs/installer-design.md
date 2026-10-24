# GASインストーラーの設計

目的: スプレッドシートの作成もGASに含め、リポジトリのコードから導入を再現する。

GFM_installをスタンドアロンGASで実行すると、専用スプレッドシートの作成、4シート準備、コンテナバインドGASの作成、同梱ソース配置・読み返しまで行う。実行はGmailへアクセスしない。Googleアカウントの認証とAPIの利用許可は利用者が行う。

カスタムメニューはbound scriptだけが利用できるため、運用するGASは引き続きスプレッドシートに紐付ける。インストーラーを実行するとApps Script APIのparentId指定で自動生成する。Webアプリや自動同期トリガーは追加しない。

## ファイルと境界

- installer/Installer.js: 注入可能な作成処理、ScriptProperties/ScriptLock、固定ホストのApps Script APIラッパー。
- installer/appsscript.json: 作成専用権限。Gmail権限なし。
- scripts/build.js: 現在のsrcと実行用マニフェストを埋め込んだdist/installer/Code.jsとインストーラーのマニフェストを決定的に生成する。外部コードを実行時に取得しない。
- tests/installer.test.js: 初回作成、再実行、所有者/ロック、各段階の失敗、応答不明、更新時の手編集検出。
- tests/build.test.js: 生成ソースの読み込み、同梱ソース一致、秘密情報/私的資料を含めないこと。

## チェックポイント

ScriptPropertiesにowner・作成先ID・段階・配置ハッシュを保存し、保存後に読み返す。createの直前にintentを保存し、結果不明なら自動再作成をブロックする。既知IDへのPUTは配置前のハッシュを記録して再開し、応答不明でも読み返して同一なら完了とする。手動変更があれば上書きしない。

別の実行者は既存の作成先を利用できない。多重実行はScriptLockで防ぐ。既存スプレッドシートが開けなければ新規作成へフォールバックしない。更新はGFM_updateInstalledCodeという独立した明示操作にする。

保存先はインストーラーのScriptProperty `GFM_DESTINATION_FOLDER_ID` で指定し、IDとGoogle DriveフォルダURLに対応する。未指定はマイドライブ直下。指定フォルダは作成前にDrive APIで検証する。新規ファイルIDを先に永続化してから親フォルダを変更し、失敗時に新規作成や別の保存先へフォールバックしない。配置の応答不明は現在の親を再取得し、既に指定先ならPATCHを繰り返さない。導入完了後は同設定を自動移動の指示にしない。

GitHubではコード、テスト、公開向け資料、CIだけを追跡する。提供されたDrive資料のコピー、ローカル作業計画、認証設定、生成先の実IDは公開しない。
