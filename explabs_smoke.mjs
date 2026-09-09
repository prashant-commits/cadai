#!/usr/bin/env node
// Smoke test for the Experiential Labs OpenAI-compatible gateway.
// Usage: node explabs_smoke.mjs [model]
// Reads EXPLABS_API_KEY from the environment, falling back to .env in this folder.
// The key is never printed.

import { readFileSync } from 'node:fs';

const BASE_URL = 'https://api.experientiallabs.ai/v1';
// Default to a $0 promotional model so a bare `node explabs_smoke.mjs` costs nothing.
const MODEL = process.argv[2] || 'qwen3.8-27b';

function loadKey() {
  if (process.env.EXPLABS_API_KEY) return process.env.EXPLABS_API_KEY;
  try {
    const env = readFileSync(new URL('.env', import.meta.url), 'utf8');
    const line = env.split('\n').find((l) => l.startsWith('EXPLABS_API_KEY='));
    if (line) return line.slice('EXPLABS_API_KEY='.length).trim();
  } catch {
    /* no .env, fall through */
  }
  return null;
}

const apiKey = loadKey();
if (!apiKey) {
  console.error('EXPLABS_API_KEY is not set (env or .env). Aborting.');
  process.exit(1);
}

const auth = { Authorization: `Bearer ${apiKey}` };

// Minimal body: model + messages only. No temperature / top_p / other sampling
// params -- some models reject them and the call fails as all_routes_failed (502).
const body = {
  model: MODEL,
  messages: [{ role: 'user', content: 'Reply with exactly: gateway ok' }],
};

console.log(`POST ${BASE_URL}/chat/completions`);
console.log(`model: ${MODEL}`);
console.log(`body:  ${JSON.stringify(body)}`);

const started = Date.now();
const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const elapsed = Date.now() - started;
const text = await res.text();

console.log(`\nHTTP ${res.status} ${res.statusText} in ${elapsed}ms`);

if (!res.ok) {
  console.error('FAILED. Response body:');
  console.error(text);
  process.exit(1);
}

const json = JSON.parse(text);
console.log('\n--- reply ---');
console.log(json.choices?.[0]?.message?.content ?? '(no content field)');
console.log('\n--- usage / billing ---');
console.log(JSON.stringify({ id: json.id, model: json.model, usage: json.usage }, null, 2));

// Cost is reported by the gateway when it chooses to; surface whatever it sends.
const costFields = Object.fromEntries(
  Object.entries(json).filter(([k]) => /cost|credit|price|charge/i.test(k)),
);
if (Object.keys(costFields).length) {
  console.log('\n--- cost fields returned by gateway ---');
  console.log(JSON.stringify(costFields, null, 2));
}
