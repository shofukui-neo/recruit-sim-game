// tests/errors.test.js — エラーカタログ / ApiError / 秘匿値マスク

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError,
  ERROR_CATALOG,
  apiError,
  invalidRequest,
  isApiError,
  isKnownErrorCode,
  redact,
  redactString,
  toErrorBody,
} from '../api/_lib/errors.js';

const FAKE_KEY = 'AIzaSyDUMMYKEYDUMMYKEYDUMMYKEYDUMMY123';

test('カタログの全エントリが status / retryable / message を持つ', () => {
  const codes = Object.keys(ERROR_CATALOG);
  assert.ok(codes.length >= 15, 'エラーコードが十分に定義されていること');
  for (const [code, spec] of Object.entries(ERROR_CATALOG)) {
    assert.equal(typeof spec.status, 'number', `${code}.status`);
    assert.ok(spec.status >= 400 && spec.status <= 599, `${code}.status が HTTP エラー範囲`);
    assert.equal(typeof spec.retryable, 'boolean', `${code}.retryable`);
    assert.equal(typeof spec.message, 'string', `${code}.message`);
    assert.ok(spec.message.length > 0, `${code}.message が空でない`);
  }
});

test('再試行可否がエラーの性質と一致している', () => {
  // クライアント起因・設定起因は再試行しても直らない
  for (const code of ['invalid_request', 'invalid_json', 'missing_api_key', 'invalid_api_key', 'content_blocked']) {
    assert.equal(ERROR_CATALOG[code].retryable, false, code);
  }
  // 一時的な障害は再試行する価値がある
  for (const code of ['rate_limited', 'upstream_unavailable', 'upstream_error', 'upstream_timeout', 'network_error']) {
    assert.equal(ERROR_CATALOG[code].retryable, true, code);
  }
});

test('ApiError はカタログから status / retryable / message を引く', () => {
  const err = apiError('rate_limited');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ApiError');
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.status, 429);
  assert.equal(err.retryable, true);
  assert.equal(err.message, ERROR_CATALOG.rate_limited.message);
});

test('未知のコードは internal_error に丸められる', () => {
  const err = apiError('totally_unknown_code');
  assert.equal(err.code, 'internal_error');
  assert.equal(err.status, 500);
  assert.equal(isKnownErrorCode('totally_unknown_code'), false);
});

test('message / details / retryAfterMs を上書きできる', () => {
  const err = apiError('upstream_error', {
    message: 'カスタム',
    details: { upstreamHttpStatus: 500 },
    retryAfterMs: 1500,
  });
  assert.equal(err.message, 'カスタム');
  assert.deepEqual(err.details, { upstreamHttpStatus: 500 });
  assert.equal(err.retryAfterMs, 1500);
});

test('retryAfterMs は有限数以外を捨てる', () => {
  assert.equal(apiError('rate_limited', { retryAfterMs: NaN }).retryAfterMs, undefined);
  assert.equal(apiError('rate_limited', { retryAfterMs: Infinity }).retryAfterMs, undefined);
  assert.equal(apiError('rate_limited', { retryAfterMs: '3000' }).retryAfterMs, undefined);
});

test('isApiError は ApiError だけを true にする', () => {
  assert.equal(isApiError(apiError('internal_error')), true);
  assert.equal(isApiError(new Error('boom')), false);
  assert.equal(isApiError(null), false);
  assert.equal(isApiError({ name: 'ApiError', code: 'rate_limited' }), true, '別realm由来でも判定できる');
  assert.equal(isApiError({ name: 'ApiError', code: 'bogus' }), false);
});

test('invalidRequest は field と理由を details に残す', () => {
  const err = invalidRequest('max_tokens', 'は整数である必要があります', { value: 1.5 });
  assert.equal(err.code, 'invalid_request');
  assert.equal(err.status, 400);
  assert.match(err.message, /max_tokens/);
  assert.deepEqual(err.details, { field: 'max_tokens', reason: 'は整数である必要があります', value: 1.5 });
});

test('redactString: 明示した秘匿値を消す', () => {
  const out = redactString(`key is ${FAKE_KEY} ok`, [FAKE_KEY]);
  assert.equal(out.includes(FAKE_KEY), false);
  assert.match(out, /REDACTED/);
});

test('redactString: 未知の APIキーも形状で消す', () => {
  const out = redactString(`request failed: AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456`, []);
  assert.equal(out.includes('AIzaSy'), false);
});

test('redactString: URL の key / api_key パラメータを消す', () => {
  const out = redactString('https://example.com/v1/models/x:generateContent?key=secret-value&alt=sse', []);
  assert.equal(out.includes('secret-value'), false);
  assert.match(out, /\?key=\*\*\*REDACTED\*\*\*&alt=sse/);
  assert.match(redactString('https://e.com/a?api_key=abc123xyz', []), /api_key=\*\*\*REDACTED\*\*\*/);
});

test('redactString: Authorization ヘッダの値を消す', () => {
  const out = redactString('Authorization: Bearer ya29.abcdefghijklmn', []);
  assert.equal(out.includes('ya29.abcdefghijklmn'), false);
  assert.match(out, /Bearer \*\*\*REDACTED\*\*\*/);
});

test('redactString: 短すぎる秘匿値は無視する（誤爆防止）', () => {
  assert.equal(redactString('abc def', ['abc']), 'abc def');
});

test('redact: 配列・入れ子オブジェクトを再帰的に処理し、非文字列は保持する', () => {
  const input = {
    ok: true,
    count: 3,
    nested: { url: `https://x/y?key=${FAKE_KEY}`, list: [`token ${FAKE_KEY}`, 42, null] },
  };
  const out = redact(input, [FAKE_KEY]);
  assert.equal(out.ok, true);
  assert.equal(out.count, 3);
  assert.equal(JSON.stringify(out).includes(FAKE_KEY), false);
  assert.equal(out.nested.list[1], 42);
  assert.equal(out.nested.list[2], null);
});

test('redact: 深すぎる入れ子は打ち切る', () => {
  let deep = 'bottom';
  for (let i = 0; i < 12; i++) deep = { next: deep };
  const out = redact(deep, []);
  assert.equal(JSON.stringify(out).includes('truncated'), true);
});

test('toErrorBody: 既存フロント互換のキー（error / message）を保つ', () => {
  const body = toErrorBody(apiError('rate_limited', { retryAfterMs: 2000 }), { requestId: 'req-1' });
  assert.deepEqual(body, {
    error: 'rate_limited',
    message: ERROR_CATALOG.rate_limited.message,
    retryable: true,
    requestId: 'req-1',
    retryAfterMs: 2000,
  });
});

test('toErrorBody: 素の Error は internal_error に包み、内容をマスクして details に残す', () => {
  const raw = new Error(`fetch https://x?key=${FAKE_KEY} failed`);
  const body = toErrorBody(raw, { requestId: 'req-2', secrets: [FAKE_KEY] });
  assert.equal(body.error, 'internal_error');
  assert.equal(body.retryable, false);
  assert.equal(JSON.stringify(body).includes(FAKE_KEY), false);
  assert.match(body.details.internalMessage, /REDACTED/);
});

test('toErrorBody: details 内の秘匿値もマスクされる', () => {
  const err = apiError('upstream_error', { details: { upstreamMessage: `bad key ${FAKE_KEY}` } });
  const body = toErrorBody(err, { secrets: [FAKE_KEY] });
  assert.equal(JSON.stringify(body).includes(FAKE_KEY), false);
});

test('ApiError のスタックにコンストラクタが混ざらない', () => {
  const err = new ApiError('internal_error');
  assert.equal(err.stack.includes('new ApiError'), false);
});
