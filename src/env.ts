import fs from 'fs';
import path from 'path';

// env.ts deliberately does NOT import the logger. Doing so creates an
// import cycle:
//   config.ts → env.ts → logger.ts → host-logs.ts → config.ts
// Under vitest's parallel-worker isolation that cycle resolves to a
// partially-initialized `logger` (TypeError: Cannot read properties
// of undefined (reading 'debug') the first time `readEnvFile` is
// called from inside the cycle). We use process.stderr directly for
// the single debug-level message env.ts emits — the timestamp/format
// logger normally adds isn't load-bearing for a missing-.env note,
// and the explicit prefix below makes it clear where the line came
// from when reading raw stderr.
const ENV_DEBUG_ENABLED =
  (process.env.LOG_LEVEL || 'info') === 'debug' ||
  (process.env.LOG_LEVEL || 'info') === 'trace';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    if (ENV_DEBUG_ENABLED) {
      process.stderr.write(
        `[env] .env file not found at ${envFile}, using defaults\n`,
      );
    }
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
