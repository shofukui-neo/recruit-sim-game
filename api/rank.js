// api/rank.js — 個人ランキング（Redis）
//
// 保存先は2系統に対応する。どちらが挿さっていても動くようにしてあるのは、
// Vercel のストアによって注入される環境変数が違うため。
//   1. REST     … Upstash / Vercel KV。HTTPS なので fetch だけで叩ける（KV_REST_API_URL など）
//   2. TCP      … Redis Cloud 等の Marketplace「Redis」。rediss:// の接続文字列（REDIS_URL）
// REST が使えるならそちらを優先する（サーバーレスと相性が良く、接続の維持が要らないため）。
//
// 記録の全消去は取り返しがつかないので、運営の合言葉（ADMIN_TOKEN、無ければ EVENT_PASS）を
// x-admin-token ヘッダで必須にしている。どちらも未設定なら消去は拒否する（安全側）。
// createHandler() で env / fetch / Redisクライアント を注入できるのでテストできる（tests/rank.test.js）。

import { matchesSecret } from './_lib/http.js';

// TCP接続はコールドスタート時だけ張って、以降のリクエストで使い回す。
// 既定の10秒では初回接続に間に合わないことがあるので少し伸ばしておく。
export const config = { maxDuration: 15 };

const CONNECT_TIMEOUT_MS = 6000;

const keyFor = room => 'rank:' + String(room || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
// 回答履歴は一覧とは別のハッシュに置く。一覧のGETは参加者全員ぶんを返すので、
// そこに履歴まで載せると数十人規模で数百KBになり、当日の会場回線では開かなくなる。
const detailKeyFor = room => keyFor(room) + ':d';
const pidOf = v => String(v || '').replace(/[^a-z0-9]/g, '').slice(0, 20);

const KINDS = ['sasaru', 'good', 'flat', 'miss', 'jirai'];
const clampStr = (v, n) => String(v == null ? '' : v).slice(0, n);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

/**
 * 回答履歴の受け入れ。認証のないエンドポイントなので、
 * 知らない項目は落とし、長さと件数に上限を掛けてから保存する。
 */
function sanitizeHistory(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.slice(0, 12).map(h => ({
    stageIdx: clampInt(h && h.stageIdx, 0, 9),
    turnIdx: clampInt(h && h.turnIdx, 0, 9),
    label: clampStr(h && h.label, 60),
    message: clampStr(h && h.message, 500),
    action: clampStr(h && h.action, 20),
    timedOut: !!(h && h.timedOut),
    reply: clampStr(h && h.reply, 300),
    delta: clampInt(h && h.delta, -40, 40),
    reason: clampStr(h && h.reason, 300),
    inner: clampStr(h && h.inner, 200),
    ng: Array.isArray(h && h.ng) ? h.ng.slice(0, 3).map(x => clampStr(x, 60)) : [],
    scoreAfter: clampInt(h && h.scoreAfter, 0, 100),
    kind: KINDS.includes(h && h.kind) ? h.kind : 'flat',
  }));
}

/** Upstash / Vercel KV の REST API。HGETALL はフラット配列で返る。 */
function restStore(base, token, fetchImpl) {
  const call = async cmd => {
    const r = await fetchImpl(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) throw new Error('kv ' + r.status);
    return (await r.json()).result;
  };
  return {
    kind: 'rest',
    async hgetall(key) {
      const flat = (await call(['HGETALL', key])) || [];
      const out = {};
      for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
      return out;
    },
    hget: (key, field) => call(['HGET', key, field]),
    hset: (key, field, value) => call(['HSET', key, field, value]),
    del: key => call(['DEL', key]),
  };
}

/**
 * redis:// / rediss:// への TCP 接続（node-redis）。
 * 依存が入っていない環境でも関数ごと落ちないよう、import は遅延させて例外を捕まえる。
 */
function tcpStore(url, factory) {
  let pending = null;
  const connect = async () => {
    const { createClient } = await import('redis');
    const client = createClient({
      url,
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        // サーバーレスなので延々と再接続させない。落ちたら次のリクエストで張り直す。
        reconnectStrategy: retries => (retries > 2 ? false : 200),
      },
    });
    // error を拾わないと Node が未処理例外として関数ごと落としてしまう
    client.on('error', () => {});
    await client.connect();
    return client;
  };
  const get = () => {
    if (!pending) {
      pending = (factory || connect)().catch(err => {
        pending = null; // 次のリクエストで張り直せるように捨てる
        throw err;
      });
    }
    return pending;
  };
  return {
    kind: 'tcp',
    async hgetall(key) {
      return (await (await get()).hGetAll(key)) || {};
    },
    async hget(key, field) {
      return (await get()).hGet(key, field);
    },
    async hset(key, field, value) {
      return (await get()).hSet(key, field, value);
    },
    async del(key) {
      return (await get()).del(key);
    },
  };
}

export function createHandler(deps = {}) {
  const { env = process.env, fetchImpl = globalThis.fetch, redisFactory } = deps;

  const restBase = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const restToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  const tcpUrl = env.REDIS_URL || env.KV_URL;
  // ADMIN_TOKEN を別に切れるようにしつつ、当日の運用を楽にするため EVENT_PASS にフォールバックする
  const adminToken = env.ADMIN_TOKEN || env.EVENT_PASS;

  const store = restBase && restToken ? restStore(restBase, restToken, fetchImpl)
    : (tcpUrl || redisFactory) ? tcpStore(tcpUrl, redisFactory)
    : null;

  return async function handler(req, res) {
    if (!store) return res.status(503).json({ error: 'kv_not_configured' });
    try {
      if (req.method === 'GET') {
        const room = req.query?.room;
        // pid 指定は「ランキングで押された1人ぶんの回答履歴」を取りに来ている
        const wantPid = pidOf(req.query?.pid);
        if (wantPid) {
          const raw = await store.hget(detailKeyFor(room), wantPid);
          let detail = null;
          try { detail = raw ? JSON.parse(raw) : null; } catch (_) {}
          return res.status(200).json({ detail, store: store.kind });
        }
        const map = await store.hgetall(keyFor(room));
        const rows = [];
        for (const raw of Object.values(map)) {
          try {
            const v = JSON.parse(raw);
            if (v && v.name) rows.push(v);
          } catch (_) {}
        }
        return res.status(200).json({ rows, store: store.kind });
      }
      if (req.method === 'POST') {
        const b = req.body || {};
        const key = keyFor(b.room);
        if (b.action === 'clear') {
          // 合言葉が未設定なら「検証できない」ので消させない。URLを知っているだけでは消えない。
          if (!adminToken) return res.status(403).json({ error: 'admin_token_not_configured' });
          if (!matchesSecret(req, 'x-admin-token', adminToken)) {
            return res.status(403).json({ error: 'bad_admin_token' });
          }
          await store.del(key);
          await store.del(detailKeyFor(b.room));
          return res.status(200).json({ ok: true });
        }
        const pid = pidOf(b.pid);
        const name = String(b.name || '').slice(0, 12);
        const score = Math.max(0, Math.min(100, Math.round(Number(b.score) || 0)));
        if (!pid || !name) return res.status(400).json({ error: 'bad_payload' });
        const at = Date.now();
        // 一覧に pid を載せておく。ランキングで押された人の履歴を引くのに要る。
        await store.hset(key, pid, JSON.stringify({ pid, name, score, ok: !!b.ok, at }));
        const history = sanitizeHistory(b.history);
        if (history) {
          await store.hset(detailKeyFor(b.room), pid, JSON.stringify({ pid, name, score, ok: !!b.ok, at, history }));
        }
        return res.status(200).json({ ok: true, savedHistory: !!history });
      }
      return res.status(405).json({ error: 'method_not_allowed' });
    } catch (e) {
      // 原因が分からないと当日の切り分けができないので、種別だけは返す（接続文字列は絶対に返さない）
      const detail = e && e.code === 'ERR_MODULE_NOT_FOUND' ? 'redis_module_missing' : undefined;
      return res.status(500).json({ error: 'rank_failed', via: store.kind, detail });
    }
  };
}

export default createHandler();
