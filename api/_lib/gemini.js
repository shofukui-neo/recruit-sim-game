// api/_lib/gemini.js — Gemini API 呼び出しのコア（純粋関数 + 依存注入クライアント）
//
// ハンドラ（api/chat.js）から req/res を切り離してあるので、
// ここは全部 node:test からそのままユニットテストできる。

import { ApiError, apiError, invalidRequest } from './errors.js';

export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** 入力側の上限値。超えたら Gemini に投げる前に落とす（無駄な課金と待ち時間を防ぐ） */
export const LIMITS = Object.freeze({
  maxMessages: 60,
  maxPromptChars: 100_000,
  maxModelNameLength: 64,
  minOutputTokens: 1,
  maxOutputTokens: 8192,
  minTemperature: 0,
  maxTemperature: 2,
  maxThinkingBudget: 24_576,
});

/** クライアント既定値。環境変数で上書きできるよう chat.js 側から渡す。 */
export const CLIENT_DEFAULTS = Object.freeze({
  attemptTimeoutMs: 12_000, // 1回のfetchの上限
  totalTimeoutMs: 26_000, // 再試行込みの総時間（フロントの30秒より内側に置く）
  maxRetries: 2, // 初回 + 2回 = 最大3回
  baseDelayMs: 400,
  maxDelayMs: 4_000,
});

// モデル名はURLパスに埋め込むため、英数字と .-_ 以外は一切許可しない。
// （"gemini-x?key=..." のようなクエリ注入・パストラバーサルを防ぐ）
const MODEL_NAME_RE = /^[A-Za-z0-9._-]+$/;
// 思考予算を0にできないモデル（2.5 pro 系）は thinkingConfig を送らない
const NO_THINKING_DISABLE_RE = /pro/i;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * リクエストボディを検証し、Gemini 呼び出しに必要な形へ正規化する。
 * 不正な入力はここで ApiError('invalid_request' 等) として落ちる。
 */
export function normalizeChatRequest(body) {
  if (!isPlainObject(body)) {
    throw invalidRequest('body', 'は JSON オブジェクトである必要があります');
  }

  const warnings = [];

  // --- model ---
  let model = DEFAULT_MODEL;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string' || body.model.trim() === '') {
      throw invalidRequest('model', 'は空でない文字列である必要があります');
    }
    const raw = body.model.trim();
    if (raw.length > LIMITS.maxModelNameLength) {
      throw invalidRequest('model', `は${LIMITS.maxModelNameLength}文字以内である必要があります`, {
        length: raw.length,
      });
    }
    if (!MODEL_NAME_RE.test(raw)) {
      throw invalidRequest('model', 'に使用できない文字が含まれています', { allowed: 'A-Z a-z 0-9 . _ -' });
    }
    if (/^gemini/i.test(raw)) {
      model = raw;
    } else {
      // 旧版の名残で claude-* などが飛んでくることがある。落とさず既定モデルへ矯正する。
      warnings.push({ code: 'model_coerced', from: raw, to: DEFAULT_MODEL });
    }
  }

  // --- messages ---
  if (!Array.isArray(body.messages)) {
    throw invalidRequest('messages', 'は配列である必要があります');
  }
  if (body.messages.length === 0) {
    throw invalidRequest('messages', 'は1件以上必要です');
  }
  if (body.messages.length > LIMITS.maxMessages) {
    throw invalidRequest('messages', `は${LIMITS.maxMessages}件以内である必要があります`, {
      count: body.messages.length,
    });
  }

  const lines = body.messages.map((m, i) => {
    if (!isPlainObject(m)) {
      throw invalidRequest(`messages[${i}]`, 'はオブジェクトである必要があります');
    }
    if (m.role !== undefined && typeof m.role !== 'string') {
      throw invalidRequest(`messages[${i}].role`, 'は文字列である必要があります');
    }
    if (m.content === undefined || m.content === null) {
      throw invalidRequest(`messages[${i}].content`, 'は必須です');
    }
    const content = typeof m.content === 'string' ? m.content : safeStringify(m.content, i);
    if (content.trim() === '') {
      throw invalidRequest(`messages[${i}].content`, 'が空です');
    }
    return `${m.role || 'user'}: ${content}`;
  });

  const prompt = lines.join('\n\n');
  if (prompt.length > LIMITS.maxPromptChars) {
    throw apiError('payload_too_large', {
      details: { field: 'messages', promptChars: prompt.length, limit: LIMITS.maxPromptChars },
    });
  }

  // --- generationConfig ---
  const temperature = numberInRange(
    body.temperature,
    'temperature',
    LIMITS.minTemperature,
    LIMITS.maxTemperature,
    0.4,
  );
  const maxOutputTokens = integerInRange(
    body.max_tokens,
    'max_tokens',
    LIMITS.minOutputTokens,
    LIMITS.maxOutputTokens,
    1024,
  );
  const thinkingBudget = integerInRange(body.thinking_budget, 'thinking_budget', 0, LIMITS.maxThinkingBudget, 0);

  const wantJson = body.json === true || body.response_mime_type === 'application/json';
  if (body.json !== undefined && typeof body.json !== 'boolean') {
    throw invalidRequest('json', 'は真偽値である必要があります');
  }
  if (body.response_mime_type !== undefined && typeof body.response_mime_type !== 'string') {
    throw invalidRequest('response_mime_type', 'は文字列である必要があります');
  }

  let responseSchema;
  if (body.response_schema !== undefined && body.response_schema !== null) {
    if (!isPlainObject(body.response_schema)) {
      throw invalidRequest('response_schema', 'はオブジェクトである必要があります');
    }
    if (!wantJson) {
      warnings.push({ code: 'response_schema_ignored', reason: 'json:true が指定されていません' });
    } else {
      responseSchema = body.response_schema;
    }
  }

  return {
    model,
    prompt,
    wantJson,
    temperature,
    maxOutputTokens,
    thinkingBudget,
    responseSchema,
    warnings,
    messageCount: body.messages.length,
    promptChars: prompt.length,
  };
}

function safeStringify(value, index) {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== 'string') throw new Error('not serializable');
    return s;
  } catch {
    throw invalidRequest(`messages[${index}].content`, 'を文字列化できません（循環参照など）');
  }
}

function numberInRange(value, field, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidRequest(field, 'は数値である必要があります');
  }
  if (value < min || value > max) {
    throw invalidRequest(field, `は${min}〜${max}の範囲である必要があります`, { value });
  }
  return value;
}

function integerInRange(value, field, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidRequest(field, 'は整数である必要があります');
  }
  if (value < min || value > max) {
    throw invalidRequest(field, `は${min}〜${max}の範囲である必要があります`, { value });
  }
  return value;
}

/** 正規化済みリクエストから generateContent のペイロードを組み立てる */
export function buildGeminiPayload(normalized) {
  const generationConfig = {
    temperature: normalized.temperature,
    maxOutputTokens: normalized.maxOutputTokens,
  };
  // 2.5/3.x Flash は既定で思考にトークンを使い、JSON が空になることがあるため既定で無効化。
  // pro 系は 0 を受け付けないので送らない。
  if (!NO_THINKING_DISABLE_RE.test(normalized.model)) {
    generationConfig.thinkingConfig = { thinkingBudget: normalized.thinkingBudget };
  }
  if (normalized.wantJson) {
    generationConfig.responseMimeType = 'application/json';
    if (normalized.responseSchema) generationConfig.responseSchema = normalized.responseSchema;
  }

  return {
    contents: [{ role: 'user', parts: [{ text: normalized.prompt }] }],
    generationConfig,
  };
}

// ---------------------------------------------------------------------------
// 上流エラーの分類
// ---------------------------------------------------------------------------

const QUOTA_HINT_RE = /per\s*day|perday|daily|billing|quota/i;
const API_KEY_HINT_RE = /api\s*key|api_key_invalid|credential/i;

/**
 * Gemini からの非2xx応答を ApiError に変換する。
 * data は JSON パースできなかった場合 null でもよい（ステータスだけで分類する）。
 */
export function classifyUpstreamError(status, data, headers) {
  const upstream = isPlainObject(data) && isPlainObject(data.error) ? data.error : {};
  const upstreamMessage = typeof upstream.message === 'string' ? upstream.message : '';
  const upstreamStatus = typeof upstream.status === 'string' ? upstream.status : '';
  const details = {
    upstreamHttpStatus: status,
    upstreamStatus: upstreamStatus || undefined,
    upstreamMessage: upstreamMessage ? upstreamMessage.slice(0, 300) : undefined,
  };
  const retryAfterMs = parseRetryAfterMs(headers, data);

  const make = (code, extra = {}) => apiError(code, { details, retryAfterMs, ...extra });

  if (status === 400) {
    if (API_KEY_HINT_RE.test(upstreamMessage) || /API_KEY_INVALID/i.test(JSON.stringify(upstream.details ?? ''))) {
      return make('invalid_api_key');
    }
    return make('upstream_invalid_request');
  }
  if (status === 401) return make('invalid_api_key');
  if (status === 403) {
    return API_KEY_HINT_RE.test(upstreamMessage) ? make('invalid_api_key') : make('permission_denied');
  }
  if (status === 404) return make('model_not_found');
  if (status === 413) return make('payload_too_large');
  if (status === 429) {
    const quotaish = QUOTA_HINT_RE.test(upstreamMessage) || QUOTA_HINT_RE.test(JSON.stringify(upstream.details ?? ''));
    return make(quotaish ? 'quota_exceeded' : 'rate_limited');
  }
  if (status === 503) return make('upstream_unavailable');
  if (status === 504) return make('upstream_timeout');
  if (status >= 500) return make('upstream_error');
  return make('upstream_invalid_request');
}

/**
 * Retry-After ヘッダ（秒数 or HTTP-date）と Google の RetryInfo から待ち時間(ms)を得る。
 * 解釈できなければ undefined。
 */
export function parseRetryAfterMs(headers, data, nowMs = Date.now()) {
  const raw = getHeader(headers, 'retry-after');
  if (raw != null && String(raw).trim() !== '') {
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return Number(s) * 1000;
    const at = Date.parse(s);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  // { error: { details: [{ "@type": ".../RetryInfo", retryDelay: "21s" }] } }
  const list = isPlainObject(data) && isPlainObject(data.error) ? data.error.details : null;
  if (Array.isArray(list)) {
    for (const d of list) {
      if (isPlainObject(d) && typeof d.retryDelay === 'string') {
        const m = d.retryDelay.match(/^([\d.]+)s$/);
        if (m) return Math.round(Number(m[1]) * 1000);
      }
    }
  }
  return undefined;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 応答本文の解析
// ---------------------------------------------------------------------------

// 候補が打ち切られた理由のうち「安全性ブロック」に当たるもの
const BLOCK_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

/**
 * 200 応答から本文テキストを取り出す。
 * 取り出せない場合（ブロック・空・切れ）は理由別の ApiError を投げる。
 */
export function parseGeminiResponse(data) {
  if (!isPlainObject(data)) {
    throw apiError('invalid_upstream_response', { details: { reason: 'body_not_object' } });
  }

  // プロンプト自体がブロックされたケース（candidates が付かない）
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) {
    throw apiError('content_blocked', {
      message: `入力が安全性フィルタによりブロックされました（${blockReason}）。表現を変えてお試しください。`,
      details: {
        stage: 'prompt',
        blockReason,
        blockReasonMessage: data.promptFeedback?.blockReasonMessage,
        safetyRatings: data.promptFeedback?.safetyRatings,
      },
    });
  }

  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined;
  if (!candidate) {
    throw apiError('empty_response', { details: { reason: 'no_candidates' } });
  }

  const finishReason = candidate.finishReason;
  if (finishReason && BLOCK_FINISH_REASONS.has(finishReason)) {
    throw apiError('content_blocked', {
      message: `応答が安全性フィルタによりブロックされました（${finishReason}）。表現を変えてお試しください。`,
      details: { stage: 'response', finishReason, safetyRatings: candidate.safetyRatings },
    });
  }

  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .filter((p) => isPlainObject(p) && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join('');

  const truncated = finishReason === 'MAX_TOKENS';

  if (text === '') {
    if (truncated) {
      // 思考トークンだけ消費して本文0文字。同じ設定で再送しても直らないので retryable=false。
      throw apiError('response_truncated', {
        details: { finishReason, usage: data.usageMetadata },
      });
    }
    throw apiError('empty_response', {
      details: { finishReason: finishReason ?? null, usage: data.usageMetadata },
    });
  }

  return {
    text,
    finishReason: finishReason ?? null,
    truncated,
    safetyRatings: candidate.safetyRatings,
    usage: data.usageMetadata,
    modelVersion: data.modelVersion,
  };
}

// ---------------------------------------------------------------------------
// HTTP クライアント（タイムアウト + 指数バックオフ再試行）
// ---------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gemini generateContent クライアント。
 * fetch/sleep/random/now を注入できるため、テストで実時間もネットワークも使わない。
 */
export function createGeminiClient(options = {}) {
  const {
    apiKey,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
    baseUrl = DEFAULT_BASE_URL,
    attemptTimeoutMs = CLIENT_DEFAULTS.attemptTimeoutMs,
    totalTimeoutMs = CLIENT_DEFAULTS.totalTimeoutMs,
    maxRetries = CLIENT_DEFAULTS.maxRetries,
    baseDelayMs = CLIENT_DEFAULTS.baseDelayMs,
    maxDelayMs = CLIENT_DEFAULTS.maxDelayMs,
    onAttempt = () => {},
  } = options;

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw apiError('missing_api_key');
  }
  if (typeof fetchImpl !== 'function') {
    throw apiError('internal_error', { message: 'fetch 実装が利用できません。' });
  }

  /** 指数バックオフ + ジッター（±50%）。Retry-After があればそちらを優先。 */
  function backoffMs(attempt, retryAfterMs) {
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      return Math.min(retryAfterMs, maxDelayMs);
    }
    const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return Math.round(raw * (0.5 + random() * 0.5));
  }

  async function requestOnce(payload, model, signal) {
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // クエリではなくヘッダで渡す。URL（＝ログ・エラー文言に載りやすい）に鍵を残さないため。
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw apiError('upstream_timeout', { details: { attemptTimeoutMs }, cause: e });
      }
      throw apiError('network_error', { details: { reason: e?.code || e?.name || 'fetch_failed' }, cause: e });
    }

    let data = null;
    let parseFailed = false;
    try {
      data = await response.json();
    } catch (e) {
      parseFailed = true;
    }

    if (!response.ok) {
      throw classifyUpstreamError(response.status, data, response.headers);
    }
    if (parseFailed || !isPlainObject(data)) {
      throw apiError('invalid_upstream_response', {
        details: { reason: parseFailed ? 'invalid_json' : 'body_not_object' },
      });
    }
    return data;
  }

  /**
   * 生成を実行する。再試行は retryable なエラーかつ総時間内の場合のみ。
   * @returns {Promise<{data: object, attempts: number, elapsedMs: number}>}
   */
  async function generate(normalized) {
    const payload = buildGeminiPayload(normalized);
    const startedAt = now();
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      const attemptStartedAt = now();
      try {
        const data = await requestOnce(payload, normalized.model, controller.signal);
        onAttempt({ attempt, ok: true, durationMs: now() - attemptStartedAt });
        return { data, attempts: attempt + 1, elapsedMs: now() - startedAt };
      } catch (e) {
        lastError = e;
        onAttempt({
          attempt,
          ok: false,
          code: e?.code,
          retryable: e?.retryable,
          durationMs: now() - attemptStartedAt,
        });

        const canRetry = e instanceof ApiError ? e.retryable : false;
        if (!canRetry || attempt === maxRetries) break;

        const wait = backoffMs(attempt, e.retryAfterMs);
        if (now() - startedAt + wait >= totalTimeoutMs) {
          // これ以上待つと関数自体のタイムアウトに巻き込まれる。今のエラーで打ち切る。
          break;
        }
        await sleep(wait);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? apiError('internal_error');
  }

  return { generate };
}
