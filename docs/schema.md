# シートスキーマ

1行目のヘッダーと列順は固定です。ヘッダーの追加・削除・並替えは検出して停止します。Filtersのデータ行は、全列を含めて並替えてください。一部の列だけを並替えると定義自体が変わります。行の関連付けはRuleKeyで行います。表示形式はプレーンテキストで、文字列の書き込みにはRichTextValue、システム列にはRAW入力を使い、先頭の `=` やアポストロフィを式に変換しません。ユーザーが直接入力した数式は読み取り時に検出して停止します。

各データ行にはキーGFMとUUIDを22文字に圧縮した値のDOCUMENT可視メタデータを付与します。システム列更新はメタデータIDを指定したSheets APIの1リクエストで実行し、対象外のセルはnullで変更しません。RuleKeyとの対応・更新行数・読み返しを検証します。メタデータを含む行が消えた場合は更新を止めます。[Googleの行メタデータ仕様](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.developerMetadata)、[値の部分更新](https://developers.google.com/workspace/sheets/api/samples/writing)

## Filters

| 列 | 入力と意味 |
| --- | --- |
| RuleKey | システムUUID。新規行はDry Run時に採番。手動変更不可 |
| Status | 有効 / 無効 / 削除予定 |
| NameOrNote | 任意のメモ。APIには送らない |
| From / To / Subject | 送信者・宛先・件名。一致条件はAND |
| Query / NegatedQuery | Gmail検索構文を空白も含めて保持 |
| HasAttachment / ExcludeChats | 空欄（キーなし）、TRUE、FALSEの3値 |
| SizeBytes | 空欄または0〜2147483647の整数 |
| SizeComparison | SizeBytesと対で指定。larger / smaller / unspecified |
| UserLabel | ユーザーラベルの名前。現存する名前をIDに解決。1個まで |
| Archive | INBOXを除外 |
| MarkRead | UNREADを除外 |
| NeverSpam | SPAMを除外 |
| MarkImportant / NeverImportant | IMPORTANTを追加 / 除外。相互排他 |
| Star | STARREDを追加 |
| MoveToTrash | TRASHを追加。危険操作として警告 |
| ForwardTo | accepted状態の転送先アドレス。危険操作として警告 |
| AdditionalAddLabelIds / AdditionalRemoveLabelIds | その他のラベルIDをJSON文字列配列で保持。例: ["CATEGORY_SOCIAL"]。専用列のあるラベルは専用列で変更 |
| GmailFilterId | システム列。可変のGmailサーバーID |
| SyncedAt / SyncedHash / Result | システム列。同期情報・SHA-256・処理結果 |
| OriginalJson | 隠し列。元のcriteria/action。大きいJSONはBackupのBLOBへの参照 |
| OriginalRowJson | 隠し列。元の編集列。未編集判定用。大きいJSONはBLOB参照 |

Archive以下のフラグは空欄をFALSEとして扱います。TRUE/FALSEは文字列でも実際の真偽値でも読み取れます。HasAttachment/ExcludeChatsは空欄とFALSEが異なります。SizeBytesの0も欠落させません。文字列の前後空白は自動除去しません。

有効かつIDが現存しない場合は同等定義を探し、一意ならNOOPとして承認後にIDを紐付けます。候補が複数なら停止します。Filters内に未紐付けの同等定義が複数ある場合も停止し、二重作成を防ぎます。既存IDのある重複は取り込んで保持し、警告します。

無効・削除予定の行は内容を保持したままGmail設定だけを削除します。無効行の定義は再作成に使用しないため、ラベル名などの再作成向け検証は有効に戻した時点で行います。行削除はGmail削除指示になりません。

## 原本マージと正規化

- 取り込み時のcriteria/actionを丸ごと保持し、入力値がOriginalRowJsonと異なる列だけを原本に上書きする。
- 編集列で値を空欄にした場合は対応する既知キーを削除する。FALSEと0は空欄扱いしない。
- ラベル設定列の編集時は、標準ラベル・UserLabel・補助配列から配列を再構成する。その他の未知アクションキーは保持する。
- 未編集の既知キー（空文字・空配列を含む）と未知キーは保持する。
- 未知キーを持つ定義が一致していればNOOP。再作成が必要ならERRORにして、APIへ未知キーを送らない。
- 比較用JSONはオブジェクトのキーを辞書順、ラベルID配列を重複除去して辞書順にする。他の配列や文字列、欠落/false/0は変更しない。
- IDは比較ハッシュから除外する。IDのあるGmail一覧、ラベルのID/名前/種類、転送先もプレビューハッシュに含める。
- SHA-256は破損・陳腐化検出用。シート所有者がコードやDocumentPropertiesを改ざんする攻撃への署名機構ではない。

## Diff

`RunId / RuleKey / Operation / Before / After / Warnings / Risk / ValidationError`。

OperationはCREATE、REPLACE、DELETE、NOOP、ERROR、REMOTE_ONLY。Diffのセルを編集しても実行計画には使いません。ApplyはFiltersとGmailから再計算します。NOOPは標準のフィルター機能で非表示にできます。長いBefore/Afterは表示だけ省略し、原本はBackupに保持します。

## History

`RunId / TimestampTokyo / Actor / Command / RuleKey / BeforeId / AfterId / Result / Error / SnapshotId / Verification / Risk`。

追記専用。表示時刻はAsia/Tokyo（JST）。IMPORT、PREVIEW、APPLY、VERIFY、RECOVERを記録します。変更なしの行は毎行の再取得・書き込みを省略し、実行集計とVERIFY結果を記録します。Gmail設定の定義を含むシートは機密として扱ってください。

## Backup

`SnapshotId / CapturedAt / Kind / GmailFilterId / Part / Parts / Json / Hash`。

| Kind | 内容 |
| --- | --- |
| FILTER | idを含む1フィルターの原本JSON。40000文字単位に分割 |
| CONTEXT | ラベルID/名前/種類、転送先一覧。分割可 |
| MANIFEST | 全件数、全ID、正規化したスナップショットのSHA-256 |
| COMPLETE | 全件読み返しに成功した完了マーカー。最後に追加 |
| BLOB | 大きなOriginalJson/OriginalRowJsonの分割原本。SnapshotIdはblob-接頭辞 |

分割レコードには同一のHash、1始まりのPart、総数Partsを記録します。全パートとハッシュを照合して結合します。空メールボックスでもCONTEXT・MANIFEST・COMPLETEを保存します。過去スナップショットは上書きしません。COMPLETEがないものは復旧元に使いません。Backupが10万行を超えたら容量警告を表示します。

DocumentPropertiesのGFM:preview、GFM:prepared、GFM:pending、GFM:cleanup、GFM:importCompleteは別の永続管理状態です。キャッシュは使いません。API前にジャーナルを読み返し確認して保存し、応答後に段階を更新します。通常の操作で手動削除しないでください。
