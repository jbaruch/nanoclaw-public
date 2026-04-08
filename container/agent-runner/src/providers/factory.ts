import type { AgentProvider } from './types.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';

export type ProviderName = 'claude' | 'mock';

export function createProvider(name: ProviderName, opts?: { assistantName?: string }): AgentProvider {
  switch (name) {
    case 'claude':
      return new ClaudeProvider(opts);
    case 'mock':
      return new MockProvider();
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}
