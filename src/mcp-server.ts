#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './lib/mcp/server.js';

// Connect stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CAD AI MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error in CAD AI MCP Server:', err);
  process.exit(1);
});
