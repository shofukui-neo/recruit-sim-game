// api/rank.js — 個人ランキング（Upstash Redis / Vercel KV）
const BASE  = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd){
  const r = await fetch(BASE, {
    method:'POST',
    headers:{ Authorization:`Bearer ${TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify(cmd),
  });
  if(!r.ok) throw new Error('kv '+r.status);
  return (await r.json()).result;
}
const keyFor = room => 'rank:' + String(room||'default').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);

export default async function handler(req, res){
  if(!BASE || !TOKEN) return res.status(503).json({ error:'kv_not_configured' });
  try{
    if(req.method === 'GET'){
      const key = keyFor(req.query.room);
      const flat = await redis(['HGETALL', key]) || [];
      const rows = [];
      for(let i=0; i+1<flat.length; i+=2){
        try{
          const v = JSON.parse(flat[i+1]);
          if(v && v.name) rows.push(v);
        }catch(_){}
      }
      return res.status(200).json({ rows });
    }
    if(req.method === 'POST'){
      const b = req.body || {};
      const key = keyFor(b.room);
      if(b.action === 'clear'){
        await redis(['DEL', key]);
        return res.status(200).json({ ok:true });
      }
      const pid  = String(b.pid||'').replace(/[^a-z0-9]/g,'').slice(0,20);
      const name = String(b.name||'').slice(0,12);
      const score = Math.max(0, Math.min(100, Math.round(Number(b.score)||0)));
      if(!pid || !name) return res.status(400).json({ error:'bad_payload' });
      await redis(['HSET', key, pid, JSON.stringify({ name, score, ok:!!b.ok, at:Date.now() })]);
      return res.status(200).json({ ok:true });
    }
    return res.status(405).json({ error:'method_not_allowed' });
  }catch(e){
    return res.status(500).json({ error:'rank_failed' });
  }
}
