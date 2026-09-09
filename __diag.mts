import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import * as fs from 'fs';

// Minimal .env parse, no dotenv dependency needed
const envRaw = fs.readFileSync('.env', 'utf8');
for (const line of envRaw.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const key = process.env.GOOGLE_API_KEY;
console.log('key present:', !!key, 'len:', key?.length);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ]);
}

async function main() {
  const model = new ChatGoogleGenerativeAI({ apiKey: key, model: 'gemini-3.6-flash', temperature: 0.2, maxOutputTokens: 256 });

  console.log('--- plain text invoke ---');
  const t0 = Date.now();
  try {
    const r = await withTimeout(model.invoke('Say the word PONG and nothing else.'), 20000, 'plain invoke');
    console.log('OK in', Date.now() - t0, 'ms. content:', r.content);
  } catch (e: any) {
    console.log('FAILED after', Date.now() - t0, 'ms:', e.message);
  }
}
main();
