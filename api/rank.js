// api/rank.js — 個人ランキング（Upstash Redis / Vercel KV）
//
// 記録の全消去は取り返しがつかないので、運営の合言葉（ADMIN_TOKEN、無ければ EVENT_PASS）を
// x-admin-token ヘッダで必須にしている。どちらも未設定なら消去は拒否する（安全側）。
// createHandler() で env と fetch を注入できるので、ハンドラ単位でテストできる（tests/rank.test.js）。

import { matchesSecret } from './_lib/http.js';

const keyFor = room => 'rank:' + String(room || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);

export function createHandler(deps = {}) {
  const { env = process.env, fetchImpl = globalThis.fetch } = deps;

  const base = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  // ADMIN_TOKEN を別に切れるようにしつつ、当日の運用を楽にするため EVENT_PASS にフォールバックする
  const adminToken = env.ADMIN_TOKEN || env.EVENT_PASS;

  async function redis(cmd) {
    const r = await fetchImpl(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) throw new Error('kv ' + r.status);
    return (await r.json()).result;
  }

  return async function handler(req, res) {
    if (!base || !token) return res.status(503).json({ error: 'kv_not_configured' });
    try {
      if (req.method === 'GET') {
        const key = keyFor(req.query?.room);
        const flat = (await redis(['HGETALL', key])) || [];
        const rows = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          try {
            const v = JSON.parse(flat[i + 1]);
            if (v && v.name) rows.push(v);
          } catch (_) {}
        }
        return res.status(200).json({ rows });
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
          await redis(['DEL', key]);
          return res.status(200).json({ ok: true });
        }
        const pid = String(b.pid || '').replace(/[^a-z0-9]/g, '').slice(0, 20);
        const name = String(b.name || '').slice(0, 12);
        const score = Math.max(0, Math.min(100, Math.round(Number(b.score) || 0)));
        if (!pid || !name) return res.status(400).json({ error: 'bad_payload' });
        await redis(['HSET', key, pid, JSON.stringify({ name, score, ok: !!b.ok, at: Date.now() })]);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'method_not_allowed' });
    } catch (e) {
      return res.status(500).json({ error: 'rank_failed' });
    }
  };
}

export default createHandler();
