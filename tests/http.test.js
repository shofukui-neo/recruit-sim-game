// tests/http.test.js — req/res 補助（ボディ読取・応答送出・合言葉・リクエストID）

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  MAX_BODY_BYTES,
  createLogger,
  headerValue,
  readJsonBody,
  resolveRequestId,
  sendJson,
  verifyEventPass,
} from '../api/_lib/http.js';
import { createLogSink, createMockReq, createMockRes, expectReject, expectThrow } from './helpers.js';

test('headerValue は大文字小文字と配列を吸収する', () => {
  const req = { headers: { 'x-event-pass': 'abc', 'x-multi': ['first', 'second'] } };
  assert.equal(headerValue(req, 'X-Event-Pass'), 'abc');
  assert.equal(headerValue(req, 'x-multi'), 'first');
  assert.equal(headerValue(req, 'x-none'), undefined);
  assert.equal(headerValue({}, 'x'), undefined);
});

test('readJsonBody: 解析済みオブジェクト・文字列・Buffer・空文字', async () => {
  assert.deepEqual(await readJsonBody(createMockReq({ body: { a: 1 } })), { a: 1 });
  assert.deepEqual(await readJsonBody(createMockReq({ body: '{"a":1}' })), { a: 1 });
  assert.deepEqual(await readJsonBody(createMockReq({ body: Buffer.from('{"a":1}') })), { a: 1 });
  assert.deepEqual(await readJsonBody(createMockReq({ body: '' })), {});
  assert.deepEqual(await readJsonBody(createMockReq({ body: '   ' })), {});
  assert.deepEqual(await readJsonBody(createMockReq({ body: undefined })), {});
});

test('readJsonBody: ストリームから読める', async () => {
  const stream = Readable.from([Buffer.from('{"messages":'), Buffer.from('[{"content":"x"}]}')]);
  stream.method = 'POST';
  stream.headers = {};
  const body = await readJsonBody(stream);
  assert.deepEqual(body, { messages: [{ content: 'x' }] });
});

test('readJsonBody: 壊れた JSON は invalid_json', async () => {
  const err = await expectReject(() => readJsonBody(createMockReq({ body: '{"a":' })));
  assert.equal(err.code, 'invalid_json');
  assert.equal(err.status, 400);
  assert.ok(err.details.reason.length > 0);
});

test('readJsonBody: 未対応の型は invalid_json', async () => {
  const err = await expectReject(() => readJsonBody(createMockReq({ body: 42 })));
  assert.equal(err.code, 'invalid_json');
});

test('readJsonBody: content-length 超過は読む前に payload_too_large', async () => {
  const err = await expectReject(() =>
    readJsonBody(createMockReq({ headers: { 'content-length': String(MAX_BODY_BYTES + 1) }, body: '{}' })),
  );
  assert.equal(err.code, 'payload_too_large');
  assert.equal(err.details.limit, MAX_BODY_BYTES);
});

test('readJsonBody: ストリームの実サイズ超過も検出する', async () => {
  const stream = Readable.from([Buffer.alloc(64, 'a'), Buffer.alloc(64, 'b')]);
  stream.headers = {};
  const err = await expectReject(() => readJsonBody(stream, { maxBytes: 100 }));
  assert.equal(err.code, 'payload_too_large');
});

test('readJsonBody: Buffer の実サイズ超過も検出する', async () => {
  const err = await expectReject(() =>
    readJsonBody(createMockReq({ body: Buffer.alloc(200, 'a') }), { maxBytes: 100 }),
  );
  assert.equal(err.code, 'payload_too_large');
});

test('sendJson: Vercel 形式（status/json）で送る', () => {
  const res = createMockRes();
  sendJson(res, 200, { ok: true }, { 'x-request-id': 'abc', 'skip-me': undefined });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.headers['x-request-id'], 'abc');
  assert.equal('skip-me' in res.headers, false, 'undefined のヘッダは設定しない');
});

test('sendJson: body が null なら本文なしで終わる', () => {
  const res = createMockRes();
  sendJson(res, 204, null);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, undefined);
  assert.equal(res.ended, true);
});

test('sendJson: 素の http.ServerResponse 形式にも対応する', () => {
  const calls = { head: null, end: null, headers: {} };
  const res = {
    setHeader: (k, v) => {
      calls.headers[k] = v;
    },
    writeHead: (status, headers) => {
      calls.head = { status, headers };
    },
    end: (payload) => {
      calls.end = payload;
    },
  };
  sendJson(res, 502, { error: 'upstream_error' }, { 'x-request-id': 'zzz' });
  assert.equal(calls.head.status, 502);
  assert.match(calls.head.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(calls.end), { error: 'upstream_error' });
  assert.equal(calls.headers['x-request-id'], 'zzz');
});

test('verifyEventPass: 未設定なら常に通す', () => {
  for (const expected of [undefined, '', null]) {
    verifyEventPass(createMockReq({}), expected);
  }
});

test('verifyEventPass: 一致すれば通し、不一致・長さ違い・欠落は 401', () => {
  verifyEventPass(createMockReq({ headers: { 'x-event-pass': 'secret-pass' } }), 'secret-pass');
  for (const headers of [{}, { 'x-event-pass': 'secret-pas' }, { 'x-event-pass': 'secret-passX' }, { 'x-event-pass': 'SECRET-PASS' }]) {
    const err = expectThrow(() => verifyEventPass(createMockReq({ headers }), 'secret-pass'));
    assert.equal(err.code, 'unauthorized');
    assert.equal(err.status, 401);
  }
});

test('resolveRequestId: 正当なヘッダは引き継ぎ、危険な文字は落とす', () => {
  assert.equal(resolveRequestId(createMockReq({ headers: { 'x-request-id': 'turn-0001-abc' } })), 'turn-0001-abc');
  assert.equal(
    resolveRequestId(createMockReq({ headers: { 'x-request-id': 'a\nb\rc<script>1234' } })),
    'abcscript1234',
    '制御文字・記号を除去する',
  );
  assert.match(resolveRequestId(createMockReq({ headers: { 'x-request-id': 'short' } })), /^[0-9a-f-]{36}$/);
  assert.match(resolveRequestId(createMockReq({})), /^[0-9a-f-]{36}$/);
  assert.equal(resolveRequestId(createMockReq({ headers: { 'x-request-id': 'x'.repeat(100) } })).length, 64);
});

test('createLogger: level に応じて log / error へ振り分け、1行JSONで書く', () => {
  const sink = createLogSink();
  const log = createLogger(sink);
  log('info', { event: 'gemini_ok', requestId: 'r1' });
  log('error', { event: 'gemini_failed', requestId: 'r1' });
  assert.equal(sink.lines.length, 2);
  assert.deepEqual(sink.lines[0], { level: 'info', event: 'gemini_ok', requestId: 'r1' });
  assert.equal(sink.find('gemini_failed').level, 'error');
});
