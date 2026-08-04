// api/chat.js — Gemini generateContent プロキシ（フロントに APIキーを出さないための薄い中継）
//
// ここは HTTP の入り口だけを担当し、検証・呼び出し・解析は api/_lib/ 側に置いてある。
// createHandler() で env と fetch を注入できるので、ハンドラ単位でテストできる（tests/handler.test.js）。

import { apiError, isApiError, redact, redactString, toErrorBody } from './_lib/errors.js';
import { CLIENT_DEFAULTS, createGeminiClient, normalizeChatRequest, parseGeminiResponse } from './_lib/gemini.js';
import { MAX_BODY_BYTES, createLogger, readJsonBody, resolveRequestId, sendJson, verifyEventPass } from './_lib/http.js';

// フロント側は30秒でタイムアウトするので、関数側はその内側で完結させる。
export const config = { maxDuration: 30 };

function intFromEnv(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function createHandler(deps = {}) {
  const {
    env = process.env,
    fetchImpl,
    sleep,
    random,
    now = Date.now,
    logger = createLogger(),
    maxBodyBytes = MAX_BODY_BYTES,
  } = deps;

  return async function handler(req, res) {
    const startedAt = now();
    const requestId = resolveRequestId(req);
    const baseHeaders = { 'x-request-id': requestId, 'cache-control': 'no-store' };
    let apiKey = '';
    let normalized = null;
    let attempts = 0;

    try {
      if (req.method === 'OPTIONS') {
        return sendJson(res, 204, null, { ...baseHeaders, allow: 'POST, OPTIONS' });
      }
      if (req.method !== 'POST') {
        throw apiError('method_not_allowed', { details: { method: req.method } });
      }

      verifyEventPass(req, env.EVENT_PASS);

      apiKey = String(env.GEMINI_API_KEY ?? '').trim();
      if (!apiKey) throw apiError('missing_api_key');

      const body = await readJsonBody(req, { maxBytes: maxBodyBytes });
      normalized = normalizeChatRequest(body);

      const client = createGeminiClient({
        apiKey,
        fetchImpl,
        sleep,
        random,
        now,
        attemptTimeoutMs: intFromEnv(env, 'GEMINI_ATTEMPT_TIMEOUT_MS', CLIENT_DEFAULTS.attemptTimeoutMs),
        totalTimeoutMs: intFromEnv(env, 'GEMINI_TOTAL_TIMEOUT_MS', CLIENT_DEFAULTS.totalTimeoutMs),
        maxRetries: intFromEnv(env, 'GEMINI_MAX_RETRIES', CLIENT_DEFAULTS.maxRetries),
        onAttempt: (info) => {
          attempts = info.attempt + 1;
          if (!info.ok) {
            logger('warn', {
              event: 'gemini_attempt_failed',
              requestId,
              model: normalized?.model,
              attempt: info.attempt,
              code: info.code,
              retryable: info.retryable,
              durationMs: info.durationMs,
            });
          }
        },
      });

      const { data, elapsedMs } = await client.generate(normalized);
      const parsed = parseGeminiResponse(data);

      logger('info', {
        event: 'gemini_ok',
        requestId,
        model: normalized.model,
        attempts,
        upstreamMs: elapsedMs,
        durationMs: now() - startedAt,
        promptChars: normalized.promptChars,
        messageCount: normalized.messageCount,
        finishReason: parsed.finishReason,
        truncated: parsed.truncated,
        usage: parsed.usage,
      });

      return sendJson(
        res,
        200,
        {
          // 既存フロント互換のブロック形式
          content: [{ type: 'text', text: parsed.text }],
          meta: {
            requestId,
            model: normalized.model,
            modelVersion: parsed.modelVersion,
            finishReason: parsed.finishReason,
            truncated: parsed.truncated,
            attempts,
            durationMs: now() - startedAt,
            usage: parsed.usage,
            warnings: normalized.warnings,
          },
        },
        baseHeaders,
      );
    } catch (error) {
      const err = isApiError(error)
        ? error
        : apiError('internal_error', {
            details: { internalMessage: redactString(error?.message ?? String(error), [apiKey]).slice(0, 300) },
            cause: error,
          });

      const headers = { ...baseHeaders };
      if (Number.isFinite(err.retryAfterMs)) {
        headers['retry-after'] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
      }
      if (err.code === 'method_not_allowed') headers.allow = 'POST, OPTIONS';

      logger(err.status >= 500 ? 'error' : 'warn', {
        event: 'gemini_failed',
        requestId,
        code: err.code,
        status: err.status,
        retryable: err.retryable,
        attempts,
        model: normalized?.model,
        promptChars: normalized?.promptChars,
        durationMs: now() - startedAt,
        // 上流メッセージには鍵が混ざりうる。ログでも必ずマスクを通す。
        details: redact(err.details, [apiKey]),
        // スタックは原因調査用。鍵が混ざる可能性を考えて必ずマスクを通す。
        stack: err.status >= 500 ? redactString(error?.stack ?? '', [apiKey]).slice(0, 1200) : undefined,
      });

      return sendJson(res, err.status, toErrorBody(err, { requestId, secrets: [apiKey] }), headers);
    }
  };
}

export default createHandler();
