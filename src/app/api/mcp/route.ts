import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { server } from '@/lib/mcp/server';

// Maintain a global instance so that GET and POST use the same transport.
// Note: In a serverless production environment, stateful SSE requires caution,
// but works great for local Next.js deployments used for agentic workflows.
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});
let serverConnected = false;

async function ensureConnected() {
  if (!serverConnected) {
    await server.connect(transport);
    serverConnected = true;
  }
}

export async function GET(request: Request) {
  await ensureConnected();
  return transport.handleRequest(request);
}

export async function POST(request: Request) {
  await ensureConnected();
  return transport.handleRequest(request);
}
