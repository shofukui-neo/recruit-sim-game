# /api/chat — Gemini プロキシ

ブラウザに APIキーを出さないための中継。`index.html` から `POST /api/chat` で呼ばれる。

```
api/
  chat.js          HTTP の入口（検証 → 呼び出し → 応答整形）
  _lib/errors.js   エラーコードのカタログ・ApiError・秘匿値マスク
  _lib/gemini.js   リクエスト検証 / ペイロード生成 / 再試行クライアント / 応答解析
  _lib/http.js     ボディ読取・JSON応答・requestId・合言葉検証
```

`_lib/` は Vercel のルーティング対象外（先頭 `_`）なので、関数としては公開されない。

## リクエスト

```json
{
  "model": "gemini-2.5-flash",
  "messages": [{ "role": "user", "content": "..." }],
  "max_tokens": 800,
  "temperature": 0.4,
  "json": true,
  "response_schema": { "type": "object" },
  "thinking_budget": 0
}
```

`messages` 以外は任意。`gemini` で始まらないモデル名は既定モデルへ矯正し、`meta.warnings` で通知する。

## 応答

成功（200）:

```json
{
  "content": [{ "type": "text", "text": "..." }],
  "meta": { "requestId": "...", "model": "...", "finishReason": "STOP",
            "truncated": false, "attempts": 1, "usage": {}, "warnings": [] }
}
```

失敗:

```json
{ "error": "rate_limited", "message": "アクセスが集中しています。…",
  "retryable": true, "retryAfterMs": 3000, "requestId": "...", "details": {} }
```

`retryable` はクライアントの自動再試行の判断に使う。`false` のときはフロントも即座に諦めてエラー表示に切り替える。

## エラーコード一覧

| コード | HTTP | 再試行 | 主な原因 |
| --- | --- | --- | --- |
| `method_not_allowed` | 405 | × | POST 以外 |
| `invalid_json` | 400 | × | ボディが JSON でない |
| `invalid_request` | 400 | × | 項目の型・範囲違反（`details.field` に該当項目） |
| `payload_too_large` | 413 | × | ボディ 256KB 超 / プロンプト 10万文字超 |
| `unauthorized` | 401 | × | `EVENT_PASS` 設定時に合言葉不一致 |
| `missing_api_key` | 500 | × | `GEMINI_API_KEY` 未設定 |
| `invalid_api_key` | 500 | × | キーが無効（上流 400/401） |
| `permission_denied` | 500 | × | API 未有効化・権限不足（上流 403） |
| `model_not_found` | 400 | × | 存在しないモデル（上流 404） |
| `upstream_invalid_request` | 400 | × | 上流がリクエストを拒否 |
| `rate_limited` | 429 | ○ | 短時間のレート超過 |
| `quota_exceeded` | 429 | × | 日次上限・課金起因 |
| `upstream_unavailable` | 503 | ○ | 上流混雑（overloaded） |
| `upstream_error` | 502 | ○ | 上流 5xx |
| `upstream_timeout` | 504 | ○ | 上流応答なし |
| `network_error` | 502 | ○ | 上流へ接続不可 |
| `invalid_upstream_response` | 502 | ○ | 上流応答が JSON でない |
| `empty_response` | 502 | ○ | 候補なし・本文0文字 |
| `response_truncated` | 502 | × | `MAX_TOKENS` で本文0文字（`max_tokens` を増やす） |
| `content_blocked` | 422 | × | 安全性フィルタ |
| `internal_error` | 500 | × | 想定外の例外 |

## 再試行

サーバー側は `retryable` なエラーのみ、指数バックオフ（400ms → 800ms、±50%ジッター）で最大2回再試行する。
`Retry-After` ヘッダ / `RetryInfo` があればそれを優先する。総時間が `GEMINI_TOTAL_TIMEOUT_MS` を超える場合は再試行しない。
フロント側もさらに最大3回まで再試行するが、`retryable:false` なら即座に打ち切る。

## 環境変数

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `GEMINI_API_KEY` | （必須） | Gemini APIキー |
| `EVENT_PASS` | 未設定 | 設定すると `x-event-pass` ヘッダ必須になる |
| `GEMINI_ATTEMPT_TIMEOUT_MS` | 12000 | 1回の呼び出しの上限 |
| `GEMINI_TOTAL_TIMEOUT_MS` | 26000 | 再試行込みの上限 |
| `GEMINI_MAX_RETRIES` | 2 | 再試行回数 |

## ログ

1行 JSON で `gemini_ok` / `gemini_attempt_failed` / `gemini_failed` を出力する。
`requestId` は応答の `x-request-id` ヘッダと一致するので、利用者の画面に出ている ID からログを引ける。
**プロンプト本文は記録しない**（文字数のみ）。APIキーは応答・ログとも必ずマスクを通す。

## テスト

```bash
npm test              # 全テスト
npm run test:coverage # カバレッジ付き
```

`tests/` は `.vercelignore` に入れてあるのでデプロイには含まれない。
