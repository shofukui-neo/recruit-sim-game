// api/_lib/errors.js — Gemini プロキシのエラー分類・表現・秘匿値マスク
//
// 方針:
//  1. すべての失敗はコード（機械可読）+ 日本語メッセージ（人間可読）+ retryable に落とす
//  2. HTTP ステータスはコードから一意に決まる（呼び出し側で散らかさない）
//  3. APIキーなどの秘匿値は「返す前・記録する前」に必ず redact() を通す

/**
 * エラーコードのカタログ。
 * status: クライアントへ返す HTTP ステータス
 * retryable: 同じリクエストを再送する価値があるか（クライアントの自動再試行判断に使う）
 * message: 利用者にそのまま見せてよい日本語メッセージ
 */
export const ERROR_CATALOG = Object.freeze({
  // --- リクエスト側の問題（クライアント起因・再試行しても無駄） ---
  method_not_allowed: {
    status: 405,
    retryable: false,
    message: 'このエンドポイントは POST のみ対応しています。',
  },
  invalid_json: {
    status: 400,
    retryable: false,
    message: 'リクエストボディを JSON として解釈できませんでした。',
  },
  invalid_request: {
    status: 400,
    retryable: false,
    message: 'リクエストの内容が不正です。',
  },
  payload_too_large: {
    status: 413,
    retryable: false,
    message: 'リクエストが大きすぎます。会話履歴やプロンプトを短くしてください。',
  },
  unauthorized: {
    status: 401,
    retryable: false,
    message: '合言葉が正しくありません。',
  },

  // --- サーバー設定の問題（運営が直すまで再試行しても無駄） ---
  missing_api_key: {
    status: 500,
    retryable: false,
    message: 'サーバーに GEMINI_API_KEY が設定されていません。',
  },
  invalid_api_key: {
    status: 500,
    retryable: false,
    message: 'Gemini APIキーが無効です。環境変数の設定を確認してください。',
  },
  permission_denied: {
    status: 500,
    retryable: false,
    message: 'Gemini API へのアクセスが拒否されました。APIキーの権限・API有効化の設定を確認してください。',
  },
  model_not_found: {
    status: 400,
    retryable: false,
    message: '指定されたモデルは利用できません。モデル名を確認してください。',
  },
  upstream_invalid_request: {
    status: 400,
    retryable: false,
    message: 'Gemini API がリクエストを受け付けませんでした。',
  },

  // --- 一時的な障害（再試行する価値あり） ---
  rate_limited: {
    status: 429,
    retryable: true,
    message: 'アクセスが集中しています。少し待ってからもう一度お試しください。',
  },
  quota_exceeded: {
    status: 429,
    retryable: false,
    message: 'Gemini API の利用上限に達しました。時間をおくか、プラン・課金設定を確認してください。',
  },
  upstream_unavailable: {
    status: 503,
    retryable: true,
    message: 'Gemini API が混雑しています。少し待ってからもう一度お試しください。',
  },
  upstream_error: {
    status: 502,
    retryable: true,
    message: 'Gemini API でエラーが発生しました。もう一度お試しください。',
  },
  upstream_timeout: {
    status: 504,
    retryable: true,
    message: 'Gemini API の応答がタイムアウトしました。もう一度お試しください。',
  },
  network_error: {
    status: 502,
    retryable: true,
    message: 'Gemini API に接続できませんでした。もう一度お試しください。',
  },
  invalid_upstream_response: {
    status: 502,
    retryable: true,
    message: 'Gemini API から想定外の応答が返りました。もう一度お試しください。',
  },
  empty_response: {
    status: 502,
    retryable: true,
    message: 'Gemini API が空の応答を返しました。もう一度お試しください。',
  },

  // --- 応答内容の問題 ---
  content_blocked: {
    status: 422,
    retryable: false,
    message: '安全性フィルタにより応答がブロックされました。表現を変えてお試しください。',
  },
  response_truncated: {
    status: 502,
    retryable: false,
    message: '出力トークン上限に達し、応答が途中で切れました。max_tokens を増やすか入力を短くしてください。',
  },

  // --- その他 ---
  internal_error: {
    status: 500,
    retryable: false,
    message: 'サーバー内部でエラーが発生しました。',
  },
});

/** カタログに存在するコードか */
export function isKnownErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code);
}

/**
 * プロキシ内で投げる唯一のエラー型。
 * 未知のコードが渡された場合は internal_error に丸める（想定外のコードを外に漏らさない）。
 */
export class ApiError extends Error {
  constructor(code, options = {}) {
    const resolved = isKnownErrorCode(code) ? code : 'internal_error';
    const spec = ERROR_CATALOG[resolved];
    super(options.message || spec.message);
    this.name = 'ApiError';
    this.code = resolved;
    this.status = Number.isInteger(options.status) ? options.status : spec.status;
    this.retryable = typeof options.retryable === 'boolean' ? options.retryable : spec.retryable;
    this.details = options.details;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : undefined;
    if (options.cause !== undefined) this.cause = options.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }
}

/** ApiError かどうか（別realm由来でも判定できるよう name も見る） */
export function isApiError(value) {
  return value instanceof ApiError || (!!value && value.name === 'ApiError' && isKnownErrorCode(value.code));
}

/** new ApiError() の短縮形 */
export function apiError(code, options) {
  return new ApiError(code, options);
}

/** 入力値の検証失敗を投げる。details.field で「どこが悪いか」を必ず示す。 */
export function invalidRequest(field, reason, extra = {}) {
  return new ApiError('invalid_request', {
    message: `リクエストが不正です: ${field} ${reason}`,
    details: { field, reason, ...extra },
  });
}

// Google の APIキーは "AIza" + 35文字。誤って露出したときの保険として形状でも消す。
const GOOGLE_KEY_RE = /AIza[0-9A-Za-z_-]{10,}/g;
// URL クエリの key=xxxx / api_key=xxxx
const KEY_PARAM_RE = /([?&](?:key|api_?key)=)[^&\s"']+/gi;
// Authorization: Bearer xxxxx
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._-]{8,}/g;

const MASK = '***REDACTED***';

/** 文字列から秘匿値を除去する */
export function redactString(input, secrets = []) {
  let out = String(input);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      out = out.split(secret).join(MASK);
    }
  }
  return out
    .replace(GOOGLE_KEY_RE, MASK)
    .replace(KEY_PARAM_RE, `$1${MASK}`)
    .replace(BEARER_RE, `$1${MASK}`);
}

/**
 * 文字列・配列・オブジェクトを再帰的に走査して秘匿値を除去する。
 * ログ出力とエラー応答の両方で使う（深さ・要素数は暴走防止のため制限）。
 */
export function redact(value, secrets = [], depth = 0) {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, secrets, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 40)) {
    out[k] = redact(v, secrets, depth + 1);
  }
  return out;
}

/**
 * クライアントへ返す JSON ボディを組み立てる。
 * 既存フロントとの互換のため error/message のキー名は維持する。
 */
export function toErrorBody(error, { requestId, secrets = [] } = {}) {
  const err = isApiError(error)
    ? error
    : new ApiError('internal_error', {
        details: { internalMessage: redactString(error?.message ?? String(error), secrets).slice(0, 300) },
        cause: error,
      });

  const body = {
    error: err.code,
    message: err.message,
    retryable: err.retryable,
  };
  if (requestId) body.requestId = requestId;
  if (Number.isFinite(err.retryAfterMs)) body.retryAfterMs = err.retryAfterMs;
  if (err.details !== undefined) body.details = redact(err.details, secrets);
  return body;
}
