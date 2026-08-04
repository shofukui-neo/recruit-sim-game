// tests/handler.test.js — ハンドラ（api/chat.js）のエンドツーエンド挙動

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../api/chat.js';
import {
  VALID_BODY,
  brokenJsonResponse,
  createFakeClock,
  createFetchDouble,
  createLogSink,
  createMockReq,
  createMockRes,
  fixedRandom,
  geminiError,
  geminiOk,
  hangingFetch,
  jsonResponse,
  networkError,
} from './helpers.js';
import { createLogger } from '../api/_lib/http.js';

const API_KEY = 'AIzaSyHANDLERKEYHANDLERKEYHANDLERKEY99';

/**
 * ハンドラを1回呼んで、res とログを返す。
 * fetch は既定で「1回で成功」。
 */
async function invoke({
  req = createMockReq({ body: VALID_BODY }),
  responders = [jsonResponse(200, geminiOk('{"reply":"はい","delta":5}'))],
  env = { GEMINI_API_KEY: API_KEY },
  fetchImpl,
  ...rest
} = {}) {
  const res = createMockRes();
  const sink = createLogSink();
  const clock = createFakeClock();
  const double = fetchImpl ?? createFetchDouble(responders);
  const handler = createHandler({
    env,
    fetchImpl: double,
    sleep: clock.sleep,
    now: clock.now,
    random: fixedRandom,
    logger: createLogger(sink),
    ...rest,
  });
  await handler(req, res);
  return { res, sink, fetchImpl: double, clock };
}

// --- メソッド / 事前チェック ----------------------------------------------

test('OPTIONS は 204 と Allow ヘッダを返す', async () => {
  const { res } = await invoke({ req: createMockReq({ method: 'OPTIONS' }), responders: [] });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, undefined);
  assert.equal(res.headers.allow, 'POST, OPTIONS');
  assert.ok(res.headers['x-request-id']);
});

test('GET は 405 と Allow ヘッダ', async () => {
  const { res } = await invoke({ req: createMockReq({ method: 'GET' }), responders: [] });
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, 'method_not_allowed');
  assert.equal(res.body.retryable, false);
  assert.equal(res.headers.allow, 'POST, OPTIONS');
  assert.equal(res.body.details.method, 'GET');
});

test('GEMINI_API_KEY 未設定は 500 missing_api_key', async () => {
  const { res } = await invoke({ env: {}, responders: [] });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'missing_api_key');
  assert.equal(res.body.retryable, false);
  assert.match(res.body.message, /GEMINI_API_KEY/);
});

test('GEMINI_API_KEY が空白のみでも missing_api_key', async () => {
  const { res } = await invoke({ env: { GEMINI_API_KEY: '   ' }, responders: [] });
  assert.equal(res.body.error, 'missing_api_key');
});

test('EVENT_PASS 未設定なら合言葉は不要', async () => {
  const { res } = await invoke({ env: { GEMINI_API_KEY: API_KEY } });
  assert.equal(res.statusCode, 200);
});

test('EVENT_PASS 設定時は合言葉が一致しないと 401', async () => {
  const env = { GEMINI_API_KEY: API_KEY, EVENT_PASS: 'mochica0722' };
  for (const headers of [{}, { 'x-event-pass': 'wrong' }, { 'x-event-pass': 'mochica072' }]) {
    const { res } = await invoke({ req: createMockReq({ headers, body: VALID_BODY }), env, responders: [] });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
  }
});

test('EVENT_PASS が一致すれば通過する', async () => {
  const { res } = await invoke({
    req: createMockReq({ headers: { 'x-event-pass': 'mochica0722' }, body: VALID_BODY }),
    env: { GEMINI_API_KEY: API_KEY, EVENT_PASS: 'mochica0722' },
  });
  assert.equal(res.statusCode, 200);
});

// --- 正常系 ---------------------------------------------------------------

test('成功時: 既存フロント互換の content 形式 + meta を返す', async () => {
  const { res, fetchImpl } = await invoke();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.content, [{ type: 'text', text: '{"reply":"はい","delta":5}' }]);
  assert.equal(res.body.meta.model, 'gemini-2.5-flash');
  assert.equal(res.body.meta.finishReason, 'STOP');
  assert.equal(res.body.meta.truncated, false);
  assert.equal(res.body.meta.attempts, 1);
  assert.equal(res.body.meta.usage.totalTokenCount, 165);
  assert.equal(res.body.meta.requestId, res.headers['x-request-id']);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(fetchImpl.calls.length, 1);
});

test('x-request-id は引き継ぎ、無ければ生成する', async () => {
  const withId = await invoke({
    req: createMockReq({ headers: { 'x-request-id': 'event-turn-0001' }, body: VALID_BODY }),
  });
  assert.equal(withId.res.headers['x-request-id'], 'event-turn-0001');

  const generated = await invoke();
  assert.match(generated.res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
});

test('文字列ボディ / Buffer ボディでも解釈できる', async () => {
  for (const body of [JSON.stringify(VALID_BODY), Buffer.from(JSON.stringify(VALID_BODY))]) {
    const { res } = await invoke({ req: createMockReq({ body }) });
    assert.equal(res.statusCode, 200);
  }
});

test('モデル矯正の警告が meta に載る', async () => {
  const { res } = await invoke({
    req: createMockReq({ body: { ...VALID_BODY, model: 'claude-sonnet-5' } }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.meta.warnings, [
    { code: 'model_coerced', from: 'claude-sonnet-5', to: 'gemini-2.5-flash' },
  ]);
});

test('MAX_TOKENS で本文ありなら 200 + truncated:true', async () => {
  const truncated = { candidates: [{ content: { parts: [{ text: '{"reply":"途中' }] }, finishReason: 'MAX_TOKENS' }] };
  const { res } = await invoke({ responders: [jsonResponse(200, truncated)] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.meta.truncated, true);
});

// --- 入力エラー -----------------------------------------------------------

test('壊れた JSON ボディは 400 invalid_json', async () => {
  const { res } = await invoke({ req: createMockReq({ body: '{"messages":[' }), responders: [] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_json');
  assert.equal(res.body.retryable, false);
});

test('検証エラーは 400 invalid_request（どの項目かを返す）', async () => {
  const { res } = await invoke({ req: createMockReq({ body: { messages: [] } }), responders: [] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_request');
  assert.equal(res.body.details.field, 'messages');
});

test('content-length が上限を超えたら 413（本文を読まずに落とす）', async () => {
  const { res, fetchImpl } = await invoke({
    req: createMockReq({ headers: { 'content-length': '999999' }, body: VALID_BODY }),
    responders: [],
  });
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, 'payload_too_large');
  assert.equal(fetchImpl.calls.length, 0, 'Gemini を呼ばない');
});

// --- 上流エラー -----------------------------------------------------------

test('429 は 429 で返し、Retry-After ヘッダと retryAfterMs を付ける', async () => {
  const rateLimited = jsonResponse(429, geminiError(429, 'RESOURCE_EXHAUSTED', 'rate limit'), { 'retry-after': '3' });
  const { res, fetchImpl } = await invoke({ responders: [rateLimited, rateLimited, rateLimited] });

  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'rate_limited');
  assert.equal(res.body.retryable, true);
  assert.equal(res.body.retryAfterMs, 3000);
  assert.equal(res.headers['retry-after'], '3');
  assert.equal(fetchImpl.calls.length, 3, '再試行してから諦める');
});

test('503 で再試行して成功すればクライアントには 200 だけが見える', async () => {
  const { res } = await invoke({
    responders: [jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'overloaded')), jsonResponse(200, geminiOk('ok'))],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.meta.attempts, 2);
});

test('APIキー不正は 500 invalid_api_key（再試行しない）', async () => {
  const { res, fetchImpl } = await invoke({
    responders: [jsonResponse(400, geminiError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'))],
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'invalid_api_key');
  assert.equal(res.body.retryable, false);
  assert.equal(fetchImpl.calls.length, 1);
});

test('安全性ブロックは 422 content_blocked', async () => {
  const blocked = { promptFeedback: { blockReason: 'SAFETY', safetyRatings: [] } };
  const { res } = await invoke({ responders: [jsonResponse(200, blocked)] });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, 'content_blocked');
  assert.equal(res.body.retryable, false);
});

test('空応答は 502 empty_response（再試行可として返す）', async () => {
  const empty = jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] });
  const { res } = await invoke({ responders: [empty] });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'empty_response');
  assert.equal(res.body.retryable, true);
});

test('ネットワーク断は 502 network_error', async () => {
  const boom = () => {
    throw networkError('ECONNREFUSED');
  };
  const { res } = await invoke({ responders: [boom, boom, boom] });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'network_error');
  assert.equal(res.body.retryable, true);
});

test('上流無応答は 504 upstream_timeout', async () => {
  const { res } = await invoke({
    fetchImpl: hangingFetch(),
    env: { GEMINI_API_KEY: API_KEY, GEMINI_ATTEMPT_TIMEOUT_MS: '20', GEMINI_MAX_RETRIES: '0' },
  });
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.error, 'upstream_timeout');
  assert.equal(res.body.retryable, true);
});

test('JSON でない上流応答は 502 invalid_upstream_response', async () => {
  const { res } = await invoke({ responders: [brokenJsonResponse(200), brokenJsonResponse(200), brokenJsonResponse(200)] });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'invalid_upstream_response');
});

test('ApiError でない例外は 500 internal_error に包み、内容をマスクする', async () => {
  const hostileBody = {
    get messages() {
      throw new TypeError(`unexpected failure with key ${API_KEY}`);
    },
  };
  const { res, sink } = await invoke({ req: createMockReq({ body: hostileBody }), responders: [] });

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'internal_error');
  assert.equal(res.body.retryable, false);
  assert.match(res.body.details.internalMessage, /REDACTED/);
  assert.equal(JSON.stringify(res.body).includes(API_KEY), false);
  assert.equal(sink.text().includes(API_KEY), false);
  assert.equal(sink.find('gemini_failed').level, 'error');
});

test('想定外の例外は 500 internal_error に包む（詳細は漏らさない）', async () => {
  const { res } = await invoke({
    fetchImpl: () => {
      // ApiError ではない想定外の失敗
      throw new TypeError(`boom with ${API_KEY}`);
    },
    env: { GEMINI_API_KEY: API_KEY, GEMINI_MAX_RETRIES: '0' },
  });
  assert.equal(res.statusCode, 502, 'fetch の失敗は network_error として扱われる');
  assert.equal(JSON.stringify(res.body).includes(API_KEY), false);
});

test('環境変数で再試行回数とタイムアウトを調整できる', async () => {
  const fail = jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'x'));
  const { res, fetchImpl } = await invoke({
    responders: [fail, fail, fail, fail, fail, fail],
    env: { GEMINI_API_KEY: API_KEY, GEMINI_MAX_RETRIES: '5', GEMINI_TOTAL_TIMEOUT_MS: '600000' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(fetchImpl.calls.length, 6);
});

// --- 秘匿値・ログ ---------------------------------------------------------

test('どのエラー応答にも APIキーが含まれない', async () => {
  const cases = [
    [jsonResponse(400, geminiError(400, 'INVALID_ARGUMENT', `API key not valid: ${API_KEY}`))],
    [jsonResponse(500, geminiError(500, 'INTERNAL', `internal failure key=${API_KEY}`))],
  ];
  for (const responders of cases) {
    const { res, sink } = await invoke({
      responders: [...responders, ...responders, ...responders],
      env: { GEMINI_API_KEY: API_KEY, GEMINI_MAX_RETRIES: '0' },
    });
    assert.equal(JSON.stringify(res.body).includes(API_KEY), false, '応答に鍵が出ない');
    assert.equal(sink.text().includes(API_KEY), false, 'ログにも鍵が出ない');
  }
});

test('ログは構造化され、プロンプト本文を含まない', async () => {
  const secret = '社外秘のプロンプト本文';
  const { sink } = await invoke({
    req: createMockReq({ body: { ...VALID_BODY, messages: [{ role: 'user', content: secret }] } }),
  });

  const ok = sink.find('gemini_ok');
  assert.ok(ok, 'gemini_ok ログが出ている');
  assert.equal(ok.level, 'info');
  assert.equal(ok.model, 'gemini-2.5-flash');
  assert.equal(ok.attempts, 1);
  assert.equal(ok.messageCount, 1);
  assert.equal(ok.promptChars, `user: ${secret}`.length);
  assert.ok(ok.requestId);
  assert.equal(sink.text().includes(secret), false, 'プロンプト本文はログに出さない');
});

test('失敗時は試行ごとの警告ログと失敗ログが残る', async () => {
  const { sink } = await invoke({
    responders: [jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'x')), jsonResponse(200, geminiOk('ok'))],
  });
  const attemptLog = sink.find('gemini_attempt_failed');
  assert.ok(attemptLog);
  assert.equal(attemptLog.level, 'warn');
  assert.equal(attemptLog.code, 'upstream_unavailable');
  assert.equal(attemptLog.attempt, 0);
  assert.equal(attemptLog.retryable, true);
});

test('5xx のときはスタックも記録し、4xx では記録しない', async () => {
  const server = await invoke({
    responders: [jsonResponse(200, { candidates: [] })],
    env: { GEMINI_API_KEY: API_KEY, GEMINI_MAX_RETRIES: '0' },
  });
  const serverLog = server.sink.find('gemini_failed');
  assert.equal(serverLog.level, 'error');
  assert.ok(serverLog.stack, '500系はスタックを残す');

  const client = await invoke({ req: createMockReq({ body: { messages: [] } }), responders: [] });
  const clientLog = client.sink.find('gemini_failed');
  assert.equal(clientLog.level, 'warn');
  assert.equal(clientLog.stack, undefined, '400系はスタック不要');
});
