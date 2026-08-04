// tests/client.test.js — HTTPクライアント（タイムアウト・再試行・バックオフ・鍵の扱い）

import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_DEFAULTS, createGeminiClient, normalizeChatRequest } from '../api/_lib/gemini.js';
import {
  brokenJsonResponse,
  createFakeClock,
  createFetchDouble,
  expectReject,
  expectThrow,
  fixedRandom,
  geminiError,
  geminiOk,
  hangingFetch,
  jsonResponse,
  networkError,
} from './helpers.js';

const API_KEY = 'AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY0001';
const NORMALIZED = normalizeChatRequest({ messages: [{ role: 'user', content: 'こんにちは' }], json: true });

function makeClient(fetchImpl, overrides = {}) {
  const clock = createFakeClock();
  const client = createGeminiClient({
    apiKey: API_KEY,
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    random: fixedRandom,
    ...overrides,
  });
  return { client, clock };
}

test('APIキーが無ければクライアントを作れない', () => {
  for (const key of ['', '   ', undefined, null, 123]) {
    const err = expectThrow(() => createGeminiClient({ apiKey: key, fetchImpl: async () => {} }));
    assert.equal(err.code, 'missing_api_key');
  }
});

test('fetch 実装が無い場合は internal_error', () => {
  const err = expectThrow(() => createGeminiClient({ apiKey: API_KEY, fetchImpl: null }));
  assert.equal(err.code, 'internal_error');
});

test('成功時: URL・ヘッダ・ボディが正しく、鍵は URL に出ない', async () => {
  const fetchImpl = createFetchDouble([jsonResponse(200, geminiOk('{"reply":"はい"}'))]);
  const { client } = makeClient(fetchImpl);

  const result = await client.generate(NORMALIZED);

  assert.equal(result.attempts, 1);
  assert.equal(result.data.candidates[0].content.parts[0].text, '{"reply":"はい"}');

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(call.url.includes(API_KEY), false, 'URL に鍵を載せない');
  assert.equal(call.url.includes('key='), false);
  assert.equal(call.headers['x-goog-api-key'], API_KEY, 'ヘッダで鍵を渡す');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.body.contents[0].parts[0].text, 'user: こんにちは');
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(call.signal, 'AbortSignal が渡っている');
});

test('モデル名は URL エンコードして埋め込む', async () => {
  const fetchImpl = createFetchDouble([jsonResponse(200, geminiOk('ok'))]);
  const { client } = makeClient(fetchImpl);
  await client.generate(normalizeChatRequest({ model: 'gemini-2.0-flash-lite', messages: [{ content: 'x' }] }));
  assert.match(fetchImpl.calls[0].url, /models\/gemini-2\.0-flash-lite:generateContent$/);
});

test('503 は再試行し、成功したら返す', async () => {
  const fetchImpl = createFetchDouble([
    jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'The model is overloaded')),
    jsonResponse(200, geminiOk('二回目で成功')),
  ]);
  const { client, clock } = makeClient(fetchImpl);

  const result = await client.generate(NORMALIZED);

  assert.equal(result.attempts, 2);
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(clock.waits, [400], '指数バックオフの1回目 = baseDelayMs');
});

test('指数バックオフで待ち時間が倍増する', async () => {
  const fetchImpl = createFetchDouble([
    jsonResponse(500, geminiError(500, 'INTERNAL', 'x')),
    jsonResponse(500, geminiError(500, 'INTERNAL', 'x')),
    jsonResponse(200, geminiOk('三回目で成功')),
  ]);
  const { client, clock } = makeClient(fetchImpl, { maxRetries: 2 });

  const result = await client.generate(NORMALIZED);

  assert.equal(result.attempts, 3);
  assert.deepEqual(clock.waits, [400, 800]);
});

test('ジッターは待ち時間を 50〜100% の範囲に収める', async () => {
  const fetchImpl = createFetchDouble([
    jsonResponse(500, geminiError(500, 'INTERNAL', 'x')),
    jsonResponse(200, geminiOk('ok')),
  ]);
  const { client, clock } = makeClient(fetchImpl, { random: () => 0 });
  await client.generate(NORMALIZED);
  assert.deepEqual(clock.waits, [200], 'random()=0 なら baseDelay の 50%');
});

test('再試行の上限に達したら最後のエラーを投げる', async () => {
  const fetchImpl = createFetchDouble([
    jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'overloaded')),
    jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'overloaded')),
    jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'overloaded')),
  ]);
  const { client } = makeClient(fetchImpl, { maxRetries: 2 });

  const err = await expectReject(() => client.generate(NORMALIZED));
  assert.equal(err.code, 'upstream_unavailable');
  assert.equal(err.retryable, true);
  assert.equal(fetchImpl.calls.length, 3, '初回 + 2回で打ち止め');
});

test('再試行しないエラー（400）は1回で諦める', async () => {
  const fetchImpl = createFetchDouble([jsonResponse(400, geminiError(400, 'INVALID_ARGUMENT', 'bad request'))]);
  const { client, clock } = makeClient(fetchImpl);

  const err = await expectReject(() => client.generate(NORMALIZED));
  assert.equal(err.code, 'upstream_invalid_request');
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(clock.waits, []);
});

test('429 は Retry-After を尊重して待つ', async () => {
  const fetchImpl = createFetchDouble([
    jsonResponse(429, geminiError(429, 'RESOURCE_EXHAUSTED', 'slow down'), { 'retry-after': '2' }),
    jsonResponse(200, geminiOk('ok')),
  ]);
  const { client, clock } = makeClient(fetchImpl);

  await client.generate(NORMALIZED);
  assert.deepEqual(clock.waits, [2000]);
});

test('Retry-After が長すぎる場合は maxDelayMs で頭打ちにする', async () => {
  const fetchImpl = createFetchDouble([
    jsonResponse(429, geminiError(429, 'RESOURCE_EXHAUSTED', 'slow down'), { 'retry-after': '600' }),
    jsonResponse(200, geminiOk('ok')),
  ]);
  const { client, clock } = makeClient(fetchImpl, { maxDelayMs: 3000, totalTimeoutMs: 60_000 });

  await client.generate(NORMALIZED);
  assert.deepEqual(clock.waits, [3000]);
});

test('総時間を超える待ちが必要なら、それ以上再試行しない', async () => {
  const fetchImpl = createFetchDouble([
    jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'x')),
    jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'x')),
  ]);
  const { client, clock } = makeClient(fetchImpl, { maxRetries: 5, totalTimeoutMs: 500, baseDelayMs: 400 });

  const err = await expectReject(() => client.generate(NORMALIZED));
  assert.equal(err.code, 'upstream_unavailable');
  assert.equal(fetchImpl.calls.length, 2, '2回目の待ち(800ms)は総時間を超えるので打ち切り');
  assert.deepEqual(clock.waits, [400]);
});

test('ネットワークエラーは network_error として再試行する', async () => {
  const fetchImpl = createFetchDouble([
    () => {
      throw networkError('ECONNRESET');
    },
    jsonResponse(200, geminiOk('ok')),
  ]);
  const { client } = makeClient(fetchImpl);

  const result = await client.generate(NORMALIZED);
  assert.equal(result.attempts, 2);
});

test('ネットワークエラーが続けば network_error を投げる', async () => {
  const fetchImpl = createFetchDouble([
    () => {
      throw networkError('ENOTFOUND');
    },
    () => {
      throw networkError('ENOTFOUND');
    },
  ]);
  const { client } = makeClient(fetchImpl, { maxRetries: 1 });

  const err = await expectReject(() => client.generate(NORMALIZED));
  assert.equal(err.code, 'network_error');
  assert.equal(err.status, 502);
  assert.equal(err.details.reason, 'ENOTFOUND');
});

test('応答が返らない場合は attemptTimeoutMs で中断し upstream_timeout', async () => {
  const { client } = makeClient(hangingFetch(), { attemptTimeoutMs: 20, maxRetries: 0 });

  const err = await expectReject(() => client.generate(NORMALIZED));
  assert.equal(err.code, 'upstream_timeout');
  assert.equal(err.status, 504);
  assert.equal(err.retryable, true);
  assert.equal(err.details.attemptTimeoutMs, 20);
});

test('タイムアウトも再試行の対象になる', async () => {
  let calls = 0;
  const fetchImpl = (url, init) => {
    calls++;
    if (calls === 1) return hangingFetch()(url, init);
    return Promise.resolve(jsonResponse(200, geminiOk('二回目は応答あり')));
  };
  const { client } = makeClient(fetchImpl, { attemptTimeoutMs: 20 });

  const result = await client.generate(NORMALIZED);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('200 なのに JSON でない応答は invalid_upstream_response', async () => {
  const fetchImpl = createFetchDouble([brokenJsonResponse(200), jsonResponse(200, geminiOk('ok'))]);
  const { client } = makeClient(fetchImpl);

  const result = await client.generate(NORMALIZED);
  assert.equal(result.attempts, 2, '再試行の対象');
  assert.equal(fetchImpl.calls.length, 2);
});

test('200 で JSON が配列など想定外の型でも invalid_upstream_response', async () => {
  const fetchImpl = createFetchDouble([jsonResponse(200, ['unexpected'])]);
  const { client } = makeClient(fetchImpl, { maxRetries: 0 });

  const err = await expectReject(() => client.generate(NORMALIZED));
  assert.equal(err.code, 'invalid_upstream_response');
  assert.equal(err.details.reason, 'body_not_object');
});

test('5xx かつ本文が JSON でない場合はステータスだけで分類する', async () => {
  const fetchImpl = createFetchDouble([brokenJsonResponse(502)]);
  const { client } = makeClient(fetchImpl, { maxRetries: 0 });

  const err = await expectReject(() => client.generate(NORMALIZED));
  assert.equal(err.code, 'upstream_error');
  assert.equal(err.details.upstreamHttpStatus, 502);
});

test('onAttempt が各試行の結果を通知する', async () => {
  const events = [];
  const fetchImpl = createFetchDouble([
    jsonResponse(503, geminiError(503, 'UNAVAILABLE', 'x')),
    jsonResponse(200, geminiOk('ok')),
  ]);
  const { client } = makeClient(fetchImpl, { onAttempt: (info) => events.push(info) });

  await client.generate(NORMALIZED);

  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.attempt, e.ok, e.code, e.retryable]),
    [
      [0, false, 'upstream_unavailable', true],
      [1, true, undefined, undefined],
    ],
  );
});

test('既定値は関数の実行時間内に収まる設定になっている', () => {
  assert.ok(CLIENT_DEFAULTS.attemptTimeoutMs > 0);
  assert.ok(
    CLIENT_DEFAULTS.attemptTimeoutMs * (CLIENT_DEFAULTS.maxRetries + 1) >= CLIENT_DEFAULTS.totalTimeoutMs,
    '総時間は各試行の合計を上回らない',
  );
  assert.ok(CLIENT_DEFAULTS.totalTimeoutMs < 30_000, 'フロントの30秒タイムアウトより内側');
});

test('エラーには APIキーが一切含まれない', async () => {
  const fetchImpl = createFetchDouble([
    jsonResponse(400, geminiError(400, 'INVALID_ARGUMENT', `API key not valid: ${API_KEY}`)),
  ]);
  const { client } = makeClient(fetchImpl, { maxRetries: 0 });

  const err = await expectReject(() => client.generate(NORMALIZED));
  // クライアント層では上流メッセージをそのまま保持する（マスクは応答生成時に行う）
  assert.equal(err.code, 'invalid_api_key');
  // ハンドラ経由の応答に鍵が出ないことは handler.test.js で検証する
  assert.ok(err.details.upstreamMessage.includes('API key not valid'));
});
