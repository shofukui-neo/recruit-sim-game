// tests/request.test.js — リクエスト検証（normalizeChatRequest）とペイロード生成（buildGeminiPayload）

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MODEL, LIMITS, buildGeminiPayload, normalizeChatRequest } from '../api/_lib/gemini.js';
import { expectThrow } from './helpers.js';

const msg = (content, role = 'user') => ({ role, content });
const base = (overrides = {}) => ({ messages: [msg('テスト発言')], ...overrides });

/** 検証エラーの共通アサーション */
function assertInvalid(body, field, expectedCode = 'invalid_request') {
  const err = expectThrow(() => normalizeChatRequest(body));
  assert.equal(err.code, expectedCode, `code (${field})`);
  assert.equal(err.status, expectedCode === 'payload_too_large' ? 413 : 400);
  assert.equal(err.retryable, false);
  if (field) assert.equal(err.details.field, field);
  return err;
}

// --- 正常系 ---------------------------------------------------------------

test('最小構成のリクエストを正規化できる', () => {
  const n = normalizeChatRequest(base());
  assert.equal(n.model, DEFAULT_MODEL);
  assert.equal(n.prompt, 'user: テスト発言');
  assert.equal(n.temperature, 0.4);
  assert.equal(n.maxOutputTokens, 1024);
  assert.equal(n.thinkingBudget, 0);
  assert.equal(n.wantJson, false);
  assert.equal(n.messageCount, 1);
  assert.equal(n.promptChars, n.prompt.length);
  assert.deepEqual(n.warnings, []);
});

test('複数メッセージは "role: content" を空行区切りで連結する（従来挙動を維持）', () => {
  const n = normalizeChatRequest(
    base({ messages: [msg('一つ目'), msg('二つ目', 'assistant'), { content: 'roleなし' }] }),
  );
  assert.equal(n.prompt, 'user: 一つ目\n\nassistant: 二つ目\n\nuser: roleなし');
  assert.equal(n.messageCount, 3);
});

test('content がオブジェクト・配列なら JSON 文字列化する', () => {
  const n = normalizeChatRequest(base({ messages: [msg({ a: 1 }), msg([1, 2])] }));
  assert.equal(n.prompt, 'user: {"a":1}\n\nuser: [1,2]');
});

test('json:true / response_mime_type のどちらでも JSON モードになる', () => {
  assert.equal(normalizeChatRequest(base({ json: true })).wantJson, true);
  assert.equal(normalizeChatRequest(base({ response_mime_type: 'application/json' })).wantJson, true);
  assert.equal(normalizeChatRequest(base({ json: false })).wantJson, false);
});

test('temperature / max_tokens / thinking_budget の境界値を受け付ける', () => {
  const n = normalizeChatRequest(base({ temperature: 0, max_tokens: 1, thinking_budget: 0 }));
  assert.equal(n.temperature, 0);
  assert.equal(n.maxOutputTokens, 1);
  const m = normalizeChatRequest(
    base({ temperature: LIMITS.maxTemperature, max_tokens: LIMITS.maxOutputTokens, thinking_budget: 128 }),
  );
  assert.equal(m.temperature, 2);
  assert.equal(m.maxOutputTokens, LIMITS.maxOutputTokens);
  assert.equal(m.thinkingBudget, 128);
});

test('プロンプト長の上限ちょうどは通す', () => {
  const filler = 'あ'.repeat(LIMITS.maxPromptChars - 'user: '.length);
  const n = normalizeChatRequest(base({ messages: [msg(filler)] }));
  assert.equal(n.promptChars, LIMITS.maxPromptChars);
});

// --- model ----------------------------------------------------------------

test('gemini 以外のモデル名は既定モデルへ矯正し、警告を残す', () => {
  const n = normalizeChatRequest(base({ model: 'claude-sonnet-5' }));
  assert.equal(n.model, DEFAULT_MODEL);
  assert.deepEqual(n.warnings, [{ code: 'model_coerced', from: 'claude-sonnet-5', to: DEFAULT_MODEL }]);
});

test('model のURL注入・パストラバーサルを拒否する', () => {
  for (const bad of [
    'gemini-2.5-flash?key=leak',
    'gemini/../../v1/models/x',
    'gemini-2.5-flash:generateContent#',
    'gemini 2.5 flash',
    'gemini-2.5-flash&alt=sse',
    'gemini%2Fevil',
  ]) {
    const err = assertInvalid(base({ model: bad }), 'model');
    assert.match(err.message, /model/);
  }
});

test('model が長すぎる / 空 / 文字列でない場合を拒否する', () => {
  assertInvalid(base({ model: 'g'.repeat(LIMITS.maxModelNameLength + 1) }), 'model');
  assertInvalid(base({ model: '   ' }), 'model');
  assertInvalid(base({ model: 123 }), 'model');
  // null は「未指定」として扱う
  assert.equal(normalizeChatRequest(base({ model: null })).model, DEFAULT_MODEL);
});

// --- messages -------------------------------------------------------------

test('messages が無い / 配列でない / 空配列を拒否する', () => {
  assertInvalid({}, 'messages');
  assertInvalid({ messages: 'テキスト' }, 'messages');
  assertInvalid({ messages: {} }, 'messages');
  assertInvalid({ messages: [] }, 'messages');
});

test('messages が多すぎる場合を拒否する', () => {
  const many = Array.from({ length: LIMITS.maxMessages + 1 }, (_, i) => msg(`m${i}`));
  const err = assertInvalid({ messages: many }, 'messages');
  assert.equal(err.details.count, LIMITS.maxMessages + 1);
});

test('個々のメッセージの不備は index つきで報告する', () => {
  assertInvalid({ messages: [msg('ok'), 'テキスト'] }, 'messages[1]');
  assertInvalid({ messages: [msg('ok'), { role: 'user' }] }, 'messages[1].content');
  assertInvalid({ messages: [{ content: null }] }, 'messages[0].content');
  assertInvalid({ messages: [msg('   ')] }, 'messages[0].content');
  assertInvalid({ messages: [{ role: 42, content: 'x' }] }, 'messages[0].role');
});

test('循環参照を含む content は文字列化できないとして拒否する', () => {
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  assertInvalid({ messages: [msg(cyclic)] }, 'messages[0].content');
});

test('プロンプトが上限を超えたら payload_too_large', () => {
  const filler = 'あ'.repeat(LIMITS.maxPromptChars);
  const err = assertInvalid(base({ messages: [msg(filler)] }), 'messages', 'payload_too_large');
  assert.equal(err.details.limit, LIMITS.maxPromptChars);
  assert.ok(err.details.promptChars > LIMITS.maxPromptChars);
});

// --- 生成パラメータ -------------------------------------------------------

test('temperature の型・範囲違反を拒否する', () => {
  for (const bad of ['0.5', NaN, Infinity, -0.1, 2.1, true, {}]) {
    assertInvalid(base({ temperature: bad }), 'temperature');
  }
  assert.equal(normalizeChatRequest(base({ temperature: null })).temperature, 0.4, 'null は既定値');
});

test('max_tokens の型・範囲違反を拒否する', () => {
  for (const bad of [0, -1, 1.5, '800', LIMITS.maxOutputTokens + 1]) {
    assertInvalid(base({ max_tokens: bad }), 'max_tokens');
  }
});

test('thinking_budget の範囲違反を拒否する', () => {
  assertInvalid(base({ thinking_budget: -1 }), 'thinking_budget');
  assertInvalid(base({ thinking_budget: LIMITS.maxThinkingBudget + 1 }), 'thinking_budget');
});

test('json / response_mime_type の型違反を拒否する', () => {
  assertInvalid(base({ json: 'true' }), 'json');
  assertInvalid(base({ response_mime_type: 1 }), 'response_mime_type');
});

test('response_schema はオブジェクトのみ、かつ json:true のときだけ有効', () => {
  assertInvalid(base({ json: true, response_schema: 'object' }), 'response_schema');
  const withJson = normalizeChatRequest(base({ json: true, response_schema: { type: 'object' } }));
  assert.deepEqual(withJson.responseSchema, { type: 'object' });

  const withoutJson = normalizeChatRequest(base({ response_schema: { type: 'object' } }));
  assert.equal(withoutJson.responseSchema, undefined);
  assert.equal(withoutJson.warnings[0].code, 'response_schema_ignored');
});

test('body 自体がオブジェクトでない場合を拒否する', () => {
  assertInvalid(null, 'body');
  assertInvalid([], 'body');
  assertInvalid('文字列', 'body');
});

// --- ペイロード生成 -------------------------------------------------------

test('buildGeminiPayload: contents と generationConfig を組み立てる', () => {
  const n = normalizeChatRequest(base({ temperature: 0.7, max_tokens: 512 }));
  const payload = buildGeminiPayload(n);
  assert.deepEqual(payload.contents, [{ role: 'user', parts: [{ text: 'user: テスト発言' }] }]);
  assert.equal(payload.generationConfig.temperature, 0.7);
  assert.equal(payload.generationConfig.maxOutputTokens, 512);
  assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(payload.generationConfig.responseMimeType, undefined);
});

test('buildGeminiPayload: JSON モードで responseMimeType / responseSchema を付ける', () => {
  const schema = { type: 'object', properties: { reply: { type: 'string' } } };
  const payload = buildGeminiPayload(normalizeChatRequest(base({ json: true, response_schema: schema })));
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(payload.generationConfig.responseSchema, schema);
});

test('buildGeminiPayload: pro 系モデルには thinkingConfig を送らない（0を受け付けないため）', () => {
  const payload = buildGeminiPayload(normalizeChatRequest(base({ model: 'gemini-2.5-pro' })));
  assert.equal(payload.generationConfig.thinkingConfig, undefined);
  const flash = buildGeminiPayload(normalizeChatRequest(base({ model: 'gemini-2.5-flash' })));
  assert.deepEqual(flash.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});
