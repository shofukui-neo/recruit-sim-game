// tests/response.test.js — 上流エラーの分類 / Retry-After 解釈 / 応答本文の解析

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyUpstreamError, parseGeminiResponse, parseRetryAfterMs } from '../api/_lib/gemini.js';
import { expectThrow, geminiError, geminiOk } from './helpers.js';

// --- classifyUpstreamError -------------------------------------------------

test('400 INVALID_ARGUMENT は upstream_invalid_request（再試行しない）', () => {
  const err = classifyUpstreamError(400, geminiError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload'));
  assert.equal(err.code, 'upstream_invalid_request');
  assert.equal(err.status, 400);
  assert.equal(err.retryable, false);
  assert.equal(err.details.upstreamHttpStatus, 400);
  assert.equal(err.details.upstreamStatus, 'INVALID_ARGUMENT');
  assert.match(err.details.upstreamMessage, /Invalid JSON payload/);
});

test('400 でも APIキー不正のメッセージなら invalid_api_key', () => {
  const err = classifyUpstreamError(400, geminiError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'));
  assert.equal(err.code, 'invalid_api_key');
  assert.equal(err.retryable, false);
});

test('400 の details に API_KEY_INVALID があれば invalid_api_key', () => {
  const data = geminiError(400, 'INVALID_ARGUMENT', 'Request had invalid authentication credentials', [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
  ]);
  assert.equal(classifyUpstreamError(400, data).code, 'invalid_api_key');
});

test('401 / 403 の切り分け', () => {
  assert.equal(classifyUpstreamError(401, geminiError(401, 'UNAUTHENTICATED', 'no creds')).code, 'invalid_api_key');
  assert.equal(classifyUpstreamError(403, geminiError(403, 'PERMISSION_DENIED', 'not enabled')).code, 'permission_denied');
  assert.equal(
    classifyUpstreamError(403, geminiError(403, 'PERMISSION_DENIED', 'API key does not have permission')).code,
    'invalid_api_key',
  );
});

test('404 は model_not_found', () => {
  const err = classifyUpstreamError(404, geminiError(404, 'NOT_FOUND', 'models/gemini-9 is not found'));
  assert.equal(err.code, 'model_not_found');
  assert.equal(err.status, 400, 'クライアントには「指定が悪い」として返す');
});

test('429 は既定で rate_limited（再試行可）', () => {
  const err = classifyUpstreamError(429, geminiError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted'));
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryable, true);
  assert.equal(err.status, 429);
});

test('429 でも日次上限・課金起因なら quota_exceeded（再試行しない）', () => {
  const perDay = classifyUpstreamError(
    429,
    geminiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric GenerateRequestsPerDayPerProject'),
  );
  assert.equal(perDay.code, 'quota_exceeded');
  assert.equal(perDay.retryable, false);

  const billing = classifyUpstreamError(429, geminiError(429, 'RESOURCE_EXHAUSTED', 'enable billing to continue'));
  assert.equal(billing.code, 'quota_exceeded');
});

test('5xx の分類', () => {
  assert.equal(classifyUpstreamError(500, geminiError(500, 'INTERNAL', 'internal')).code, 'upstream_error');
  assert.equal(classifyUpstreamError(503, geminiError(503, 'UNAVAILABLE', 'model is overloaded')).code, 'upstream_unavailable');
  assert.equal(classifyUpstreamError(504, geminiError(504, 'DEADLINE_EXCEEDED', 'deadline')).code, 'upstream_timeout');
  assert.equal(classifyUpstreamError(599, null).code, 'upstream_error');
  for (const code of ['upstream_error', 'upstream_unavailable', 'upstream_timeout']) {
    assert.equal(classifyUpstreamError(code === 'upstream_error' ? 500 : code === 'upstream_unavailable' ? 503 : 504, null).retryable, true);
  }
});

test('413 と想定外の 4xx', () => {
  assert.equal(classifyUpstreamError(413, null).code, 'payload_too_large');
  assert.equal(classifyUpstreamError(418, null).code, 'upstream_invalid_request');
});

test('ボディが JSON でなくても（null でも）ステータスだけで分類できる', () => {
  const err = classifyUpstreamError(503, null);
  assert.equal(err.code, 'upstream_unavailable');
  assert.equal(err.details.upstreamMessage, undefined);
  assert.equal(err.details.upstreamHttpStatus, 503);
});

test('上流メッセージは300文字で切り詰める', () => {
  const err = classifyUpstreamError(500, geminiError(500, 'INTERNAL', 'x'.repeat(1000)));
  assert.equal(err.details.upstreamMessage.length, 300);
});

test('Retry-After ヘッダを ApiError に引き継ぐ', () => {
  const err = classifyUpstreamError(429, geminiError(429, 'RESOURCE_EXHAUSTED', 'slow down'), new Headers({ 'retry-after': '7' }));
  assert.equal(err.retryAfterMs, 7000);
});

// --- parseRetryAfterMs -----------------------------------------------------

test('Retry-After: 秒数 / HTTP-date / 不正値', () => {
  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': '3' }), null), 3000);
  assert.equal(parseRetryAfterMs({ 'Retry-After': '5' }, null), 5000, 'プレーンなヘッダオブジェクトでも読める');

  const now = Date.parse('2026-01-01T00:00:00Z');
  const at = new Date(now + 12_000).toUTCString();
  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': at }), null, now), 12_000);

  // 過去日時は 0 に丸める
  const past = new Date(now - 5_000).toUTCString();
  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': past }), null, now), 0);

  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': 'soon' }), null), undefined);
  assert.equal(parseRetryAfterMs({ 'retry-after': 'すぐ' }, null), undefined, '非ASCIIでも落ちない');
  assert.equal(parseRetryAfterMs(new Headers({}), null), undefined);
  assert.equal(parseRetryAfterMs({ 'x-other': '1' }, null), undefined, '該当ヘッダが無い場合');
  assert.equal(parseRetryAfterMs(null, null), undefined);
});

test('Retry-After が無ければ Google の RetryInfo を使う', () => {
  const data = geminiError(429, 'RESOURCE_EXHAUSTED', 'rate', [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21.5s' },
  ]);
  assert.equal(parseRetryAfterMs(new Headers({}), data), 21_500);
  assert.equal(parseRetryAfterMs(new Headers({ 'retry-after': '2' }), data), 2000, 'ヘッダを優先');
});

// --- parseGeminiResponse ---------------------------------------------------

test('正常応答からテキストと付随情報を取り出す', () => {
  const parsed = parseGeminiResponse(geminiOk('{"reply":"はい"}'));
  assert.equal(parsed.text, '{"reply":"はい"}');
  assert.equal(parsed.finishReason, 'STOP');
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.usage.totalTokenCount, 165);
  assert.equal(parsed.modelVersion, 'gemini-2.5-flash');
});

test('複数 parts を連結し、thought パートは除外する', () => {
  const data = {
    candidates: [
      {
        content: {
          parts: [{ text: '考え中', thought: true }, { text: 'こん' }, { text: 'にちは' }, { inlineData: {} }],
        },
        finishReason: 'STOP',
      },
    ],
  };
  assert.equal(parseGeminiResponse(data).text, 'こんにちは');
});

test('プロンプトがブロックされた場合は content_blocked（422 / 再試行しない）', () => {
  const data = {
    promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'HIGH' }] },
  };
  const err = expectThrow(() => parseGeminiResponse(data));
  assert.equal(err.code, 'content_blocked');
  assert.equal(err.status, 422);
  assert.equal(err.retryable, false);
  assert.equal(err.details.stage, 'prompt');
  assert.equal(err.details.blockReason, 'SAFETY');
  assert.match(err.message, /SAFETY/);
});

test('応答側の安全性ブロック（finishReason）も content_blocked', () => {
  for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
    const data = { candidates: [{ finishReason: reason, content: { parts: [] } }] };
    const err = expectThrow(() => parseGeminiResponse(data));
    assert.equal(err.code, 'content_blocked', reason);
    assert.equal(err.details.stage, 'response');
    assert.equal(err.details.finishReason, reason);
  }
});

test('candidates が空なら empty_response（再試行可）', () => {
  for (const data of [{ candidates: [] }, { candidates: undefined }, {}]) {
    const err = expectThrow(() => parseGeminiResponse(data));
    assert.equal(err.code, 'empty_response');
    assert.equal(err.retryable, true);
  }
});

test('MAX_TOKENS + 本文ありは truncated フラグを立てて成功扱い', () => {
  const data = { candidates: [{ content: { parts: [{ text: '{"reply":"途中' }] }, finishReason: 'MAX_TOKENS' }] };
  const parsed = parseGeminiResponse(data);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.text, '{"reply":"途中');
});

test('MAX_TOKENS + 本文なしは response_truncated（同条件の再送では直らない）', () => {
  const data = {
    candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { thoughtsTokenCount: 1024 },
  };
  const err = expectThrow(() => parseGeminiResponse(data));
  assert.equal(err.code, 'response_truncated');
  assert.equal(err.retryable, false);
  assert.equal(err.details.usage.thoughtsTokenCount, 1024);
});

test('STOP なのに本文が空なら empty_response（再試行可）', () => {
  const data = { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] };
  const err = expectThrow(() => parseGeminiResponse(data));
  assert.equal(err.code, 'empty_response');
  assert.equal(err.retryable, true);
  assert.equal(err.details.finishReason, 'STOP');
});

test('finishReason が無く本文も無い場合も empty_response', () => {
  const err = expectThrow(() => parseGeminiResponse({ candidates: [{ content: {} }] }));
  assert.equal(err.code, 'empty_response');
  assert.equal(err.details.finishReason, null);
});

test('オブジェクトでない応答は invalid_upstream_response', () => {
  for (const data of [null, 'text', 42, []]) {
    const err = expectThrow(() => parseGeminiResponse(data));
    assert.equal(err.code, 'invalid_upstream_response');
  }
});
