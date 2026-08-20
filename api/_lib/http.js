// api/_lib/http.js — req/res まわりの薄い補助。Vercel の res でも素の http.ServerResponse でも動く。

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { apiError } from './errors.js';

export const MAX_BODY_BYTES = 256 * 1024;

/** ヘッダ値を1つ取り出す（配列で来る場合は先頭） */
export function headerValue(req, name) {
  const v = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * リクエストIDを決める。呼び出し元が x-request-id を付けていれば引き継ぐ（ログの突合用）。
 * 想定外の文字は落とす。
 */
export function resolveRequestId(req) {
  const incoming = headerValue(req, 'x-request-id');
  if (typeof incoming === 'string') {
    const cleaned = incoming.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    if (cleaned.length >= 8) return cleaned;
  }
  return randomUUID();
}

/**
 * ボディを JSON として読む。
 * Vercel は req.body を解析済みで渡してくるが、文字列/Buffer/ストリームのいずれでも動くようにしておく。
 */
export async function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  const declared = Number(headerValue(req, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw apiError('payload_too_large', { details: { contentLength: declared, limit: maxBytes } });
  }

  const raw = req?.body;

  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'string') return parseJson(raw);
    if (isBufferLike(raw)) return parseJson(bufferToString(raw, maxBytes));
    if (typeof raw === 'object') return raw; // Vercel が解析済み
    throw apiError('invalid_json', { details: { reason: `unsupported_body_type:${typeof raw}` } });
  }

  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = isBufferLike(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > maxBytes) {
        throw apiError('payload_too_large', { details: { limit: maxBytes } });
      }
      chunks.push(buf);
    }
    return parseJson(Buffer.concat(chunks).toString('utf8'));
  }

  return {};
}

function isBufferLike(v) {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(v);
}

function bufferToString(buf, maxBytes) {
  if (buf.length > maxBytes) {
    throw apiError('payload_too_large', { details: { size: buf.length, limit: maxBytes } });
  }
  return buf.toString('utf8');
}

function parseJson(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw apiError('invalid_json', { details: { reason: e.message.slice(0, 120) }, cause: e });
  }
}

/** JSON を返す。body が null のときは本文なし（204 等）。 */
export function sendJson(res, status, body, headers = {}) {
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    if (typeof res.setHeader === 'function') res.setHeader(key, value);
  }
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    const r = res.status(status);
    return body === null ? r.end() : r.json(body);
  }
  // 素の Node http へのフォールバック
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, body === null ? {} : { 'content-type': 'application/json; charset=utf-8' });
  }
  return res.end(body === null ? undefined : JSON.stringify(body));
}

/**
 * 合言葉（EVENT_PASS）検証。環境変数が未設定なら検証しない＝従来どおり誰でも使える。
 * 比較はタイミング攻撃を避けるため定数時間で行う。
 */
export function verifyEventPass(req, expected) {
  if (!expected) return;
  const got = headerValue(req, 'x-event-pass');
  if (typeof got !== 'string' || !safeEqual(got, expected)) {
    throw apiError('unauthorized', { details: { header: 'x-event-pass' } });
  }
}

/**
 * 運営用の合言葉照合。EVENT_PASS と違い「未設定なら素通し」にはしない。
 * 記録の全消去のような取り返しのつかない操作を、設定漏れのまま通してしまわないため、
 * expected が空なら常に false（＝拒否）を返す。比較は定数時間で行う。
 */
export function matchesSecret(req, header, expected) {
  if (!expected) return false;
  const got = headerValue(req, header);
  return typeof got === 'string' && safeEqual(got, expected);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // 長さが違う時点で不一致だが、比較コストを揃えるためダミー比較しておく
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** 構造化ログ（1行JSON）。プロンプト本文は載せない＝個人情報と鍵の混入を防ぐ。 */
export function createLogger(sink = console) {
  return function log(level, event) {
    const line = JSON.stringify({ level, ...event });
    if (level === 'error') sink.error(line);
    else sink.log(line);
  };
}
