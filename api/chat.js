export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // （任意）合言葉。当日だけ有効化したい場合はコメント解除。
  // ※フロントに合言葉を書く以上「完全な鍵」ではなく通せんぼ程度。本命の防波堤は spending limit（下記）。
  // if (req.headers['x-event-pass'] !== process.env.EVENT_PASS) {
  //   return res.status(401).json({ error: 'unauthorized' });
  // }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_api_key', message: 'Set GEMINI_API_KEY in your environment.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const promptText = messages
      .map((m) => `${m.role || 'user'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n\n');

    // ★変更: gemini-2.0-flash は2026/6/1に提供終了 → 現行モデルに更新。
    //   claude-* 等の非Geminiモデル名が来ても安全側に矯正する。
    let model = body.model || 'gemini-2.5-flash';
    if (!/^gemini/i.test(model)) model = 'gemini-2.5-flash';

    const wantJson = body.json === true || body.response_mime_type === 'application/json';
    const generationConfig = {
      temperature: body.temperature ?? 0.4,
      maxOutputTokens: body.max_tokens ?? 1024,
      // 2.5/3.x Flash は既定で思考にトークンを使い、JSONが空になることがある → 無効化
      thinkingConfig: { thinkingBudget: 0 },
    };
    if (wantJson) generationConfig.responseMimeType = 'application/json';
    if (wantJson && body.response_schema) generationConfig.responseSchema = body.response_schema;

    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: promptText || 'Hello' }],
        },
      ],
      generationConfig,
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await r.json();
    } catch {
      data = { error: { message: 'invalid_json_response' } };
    }

    if (!r.ok) {
      return res.status(r.status).json({
        error: 'gemini_error',
        message: data?.error?.message || 'gemini request failed',
        details: data,
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') || '';
    return res.status(200).json({
      content: [{ type: 'text', text }],
    });
  } catch (e) {
    return res.status(502).json({ error: 'proxy_failed', message: e.message });
  }
}

// 応答が10秒を超えてタイムアウトするようなら↓を有効化（プランにより上限あり）
// export const config = { maxDuration: 30 };