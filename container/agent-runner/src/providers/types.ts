export interface AgentProvider {
  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /** Session ID to resume, if any. */
  sessionId?: string;

  /** Resume from a specific point in the session (provider-specific). */
  resumeAt?: string;

  /** Working directory inside the container. */
  cwd: string;

  /** MCP server configurations. */
  mcpServers: Record<string, McpServerConfig>;

  /** System prompt / developer instructions. */
  systemPrompt?: string;

  /** Environment variables for the SDK process. */
  env: Record<string, string | undefined>;

  /** Additional directories the agent can access. */
  additionalDirectories?: string[];
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string };
