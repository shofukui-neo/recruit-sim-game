// tests/rank.test.js — ランキングAPI（api/rank.js）
// 記録の全消去は取り返しがつかないので、合言葉の検証まわりを重点的に見る。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../api/rank.js';
import { createFetchDouble, createMockReq, createMockRes, jsonResponse } from './helpers.js';

const KV_ENV = { KV_REST_API_URL: 'https://kv.example.com', KV_REST_API_TOKEN: 'kv-token' };
const TCP_ENV = { REDIS_URL: 'rediss://user:pass@redis.example.com:6379' };

/** node-redis のクライアント風ダブル。ハッシュ1つ分をメモリに持つ。 */
function fakeRedis(initial = {}) {
  const data = { ...initial };
  const calls = [];
  const client = {
    async hGetAll(key) { calls.push(['hGetAll', key]); return { ...data }; },
    async hSet(key, field, value) { calls.push(['hSet', key, field, value]); data[field] = value; return 1; },
    async del(key) { calls.push(['del', key]); for (const k of Object.keys(data)) delete data[k]; return 1; },
  };
  client.calls = calls;
  client.data = data;
  return client;
}

/** ハンドラを1回呼んで res と fetch の呼び出し記録を返す */
async function invoke({ req, env = KV_ENV, responders = [], redisFactory } = {}) {
  const res = createMockRes();
  const fetchImpl = createFetchDouble(responders);
  await createHandler({ env, fetchImpl, redisFactory })(req, res);
  return { res, fetchImpl };
}

const clearReq = (headers = {}) =>
  createMockReq({ method: 'POST', headers, body: { room: 'r1', action: 'clear' } });

test('REST も TCP も未設定なら 503 kv_not_configured を返す', async () => {
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

/* ---- TCP（Redis Cloud 等の REDIS_URL）経路 ---- */

test('TCP: REST が無く REDIS_URL があれば TCP 経路を使う', async () => {
  const client = fakeRedis({ pid1: JSON.stringify({ name: '田中', score: 80, ok: true }) });
  const req = createMockReq({ method: 'GET' });
  req.query = { room: 'r1' };
  const { res } = await invoke({ req, env: TCP_ENV, redisFactory: async () => client });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.store, 'tcp');
  assert.deepEqual(res.body.rows, [{ name: '田中', score: 80, ok: true }]);
  assert.deepEqual(client.calls[0], ['hGetAll', 'rank:r1']);
});

test('TCP: REST と両方あれば REST を優先する', async () => {
  const client = fakeRedis();
  const req = createMockReq({ method: 'GET' });
  req.query = { room: 'r1' };
  const { res } = await invoke({
    req, env: { ...KV_ENV, ...TCP_ENV },
    responders: [jsonResponse(200, { result: [] })],
    redisFactory: async () => client,
  });
  assert.equal(res.body.store, 'rest');
  assert.equal(client.calls.length, 0);
});

test('TCP: POST で hSet され、GET で読み戻せる', async () => {
  const client = fakeRedis();
  const factory = async () => client;
  const post = createMockReq({ method: 'POST', body: { room: 'r1', pid: 'abc123', name: '山田', score: 88, ok: true } });
  const { res: postRes } = await invoke({ req: post, env: TCP_ENV, redisFactory: factory });
  assert.equal(postRes.statusCode, 200);
  assert.equal(JSON.parse(client.data.abc123).score, 88);

  const get = createMockReq({ method: 'GET' });
  get.query = { room: 'r1' };
  const { res: getRes } = await invoke({ req: get, env: TCP_ENV, redisFactory: factory });
  assert.deepEqual(getRes.body.rows.map(r => r.name), ['山田']);
});

test('TCP: clear は合言葉が一致したときだけ del する', async () => {
  const client = fakeRedis({ pid1: JSON.stringify({ name: '田中', score: 80, ok: true }) });
  const env = { ...TCP_ENV, ADMIN_TOKEN: 'ただしい' };

  const bad = await invoke({ req: clearReq({ 'x-admin-token': 'ちがう' }), env, redisFactory: async () => client });
  assert.equal(bad.res.statusCode, 403);
  assert.equal(client.calls.length, 0);

  const good = await invoke({ req: clearReq({ 'x-admin-token': 'ただしい' }), env, redisFactory: async () => client });
  assert.equal(good.res.statusCode, 200);
  assert.deepEqual(client.calls[0], ['del', 'rank:r1']);
  assert.deepEqual(Object.keys(client.data), []);
});

test('TCP: 接続に失敗したら 500 rank_failed（via:tcp）を返す', async () => {
  const req = createMockReq({ method: 'GET' });
  req.query = { room: 'r1' };
  const { res } = await invoke({
    req, env: TCP_ENV,
    redisFactory: async () => { throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }); },
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'rank_failed');
  assert.equal(res.body.via, 'tcp');
});

test('TCP: 接続に失敗しても次のリクエストで張り直す', async () => {
  const client = fakeRedis();
  let attempts = 0;
  const factory = async () => {
    attempts++;
    if (attempts === 1) throw new Error('一時的な失敗');
    return client;
  };
  const handler = createHandler({ env: TCP_ENV, redisFactory: factory });

  const req1 = createMockReq({ method: 'GET' }); req1.query = { room: 'r1' };
  const res1 = createMockRes();
  await handler(req1, res1);
  assert.equal(res1.statusCode, 500);

  const req2 = createMockReq({ method: 'GET' }); req2.query = { room: 'r1' };
  const res2 = createMockRes();
  await handler(req2, res2);
  assert.equal(res2.statusCode, 200, '2回目は接続が張り直されて成功すること');
  assert.equal(attempts, 2);
});

test('TCP: 一度つないだ接続は使い回す（コールドスタート以外で再接続しない）', async () => {
  const client = fakeRedis();
  let connects = 0;
  const handler = createHandler({ env: TCP_ENV, redisFactory: async () => { connects++; return client; } });
  for (let i = 0; i < 3; i++) {
    const req = createMockReq({ method: 'GET' }); req.query = { room: 'r1' };
    await handler(req, createMockRes());
  }
  assert.equal(connects, 1);
});
