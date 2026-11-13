import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// #1731: a thinking model asked for a small max_tokens (a client's "test
// connection" probe sends max_tokens=4) spends the whole output budget on
// reasoning and never reaches visible text. The stream used to end with
// nothing but reasoning_content deltas and the turn was failed out with an
// empty_completion error — which an OpenAI-compatible client reads as the
// model refusing to answer. The non-stream path already folds reasoning into
// content (normalizeChoices); the stream path now mirrors it.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* SSE body */ }
  return { status: res.status, body: json, raw, headers: res.headers };
}

// A reasoning model that ran out of budget: reasoning deltas only, then a
// 'length' finish — no visible text ever reaches the client.
async function* reasoningOnlyStream() {
  yield { choices: [{ delta: { role: 'assistant', reasoning_content: 'thinking ' } }] };
  yield { choices: [{ delta: { reasoning_content: 'about it' } }] };
  yield { choices: [{ delta: {}, finish_reason: 'length' }] };
}

// A stream with neither content nor reasoning: still a genuine empty
// completion and must keep failing over.
async function* trulyEmptyStream() {
  yield { choices: [{ delta: { role: 'assistant' } }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

async function* goodStream() {
  yield { choices: [{ delta: { content: 'streamed ' } }] };
  yield { choices: [{ delta: { content: 'answer' } }] };
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
}

describe('Reasoning-only stream folds into content (#1731)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    getDb().prepare('DELETE FROM requests').run();
  });

  it('serves the reasoning as content instead of failing the turn out', async () => {
    streamChatCompletion.mockReturnValueOnce(reasoningOnlyStream());

    const { status, raw } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 4,
    }, key);

    expect(status).toBe(200);
    // The reasoning is now the answer the client can read.
    expect(raw).toContain('thinking about it');
    expect(raw).toContain('[DONE]');
    // No failure frame: the turn succeeded, it did not get refused.
    expect(raw).not.toContain('stream_error');
    expect(raw).not.toContain('empty completion');
    // A reasoning-only turn is a good turn — no failover was needed.
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);

    const rows = getDb().prepare('SELECT status, error FROM requests ORDER BY id').all() as Array<{ status: string; error: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
  });

  it('still fails over when the stream has neither content nor reasoning', async () => {
    streamChatCompletion
      .mockReturnValueOnce(trulyEmptyStream())
      .mockReturnValueOnce(goodStream());

    const { status, raw } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, key);

    expect(status).toBe(200);
    expect(raw).toContain('streamed ');
    expect(raw).toContain('"content":"answer"');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('a normal content stream is unaffected', async () => {
    streamChatCompletion.mockReturnValueOnce(goodStream());

    const { status, raw } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, key);

    expect(status).toBe(200);
    expect(raw).toContain('streamed ');
    expect(raw).toContain('"content":"answer"');
    expect(raw).toContain('[DONE]');
    expect(streamChatCompletion).toHaveBeenCalledTimes(1);
  });
});
