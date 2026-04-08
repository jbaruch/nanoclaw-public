import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { writeMessageOut } from './db/messages-out.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start the MCP server with NanoClaw tools.
 * Reads the session DB path from SESSION_DB_PATH env var.
 * Routing context is passed via env vars from the poll loop.
 */
export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'send_message',
        description: 'Send a chat message to the current conversation or a specified destination.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', description: 'Message content' },
            channel: { type: 'string', description: 'Target channel type (default: reply to origin)' },
            platformId: { type: 'string', description: 'Target platform ID' },
            threadId: { type: 'string', description: 'Target thread ID' },
          },
          required: ['text'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'send_message') {
      const text = args?.text as string;
      if (!text) {
        return { content: [{ type: 'text', text: 'Error: text is required' }] };
      }

      const id = generateId();
      const platformId = (args?.platformId as string) || process.env.NANOCLAW_PLATFORM_ID || null;
      const channelType = (args?.channel as string) || process.env.NANOCLAW_CHANNEL_TYPE || null;
      const threadId = (args?.threadId as string) || process.env.NANOCLAW_THREAD_ID || null;

      writeMessageOut({
        id,
        kind: 'chat',
        platform_id: platformId,
        channel_type: channelType,
        thread_id: threadId,
        content: JSON.stringify({ text }),
      });

      log(`send_message: ${id} → ${channelType || 'default'}/${platformId || 'default'}`);
      return { content: [{ type: 'text', text: `Message sent (id: ${id})` }] };
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server started');
}

// Run as standalone process
startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
