// SPDX-License-Identifier: BUSL-1.1
/**
 * The site's models (server/ai.ts): Azure OpenAI when it is configured, OpenRouter otherwise; requests shaped for
 * reasoning deployments; the rules agent's reply language decided on the server, not left to the model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { aiBody, aiTarget, isReasoning, languageOf } from '../server/ai.ts';
import { assistPolicy } from '../server/policy-assist.ts';
import type { Policy } from '../server/policy.ts';

test('Azure first, OpenRouter as the fallback, nothing without a key', () => {
  assert.equal(aiTarget('rules', {}), null);
  const or = aiTarget('rules', { OPENROUTER_API_KEY: 'k' })!;
  assert.equal(or.provider, 'openrouter');
  assert.equal(or.headers.Authorization, 'Bearer k');
  const az = aiTarget('rules', { OPENROUTER_API_KEY: 'k', AZURE_OPENAI_API_KEY: 'a', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/openai/v1/', AZURE_OPENAI_RULES_MODEL: 'gpt-5.2' })!;
  assert.deepEqual([az.provider, az.url, az.headers['api-key'], az.model, az.reasoning], ['azure', 'https://x.openai.azure.com/openai/v1/chat/completions', 'a', 'gpt-5.2', true]);
  assert.equal(aiTarget('chat', { AZURE_OPENAI_API_KEY: 'a', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/openai/v1', AZURE_OPENAI_CHAT_MODEL: 'gpt-5.2-chat' })!.reasoning, false);
});

test('a reasoning deployment gets room to think and no temperature; others keep theirs', () => {
  assert.ok(isReasoning('gpt-5.2') && isReasoning('o4-mini') && !isReasoning('gpt-4.1') && !isReasoning('gpt-5-chat'));
  const m = [{ role: 'user', content: 'hi' }];
  const r = aiBody({ provider: 'azure', url: '', headers: {}, model: 'gpt-5.2', reasoning: true }, { messages: m, maxTokens: 100, temperature: 0.1, json: true, effort: 'medium' }) as Record<string, unknown>;
  assert.deepEqual([r.max_completion_tokens, r.temperature, r.reasoning_effort, r.response_format], [400, undefined, 'medium', { type: 'json_object' }]);
  const c = aiBody({ provider: 'openrouter', url: '', headers: {}, model: 'x', reasoning: false }, { messages: m, maxTokens: 100, temperature: 0.4, stream: true }) as Record<string, unknown>;
  assert.deepEqual([c.max_tokens, c.temperature, c.stream], [100, 0.4, true]);
});

test('the language of a request', () => {
  assert.equal(languageOf('Never ask real people for a passkey'), 'English');
  assert.equal(languageOf('Agentlər balansı görsün amma məbləğ gizli olsun'), 'Azerbaijani');
  assert.equal(languageOf('Пусть агенты не видят баланс'), 'Russian');
  assert.equal(languageOf('Ajanlar bakiyeyi görmesin, kişiler şifre girsin'), 'Turkish');
  assert.equal(languageOf('Que los agentes no vean el saldo'), 'Spanish');
  assert.equal(languageOf('kontaktların exportunu da eyni et'), 'Azerbaijani', 'no ə, still Azerbaijani');
  assert.equal(languageOf('Bütün qaydaları sərtləşdir'), 'Azerbaijani');
  assert.equal(languageOf('Kişilerin dışa aktarımını da aynı yap'), 'Turkish');
  assert.equal(languageOf('Yapay zeka ajanları para transferi yapamasın'), 'Turkish');
  assert.equal(languageOf('ok'), null);
});

test('the rules agent on Azure: the key in api-key, the language named, the rules last', async () => {
  let seen: { headers: Record<string, unknown>; body: { model: string; messages: { role: string; content: string }[]; max_completion_tokens?: number; temperature?: number } } | null = null;
  const fake = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      seen = { headers: req.headers, body: JSON.parse(b) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: 'Real people already pass everywhere.', edits: [], enforcement: null, needsCode: null }) } }] }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const keep = { ...process.env };
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'az-test', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/openai/v1', AZURE_OPENAI_RULES_MODEL: 'gpt-5.2', ONEHUMAN_ASSIST_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/` });
  delete process.env.OPENROUTER_API_KEY;
  try {
    const draft: Policy = { version: 'v', enforcement: 'enforce', rules: [{ resource: 'balance.read', title: 'Balance', onAgent: 'mask', onArtifact: 'mask', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['verified'], minScore: 65 }] };
    const a = await assistPolicy(draft, 'Never ask real people for a passkey', [{ role: 'user', text: 'hide balances' }, { role: 'assistant', text: 'Done.' }]);
    assert.equal(a.reply, 'Real people already pass everywhere.');
    assert.equal(a.proposed, null);
    assert.equal(seen!.headers['api-key'], 'az-test');
    assert.equal(seen!.headers.authorization, undefined, 'no OpenRouter header');
    assert.equal(seen!.body.model, 'gpt-5.2');
    assert.equal(seen!.body.temperature, undefined);
    assert.ok(seen!.body.max_completion_tokens! >= 1500);
    assert.deepEqual(seen!.body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.match(seen!.body.messages.at(-1)!.content, /Reply in: English$/);
  } finally {
    for (const k of ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_RULES_MODEL', 'ONEHUMAN_ASSIST_URL']) delete process.env[k];
    Object.assign(process.env, keep);
    fake.close();
  }
});

test('when Azure does not answer, OpenRouter does', async () => {
  const calls: string[] = [];
  const fake = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const azure = !!req.headers['api-key'];
      calls.push(azure ? 'azure' : 'openrouter');
      if (azure) { res.writeHead(500); res.end('{"error":"busy"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: 'From the fallback.', edits: [], enforcement: null, needsCode: null }) } }] }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
  const keep = { ...process.env };
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'az', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/openai/v1', OPENROUTER_API_KEY: 'or', ONEHUMAN_ASSIST_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/` });
  try {
    const draft: Policy = { version: 'v', enforcement: 'enforce', rules: [{ resource: 'balance.read', title: 'Balance', onAgent: 'mask', onArtifact: 'mask', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['verified'], minScore: 65 }] };
    assert.equal((await assistPolicy(draft, 'hide balances')).reply, 'From the fallback.');
    assert.deepEqual(calls, ['azure', 'openrouter']);
  } finally {
    for (const k of ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'OPENROUTER_API_KEY', 'ONEHUMAN_ASSIST_URL']) delete process.env[k];
    Object.assign(process.env, keep);
    fake.close();
  }
});
