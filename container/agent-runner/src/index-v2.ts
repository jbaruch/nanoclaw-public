/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config:
 *   - SESSION_DB_PATH: path to session SQLite DB (default: /workspace/session.db)
 *   - AGENT_PROVIDER: 'claude' | 'mock' (default: claude)
 *   - NANOCLAW_ASSISTANT_NAME: assistant name for transcript archiving
 *   - NANOCLAW_ADMIN_USER_ID: admin user ID for permission checks
 *
 * Mount structure:
 *   /workspace/
 *     session.db        ← session SQLite DB
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, skills, working files)
 *     .claude/          ← Claude SDK session data
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';
const GLOBAL_CLAUDE_MD = '/workspace/global/CLAUDE.md';

async function main(): Promise<void> {
  const providerName = (process.env.AGENT_PROVIDER || 'claude') as ProviderName;
  const assistantName = process.env.NANOCLAW_ASSISTANT_NAME;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  const provider = createProvider(providerName, { assistantName });

  // Load global CLAUDE.md as additional system context
  let systemPrompt: string | undefined;
  if (fs.existsSync(GLOBAL_CLAUDE_MD)) {
    systemPrompt = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf-8');
    log('Loaded global CLAUDE.md');
  }

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools.js');

  // SDK env
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  await runPollLoop({
    provider,
    cwd: CWD,
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          SESSION_DB_PATH: process.env.SESSION_DB_PATH || '/workspace/session.db',
        },
      },
    },
    systemPrompt,
    env,
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
