import * as fs from 'fs';
import { z } from 'zod';
import { AssemblySpecSchema } from './src/lib/agent/assembly-spec';
const KEY = (fs.readFileSync('.env','utf8').split('\n').find(l=>l.startsWith('EXPLABS_API_KEY='))||'').slice(16).trim();
const schema: any = z.toJSONSchema(AssemblySpecSchema); delete schema.$schema;
const res = await fetch('https://api.experientiallabs.ai/v1/chat/completions', { method:'POST',
  headers:{ Authorization:`Bearer ${KEY}`,'Content-Type':'application/json' },
  body: JSON.stringify({ model:'gpt-5.6-luna', messages:[{role:'user',content:'A 40x30x25 bracket.'}],
    response_format:{ type:'json_schema', json_schema:{ name:'assembly_spec', schema } } }) });
console.log('HTTP', res.status, '\n', (await res.text()).slice(0, 700));
