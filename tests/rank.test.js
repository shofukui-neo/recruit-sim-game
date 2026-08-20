// tests/rank.test.js — ランキングAPI（api/rank.js）
// 記録の全消去は取り返しがつかないので、合言葉の検証まわりを重点的に見る。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../api/rank.js';
import { createFetchDouble, createMockReq, createMockRes, jsonResponse } from './helpers.js';

const KV_ENV = { KV_REST_API_URL: 'https://kv.example.com', KV_REST_API_TOKEN: 'kv-token' };

/** ハンドラを1回呼んで res と fetch の呼び出し記録を返す */
async function invoke({ req, env = KV_ENV, responders = [] } = {}) {
  const res = createMockRes();
  const fetchImpl = createFetchDouble(responders);
  await createHandler({ env, fetchImpl })(req, res);
  return { res, fetchImpl };
}

const clearReq = (headers = {}) =>
  createMockReq({ method: 'POST', headers, body: { room: 'r1', action: 'clear' } });

test('KV が未設定なら 503 kv_not_configured を返す', async () => {
  const { res } = await invoke({ req: createMockReq({ method: 'GET' }), env: {} });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'kv_not_configured');
});

test('GET は HGETALL の結果を rows に整形して返す', async () => {
  const stored = ['pid1', JSON.stringify({ name: '田中', score: 80, ok: true })];
  const req = createMockReq({ method: 'GET' });
  req.query = { room: 'r1' };
  const { res, fetchImpl } = await invoke({ req, responders: [jsonResponse(200, { result: stored })] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows, [{ name: '田中', score: 80, ok: true }]);
  assert.deepEqual(fetchImpl.calls[0].body, ['HGETALL', 'rank:r1']);
});

test('GET は壊れた行を落として残りを返す', async () => {
  const stored = ['a', '{壊れたJSON', 'b', JSON.stringify({ name: '佐藤', score: 60, ok: false })];
  const req = createMockReq({ method: 'GET' });
  req.query = { room: 'r1' };
  const { res } = await invoke({ req, responders: [jsonResponse(200, { result: stored })] });
  assert.equal(res.body.rows.length, 1);
  assert.equal(res.body.rows[0].name, '佐藤');
});

test('POST はスコアを 0〜100 に丸めて HSET する', async () => {
  const req = createMockReq({ method: 'POST', body: { room: 'r1', pid: 'abc123', name: '山田', score: 130, ok: true } });
  const { res, fetchImpl } = await invoke({ req, responders: [jsonResponse(200, { result: 1 })] });
  assert.equal(res.statusCode, 200);
  const [cmd, key, pid, payload] = fetchImpl.calls[0].body;
  assert.equal(cmd, 'HSET');
  assert.equal(key, 'rank:r1');
  assert.equal(pid, 'abc123');
  assert.equal(JSON.parse(payload).score, 100);
});

test('pid か name が空なら 400', async () => {
  const req = createMockReq({ method: 'POST', body: { room: 'r1', pid: '', name: '山田', score: 50 } });
  const { res } = await invoke({ req });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'bad_payload');
});

test('clear: 合言葉がサーバーに未設定なら消させない', async () => {
  const { res, fetchImpl } = await invoke({ req: clearReq({ 'x-admin-token': 'なんでも' }) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'admin_token_not_configured');
  assert.equal(fetchImpl.calls.length, 0, 'KV を一切叩いていないこと');
});

test('clear: 合言葉が違えば 403 で、KV には触れない', async () => {
  const { res, fetchImpl } = await invoke({
    req: clearReq({ 'x-admin-token': 'ちがう' }),
    env: { ...KV_ENV, ADMIN_TOKEN: 'ただしい' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'bad_admin_token');
  assert.equal(fetchImpl.calls.length, 0);
});

test('clear: ヘッダが無ければ 403', async () => {
  const { res } = await invoke({ req: clearReq(), env: { ...KV_ENV, ADMIN_TOKEN: 'ただしい' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'bad_admin_token');
});

test('clear: 合言葉が一致すれば DEL する', async () => {
  const { res, fetchImpl } = await invoke({
    req: clearReq({ 'x-admin-token': 'ただしい' }),
    env: { ...KV_ENV, ADMIN_TOKEN: 'ただしい' },
    responders: [jsonResponse(200, { result: 1 })],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(fetchImpl.calls[0].body, ['DEL', 'rank:r1']);
});

test('clear: ADMIN_TOKEN が無ければ EVENT_PASS を合言葉として使う', async () => {
  const { res } = await invoke({
    req: clearReq({ 'x-admin-token': 'event-pass' }),
    env: { ...KV_ENV, EVENT_PASS: 'event-pass' },
    responders: [jsonResponse(200, { result: 1 })],
  });
  assert.equal(res.statusCode, 200);
});

test('room は英数記号のみに正規化される', async () => {
  const req = createMockReq({ method: 'GET' });
  req.query = { room: 'ろ/../am 1' };
  const { fetchImpl } = await invoke({ req, responders: [jsonResponse(200, { result: [] })] });
  assert.equal(fetchImpl.calls[0].body[1], 'rank:am1');
});

test('KV が失敗したら 500 rank_failed', async () => {
  const req = createMockReq({ method: 'GET' });
  req.query = { room: 'r1' };
  const { res } = await invoke({ req, responders: [jsonResponse(500, {})] });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'rank_failed');
});

test('未対応メソッドは 405', async () => {
  const { res } = await invoke({ req: createMockReq({ method: 'DELETE' }) });
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, 'method_not_allowed');
});
