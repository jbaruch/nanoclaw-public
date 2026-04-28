/**
 * Tests for the logger's file sink under `host-logs/orchestrator.log`.
 *
 * The sink writes the same content the terminal sees, but ANSI-stripped
 * and after the bot-token redaction. Tests here verify:
 *   - the sink writes
 *   - color codes don't make it to disk
 *   - bot tokens are redacted before disk
 *   - the sink is silent under permission failure (never throws)
 *   - oversized log files rotate to `.1`
 *
 * Kept in a separate file from logger.test.ts because the sink path
 * resolution requires a mocked DATA_DIR — the production sink lives
 * under the real `data/host-logs/` tree, which test runs must not
 * touch. The mock has to be installed BEFORE logger is imported,
 * which means its own dynamic-import dance.
 */

import fs from 'fs';
import path from 'path';

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osMod = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  return {
    TEST_DATA_DIR: pathMod.join(
      osMod.tmpdir(),
      `nanoclaw-logger-sink-test-${process.pid}`,
    ),
  };
});
vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DATA_DIR,
  };
});

// Pin LOG_LEVEL=info so logger.info() actually writes — same reason
// logger.test.ts pins it. The dynamic import below sees the new value.
const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = 'info';
vi.resetModules();
const { logger } = await import('./logger.js');
const { hostLogsOrchestratorFile, ORCHESTRATOR_LOG_MAX_BYTES } =
  await import('./host-logs.js');

afterAll(() => {
  if (ORIGINAL_LOG_LEVEL === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL;
  }
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

beforeEach(() => {
  // Wipe the host-logs tree between tests so size-based rotation
  // assertions and "first write creates the file" assertions start
  // from a clean slate.
  const hostLogs = path.join(TEST_DATA_DIR, 'host-logs');
  if (fs.existsSync(hostLogs)) {
    fs.rmSync(hostLogs, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger file sink', () => {
  it('writes log lines to host-logs/orchestrator.log', () => {
    // Suppress terminal output noise during tests so the sink is the
    // only place we can observe writes. Spying without re-emitting
    // also keeps the test runner's output clean.
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    logger.info('sink hello');
    // appendFileSync is sync — by the time logger.info returns, the
    // bytes are flushed.
    const contents = fs.readFileSync(hostLogsOrchestratorFile(), 'utf-8');
    expect(contents).toContain('sink hello');
  });

  it('strips ANSI color codes from disk output', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logger.info('colorized line');
    const contents = fs.readFileSync(hostLogsOrchestratorFile(), 'utf-8');
    // ANSI escapes start with the ESC byte (0x1b). If the strip
    // worked, neither the raw byte nor the literal `\x1b[` form is
    // present in the file. (The terminal still gets colors — see the
    // stdoutSpy assertion below.)
    expect(contents).not.toMatch(/\x1b\[/);
  });

  it('still emits color codes to stdout (terminal is unaffected)', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      },
    );
    logger.info('colored stdout');
    const stdout = writes.join('');
    // Terminal still gets the color codes — the strip is sink-only.
    expect(stdout).toMatch(/\x1b\[/);
  });

  it('redacts bot tokens before writing to the sink', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const FAKE_TOKEN = '1111111111:fakeSecretAAAA';
    logger.info(
      `outbound https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`,
    );
    const contents = fs.readFileSync(hostLogsOrchestratorFile(), 'utf-8');
    // Secret bytes must NOT land on disk. Bot ID stays for
    // correlation. This is the same redaction contract logger.test.ts
    // tests for stdout — repeating it here pins it for the sink path,
    // since the redact-then-strip-ANSI-then-write order matters.
    expect(contents).not.toContain('fakeSecretAAAA');
    expect(contents).toContain('1111111111:<redacted>');
  });

  it('does not throw when the sink path is unwritable', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Force appendFileSync to fail. The sink's write loop must
    // swallow the error — propagating it would turn every log call
    // into a crash hazard during disk-full / permission scenarios.
    const err = new Error('EACCES');
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw err;
    });
    expect(() => logger.info('still ok')).not.toThrow();
    spy.mockRestore();
  });

  it('rotates the sink file when it exceeds the size cap', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Pre-size the existing log to just under the cap so the very
    // next write trips rotation. The sink's rotation check fires
    // every SIZE_CHECK_EVERY (256) writes — to trigger it within the
    // test's runtime, we need to emit at least 256 log lines after
    // pre-sizing. That's fast (sync writes, ~1ms each).
    fs.mkdirSync(path.dirname(hostLogsOrchestratorFile()), {
      recursive: true,
    });
    const filler = Buffer.alloc(ORCHESTRATOR_LOG_MAX_BYTES + 1024, 'x');
    fs.writeFileSync(hostLogsOrchestratorFile(), filler);

    // Drive enough writes to trigger the periodic size check.
    for (let i = 0; i < 300; i++) {
      logger.info(`line ${i}`);
    }

    // After rotation, the active log starts fresh and `.1` carries
    // the prior content. The exact moment rotation fires is bounded
    // by SIZE_CHECK_EVERY, so we assert on the post-loop state: the
    // .1 file should exist and the active file should be smaller
    // than the prior content.
    const rotated = `${hostLogsOrchestratorFile()}.1`;
    expect(fs.existsSync(rotated)).toBe(true);
    const activeSize = fs.statSync(hostLogsOrchestratorFile()).size;
    expect(activeSize).toBeLessThan(ORCHESTRATOR_LOG_MAX_BYTES);
  });

  // NOTE: this test must run LAST in the file because it deliberately
  // trips the sink's permanent-disable state, which sticks across
  // tests in the same vitest worker (logger module is loaded once via
  // dynamic import at the top of the file). Tests after this one
  // would see the sink disabled and fail to write at all.
  it('stops retrying after consecutive write failures (no hot-loop)', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Make every appendFileSync fail. The sink should retry a few
    // times then permanently disable itself — without the cap, every
    // subsequent log line would still go through init + append +
    // retry, doubling syscall cost forever under persistent EACCES.
    let appendCalls = 0;
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      appendCalls++;
      throw new Error('EACCES');
    });

    // Hammer the logger past the threshold (3 consecutive failures).
    for (let i = 0; i < 20; i++) {
      logger.info(`line ${i}`);
    }
    const callsAfterCap = appendCalls;

    // After the cap is hit, subsequent log calls must skip
    // appendFileSync entirely (the sink path is permanently
    // disabled). If the count keeps climbing past the cap, the
    // hot-loop concern Copilot raised is real.
    for (let i = 0; i < 20; i++) {
      logger.info(`more ${i}`);
    }
    expect(appendCalls).toBe(callsAfterCap);
    spy.mockRestore();
  });
});
