// tests/helpers.js — テスト用のダブル（fetch / req / res / 時計）
// 実時間もネットワークも使わずに、再試行やタイムアウトの挙動を検証できるようにする。

import assert from 'node:assert/strict';

/** 同期関数が投げた例外を取り出す（assert.throws は例外を返さないため） */
export function expectThrow(fn, message = '例外が投げられませんでした') {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail(message);
}

/** 非同期関数が投げた例外を取り出す */
export async function expectReject(fn, message = 'reject されませんでした') {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail(message);
}

/** fetch が返す Response 風オブジェクト */
export function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

/** JSON として壊れている応答（text/html のエラーページなど） */
export function brokenJsonResponse(status, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  };
}

export function abortError() {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

export function networkError(code = 'ECONNRESET') {
  return Object.assign(new TypeError('fetch failed'), { code });
}

/**
 * 呼び出し回数分の応答を順番に返す fetch ダブル。
 * responders は Response 風オブジェクト、または (url, init) => Response 風 の関数。
 * 用意した数を超えて呼ばれた場合はエラーにして「再試行しすぎ」を検出する。
 */
export function createFetchDouble(responders) {
  const queue = [...responders];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url,
      init,
      headers: init.headers ?? {},
      signal: init.signal,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected extra fetch call (#${calls.length}) to ${url}`);
    }
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  fetchImpl.calls = calls;
  fetchImpl.remaining = () => queue.length;
  return fetchImpl;
}

/** abort されるまで解決しない fetch（タイムアウト検証用） */
export function hangingFetch() {
  return (url, init = {}) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return; // 永久に解決しない
      if (signal.aborted) return reject(abortError());
      signal.addEventListener('abort', () => reject(abortError()));
    });
}

/** 仮想時計。sleep は即座に解決し、経過時間だけ進める。 */
export function createFakeClock(start = 1_700_000_000_000) {
  let current = start;
  const waits = [];
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    async sleep(ms) {
      waits.push(ms);
      current += ms;
    },
    waits,
  };
}

/** ジッターを固定して待ち時間を決定的にする（0.5 + 0.5*random = 1.0 → 満額待つ） */
export const fixedRandom = () => 1;

export function createMockReq({ method = 'POST', headers = {}, body } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, headers: lower, body };
}

export function createMockRes() {
  return {
    statusCode: undefined,
    body: undefined,
    headers: {},
    ended: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.ended = true;
      return this;
    },
    end(payload) {
      this.ended = true;
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
}

/** ログ収集用のシンク */
export function createLogSink() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(JSON.parse(line)),
    error: (line) => lines.push(JSON.parse(line)),
    find: (event) => lines.find((l) => l.event === event),
    text: () => lines.map((l) => JSON.stringify(l)).join('\n'),
  };
}

/** Gemini の正常応答（本文つき） */
export function geminiOk(text, extra = {}) {
  return {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', ...extra }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45, totalTokenCount: 165 },
    modelVersion: 'gemini-2.5-flash',
  };
}

/** Gemini のエラー応答 */
export function geminiError(code, status, message, details) {
  return { error: { code, status, message, ...(details ? { details } : {}) } };
}

export const VALID_BODY = {
  model: 'gemini-2.5-flash',
  max_tokens: 800,
  json: true,
  messages: [{ role: 'user', content: 'こんにちは、面談を始めましょう。' }],
};
