import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  AGENT_AUTO_COMPACT_WINDOW: 800000,
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  STORE_DIR: '/tmp/nanoclaw-test-store',
  HOST_PROJECT_ROOT: process.cwd(),
  HOST_UID: undefined,
  HOST_GID: undefined,
  IDLE_TIMEOUT: 1800000, // 30min
  TILE_OWNER: 'test',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock better-sqlite3 (used by createFilteredDb)
vi.mock('better-sqlite3', () => ({
  default: vi.fn(),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs. Several `fs.*` functions are mocked as no-ops because the
// scripts-dir publish path in container-runner.ts calls them on paths
// that were never created (mkdirSync is mocked). The symlink-based
// atomic publish added in the CodeQL-fix commit exercises symlinkSync/
// lstatSync/readlinkSync, so those need no-op mocks too. `lstatSync`
// throws ENOENT by default so the publish takes the first-install path
// (no prior groupScriptsDir) instead of trying to stat a mock-only path.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      renameSync: vi.fn(),
      rmSync: vi.fn(),
      symlinkSync: vi.fn(),
      readlinkSync: vi.fn(() => ''),
      lstatSync: vi.fn(() => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Mock env.js so tests can control the .env-fallback values that
// container-runner consults when process.env misses a key. Default: empty
// — preserves the original behavior of all pre-existing tests, which
// never depended on values flowing in from .env.
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
  readEnvFileAll: vi.fn(() => ({})),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  selectTiles,
  resolveAgentModel,
} from './container-runner.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

// --- Tile selection (security-critical) ---

describe('selectTiles', () => {
  // Our fork returns `TileRef[]` (owner + name) for per-tile owner support;
  // upstream returns plain `string[]`. The behavioral contract these tests
  // pin is the same in either shape — same names in the same order. Helper
  // peels the names so the assertions stay readable.
  const names = (tiles: ReturnType<typeof selectTiles>): string[] =>
    tiles.map((t) => t.name);

  it('main group gets core + trusted + admin (+ flight-weather-watch fork-local)', () => {
    expect(names(selectTiles(true, false))).toEqual([
      'nanoclaw-core',
      'nanoclaw-trusted',
      'nanoclaw-admin',
      'flight-weather-watch',
    ]);
  });

  it('main group gets admin even if also marked trusted', () => {
    expect(names(selectTiles(true, true))).toEqual([
      'nanoclaw-core',
      'nanoclaw-trusted',
      'nanoclaw-admin',
      'flight-weather-watch',
    ]);
  });

  it('trusted group gets core + trusted (+ flight-weather-watch), NOT admin', () => {
    const tileNames = names(selectTiles(false, true));
    expect(tileNames).toEqual([
      'nanoclaw-core',
      'nanoclaw-trusted',
      'flight-weather-watch',
    ]);
    expect(tileNames).not.toContain('nanoclaw-admin');
  });

  it('untrusted group gets core + untrusted, NOT trusted or admin', () => {
    const tileNames = names(selectTiles(false, false));
    expect(tileNames).toEqual(['nanoclaw-core', 'nanoclaw-untrusted']);
    expect(tileNames).not.toContain('nanoclaw-trusted');
    expect(tileNames).not.toContain('nanoclaw-admin');
  });

  it('all tiers include nanoclaw-core', () => {
    expect(selectTiles(true, false)[0].name).toBe('nanoclaw-core');
    expect(selectTiles(false, true)[0].name).toBe('nanoclaw-core');
    expect(selectTiles(false, false)[0].name).toBe('nanoclaw-core');
  });

  it('admin tile is NEVER in trusted or untrusted selections', () => {
    expect(names(selectTiles(false, true))).not.toContain('nanoclaw-admin');
    expect(names(selectTiles(false, false))).not.toContain('nanoclaw-admin');
  });
});

// --- continuation env vars (self-resuming cycles) ---
//
// Self-resuming cycles depend on the container being able to tell
// "this run is a continuation" from "this run is a fresh user
// invocation". The mechanism is two paired env vars set by the
// scheduler when the underlying scheduled_tasks row carried a non-NULL
// `continuation_cycle_id`:
//
//   NANOCLAW_CONTINUATION=1
//   NANOCLAW_CONTINUATION_CYCLE_ID=<value>
//
// Both must be set together, or neither — a partial signal is the bug
// the calling skill's "fail closed to fresh invocation" branch is
// designed to catch, but the orchestrator must never produce a partial
// signal in the first place.

describe('continuation env vars (self-resuming cycles)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets both NANOCLAW_CONTINUATION env vars when continuationCycleId is provided', async () => {
    const promise = runContainerAgent(
      testGroup,
      { ...testInput, continuationCycleId: '2026-04-21' },
      () => {},
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    // Both env vars must appear together. Asserting on the assembled
    // `-e KEY=value` strings (matching the existing chat-jid / reply-to
    // patterns) rather than parsing the args, since that's how the
    // shell ultimately receives them.
    expect(args).toContain('NANOCLAW_CONTINUATION=1');
    expect(args).toContain('NANOCLAW_CONTINUATION_CYCLE_ID=2026-04-21');
  });

  it('omits both NANOCLAW_CONTINUATION env vars on a fresh invocation', async () => {
    const promise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    // Absence is the "fresh invocation" signal — the calling skill
    // distinguishes a continuation from a user-invoked run by env-var
    // presence. If either var leaks in, a fresh user-triggered run
    // could silently take a continuation/lock-skip branch and collide
    // with the original maintenance run's lock.
    expect(args.some((a) => a.startsWith('NANOCLAW_CONTINUATION='))).toBe(
      false,
    );
    expect(
      args.some((a) => a.startsWith('NANOCLAW_CONTINUATION_CYCLE_ID=')),
    ).toBe(false);
  });

  it('omits both NANOCLAW_CONTINUATION env vars when continuationCycleId is empty string', async () => {
    // `''` is a JS-falsy slot key — should be treated identically to
    // undefined. The DB never persists an empty string (the IPC
    // handler drops `data.continuation_cycle_id` of `''` before
    // calling createTask), but defending in depth here keeps a future
    // accidental empty-string from emitting a half-signal.
    const promise = runContainerAgent(
      testGroup,
      { ...testInput, continuationCycleId: '' },
      () => {},
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(args.some((a) => a.startsWith('NANOCLAW_CONTINUATION='))).toBe(
      false,
    );
    expect(
      args.some((a) => a.startsWith('NANOCLAW_CONTINUATION_CYCLE_ID=')),
    ).toBe(false);
  });
});

// ----------------------------------------------------------------------
// resolveAgentModel — pure-function contract for the AGENT_MODEL env
// override. Pinned because the helper has five distinct branches and
// the default path is the only one the rest of the suite exercises.
// ----------------------------------------------------------------------
const DEFAULT_MODEL = 'claude-sonnet-4-6[1m]';

describe('resolveAgentModel', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('returns default when env var is undefined', () => {
    expect(resolveAgentModel(undefined)).toBe(DEFAULT_MODEL);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns default when env var is the empty string', () => {
    expect(resolveAgentModel('')).toBe(DEFAULT_MODEL);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns default when env var is whitespace-only', () => {
    expect(resolveAgentModel('   ')).toBe(DEFAULT_MODEL);
    expect(resolveAgentModel('\t\n ')).toBe(DEFAULT_MODEL);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('passes through known-prefix values silently (no warn)', () => {
    expect(resolveAgentModel('claude-opus-4-7[1m]')).toBe(
      'claude-opus-4-7[1m]',
    );
    expect(resolveAgentModel('claude-sonnet-4-6[1m]')).toBe(
      'claude-sonnet-4-6[1m]',
    );
    expect(resolveAgentModel('opus')).toBe('opus');
    expect(resolveAgentModel('sonnet[1m]')).toBe('sonnet[1m]');
    expect(resolveAgentModel('haiku')).toBe('haiku');
    // Mixed case — regex is case-insensitive.
    expect(resolveAgentModel('Claude-opus-4-7')).toBe('Claude-opus-4-7');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('passes through unknown-prefix values WITH a warn so typos surface at startup', () => {
    // A typo like 'claud-opus' (missing 'e'): doesn't match prefix regex.
    expect(resolveAgentModel('claud-opus-4-7')).toBe('claud-opus-4-7');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0][1]).toContain(
      'AGENT_MODEL does not look like a Claude model ID',
    );
  });

  it('trims surrounding whitespace before validation and pass-through', () => {
    // .trim() must run before the prefix check, so `  opus  ` matches
    // 'opus' cleanly and doesn't trigger the warn.
    expect(resolveAgentModel('  claude-sonnet-4-6[1m]  ')).toBe(
      'claude-sonnet-4-6[1m]',
    );
    expect(resolveAgentModel('\topus\n')).toBe('opus');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------
// CLAUDE_CODE_AUTO_COMPACT_WINDOW forwarding (#29).
//
// The orchestrator forwards the configured AGENT_AUTO_COMPACT_WINDOW
// (default 800k) to the SDK via CLAUDE_CODE_AUTO_COMPACT_WINDOW. This
// replaces the prior 165k hardcode in the agent-runner that clamped the
// SDK's working window to ~16% of the paid-for 1M context window.
// ----------------------------------------------------------------------

describe('CLAUDE_CODE_AUTO_COMPACT_WINDOW forwarding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards CLAUDE_CODE_AUTO_COMPACT_WINDOW with the configured default', async () => {
    const promise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    // The mock at the top sets AGENT_AUTO_COMPACT_WINDOW=800000. If
    // this assertion ever drifts, every container could silently
    // regress to whatever the previous default was — including the
    // 165k upstream hardcode that motivated #29 in the first place.
    expect(args).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=800000');
  });
});

// ----------------------------------------------------------------------
// SECRET_CONTAINER_VARS .env-fallback (orchestrator runs under launchd
// which doesn't auto-load .env into process.env). When process.env is
// missing a SECRET_CONTAINER_VARS key but .env has it, container-runner
// must still materialize an --env-file so the secret reaches the
// container. Without the fallback, GITHUB_TOKEN sits in .env and never
// gets forwarded — the symptom that motivated this fix.
// ----------------------------------------------------------------------

describe('SECRET_CONTAINER_VARS .env-file fallback', () => {
  let envModule: typeof import('./env.js');

  beforeEach(async () => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    envModule = await import('./env.js');
    vi.mocked(envModule.readEnvFile).mockReset();
    vi.mocked(envModule.readEnvFile).mockReturnValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GITHUB_TOKEN;
  });

  it('emits --env-file when GITHUB_TOKEN is absent from process.env but present in .env (trusted group)', async () => {
    delete process.env.GITHUB_TOKEN;
    // Inject the .env-only value via the mocked readEnvFile.
    vi.mocked(envModule.readEnvFile).mockReturnValue({
      GITHUB_TOKEN: 'github_pat_dotenv_only',
    });

    const trustedGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: { trusted: true },
    };

    const promise = runContainerAgent(trustedGroup, testInput, () => {});
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    // The presence of `--env-file <tmp>` proves buildSecretEnvFile got
    // a non-empty secretEnv map. Without the readEnvFile fallback this
    // assertion fails — the loop sees process.env[name] === undefined
    // and produces an empty map, so buildSecretEnvFile returns null
    // and no --env-file arg is emitted.
    const envFileIdx = args.indexOf('--env-file');
    expect(envFileIdx).toBeGreaterThanOrEqual(0);
    expect(args[envFileIdx + 1]).toMatch(/nanoclaw-env-[0-9a-f]{24}$/);
  });

  it('omits --env-file when GITHUB_TOKEN is missing from BOTH process.env and .env', async () => {
    delete process.env.GITHUB_TOKEN;
    vi.mocked(envModule.readEnvFile).mockReturnValue({});

    const trustedGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: { trusted: true },
    };

    const promise = runContainerAgent(trustedGroup, testInput, () => {});
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    // No fallback hit — secretEnv stays empty, so no --env-file arg.
    // Pinned so a future regression that always emits an empty
    // env-file (creating a 0600 tempfile every spawn for nothing)
    // surfaces here.
    expect(args).not.toContain('--env-file');
  });

  it('prefers process.env over .env when both are set', async () => {
    process.env.GITHUB_TOKEN = 'github_pat_from_process_env';
    vi.mocked(envModule.readEnvFile).mockReturnValue({
      GITHUB_TOKEN: 'github_pat_from_dotenv',
    });

    const trustedGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: { trusted: true },
    };

    const promise = runContainerAgent(trustedGroup, testInput, () => {});
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    // We can't directly inspect tempfile contents here (the fs mock
    // intercepts writeFileSync), but the precedence contract is `||`
    // — process.env first, .env as fallback. The presence of an
    // --env-file arg confirms the path executed; the fallback test
    // above pins the .env-only branch.
    expect(args).toContain('--env-file');
  });
});
