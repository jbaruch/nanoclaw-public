// #337 — maintenance-class blocklist behaviour. Verifies the
// install-into-container loop in `buildVolumeMounts` honours
// `MAINTENANCE_RULE_BLOCKLIST` / `MAINTENANCE_SKILL_BLOCKLIST` only
// when the spawn's `sessionName === 'maintenance'`.
//
// Standalone test file (no global `vi.mock('fs')`) so the install loop
// runs against a real tmp registry. The narrow config mock points
// DATA_DIR / GROUPS_DIR / TILE_OWNER at tmp paths so the per-spawn
// `.tessl/` and `skills/` dirs land somewhere we can read back.
//
// Companion `container-runner.test.ts` mocks fs globally for
// docker-arg assertions; that test surface can't reach the install
// loop because everything `existsSync` touches returns false there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP_PREFIX = 'nc-blocklist-';
let tmpRoot: string;
let registryRoot: string;
let groupsDir: string;
let dataDir: string;
let storeDir: string;

// Per-test mutable blocklists. Populated in beforeEach so each test
// gets a fresh set of names; the `vi.mock` below reads from these
// closures so module-load order doesn't matter.
let ruleBlocklist: Set<string>;
let skillBlocklist: Set<string>;

vi.mock('./config.js', () => ({
  AGENT_AUTO_COMPACT_WINDOW: 800000,
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  get DATA_DIR() {
    return dataDir;
  },
  ENABLE_THRESHOLD_NUKE: false,
  get GROUPS_DIR() {
    return groupsDir;
  },
  get STORE_DIR() {
    return storeDir;
  },
  HOST_PROJECT_ROOT: process.cwd(),
  HOST_UID: undefined,
  HOST_GID: undefined,
  IDLE_TIMEOUT: 1800000,
  get MAINTENANCE_RULE_BLOCKLIST() {
    return ruleBlocklist;
  },
  get MAINTENANCE_SKILL_BLOCKLIST() {
    return skillBlocklist;
  },
  MODEL_CONTEXT_WINDOW: 1000000,
  TILE_OWNER: 'test',
  TIMEZONE: 'UTC',
}));

vi.mock('better-sqlite3', () => ({ default: vi.fn() }));

// Capture logger.info calls so we can assert the
// `install_blocklist_filtered` payload shape per test.
const loggerCalls: Array<{ payload: unknown; msg: string }> = [];
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn((payload: unknown, msg: string) =>
      loggerCalls.push({ payload, msg }),
    ),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./host-logs.js', () => ({
  containerLogPath: vi.fn(() => '/dev/null'),
  ensureHostLogDirs: vi.fn(() => false),
  hostLogsDir: vi.fn(() => '/dev/null'),
  stripAnsi: (s: string) => s,
}));

vi.mock('./observer.js', () => ({ onAgentLine: vi.fn() }));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'none'),
}));

vi.mock('./handoff.js', () => ({ isHandoffActive: vi.fn(() => false) }));

vi.mock('./ipc-input-sweep.js', () => ({ sweepStaleInputs: vi.fn() }));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Import AFTER mocks are registered so the SUT picks up the
// per-test blocklist values via the getter-backed mock above.
async function importSUT() {
  const mod = await import('./container-runner.js');
  return mod;
}

function writeFakeTile(
  tileName: string,
  rules: Record<string, string>,
  skills: Record<string, Record<string, string>>,
) {
  const tileRoot = path.join(registryRoot, 'tiles', 'test', tileName);
  const rulesDir = path.join(tileRoot, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  for (const [name, content] of Object.entries(rules)) {
    fs.writeFileSync(path.join(rulesDir, name), content);
  }
  for (const [skillName, files] of Object.entries(skills)) {
    const skillDir = path.join(tileRoot, 'skills', skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    for (const [fname, fcontent] of Object.entries(files)) {
      fs.writeFileSync(path.join(skillDir, fname), fcontent);
    }
  }
}

function makeGroup(folder: string) {
  // Pre-create the per-group dir so `buildVolumeMounts`'s eager
  // AGENTS.md write succeeds (it doesn't mkdir itself; the caller in
  // `runContainerAgent` does that step before invoking).
  fs.mkdirSync(path.join(groupsDir, folder), { recursive: true });
  return {
    name: folder,
    folder,
    trigger: '@bot',
    added_at: new Date().toISOString(),
    containerConfig: { trusted: false },
    requiresTrigger: true,
    isMain: false,
  };
}

function jidFor(folder: string): string {
  return `tg:test-${folder}`;
}

// `registryTiles` inside `buildVolumeMounts` is computed from
// `process.cwd()` at call time, so the test chdir's into tmpRoot to
// redirect the registry probe at our fake tile content. Restored in
// afterEach.
let originalCwd: string;

describe('#337 maintenance blocklist filter', () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
    // `registryTiles` resolves to <cwd>/tessl-workspace/.tessl/tiles/<TILE_OWNER>
    // — match that layout exactly so the install loop finds our tiles.
    registryRoot = path.join(tmpRoot, 'tessl-workspace', '.tessl');
    groupsDir = path.join(tmpRoot, 'groups');
    dataDir = path.join(tmpRoot, 'data');
    storeDir = path.join(tmpRoot, 'store');
    fs.mkdirSync(registryRoot, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    process.chdir(tmpRoot);
    ruleBlocklist = new Set();
    skillBlocklist = new Set();
    loggerCalls.length = 0;

    writeFakeTile(
      'nanoclaw-core',
      {
        'rule-keep.md': '# keep this rule',
        'rule-block.md': '# block this rule',
      },
      {
        'skill-keep': { 'SKILL.md': 'name: skill-keep\n' },
        'skill-block': { 'SKILL.md': 'name: skill-block\n' },
      },
    );
    writeFakeTile(
      'nanoclaw-untrusted',
      { 'unt-rule.md': '# untrusted rule' },
      { 'unt-skill': { 'SKILL.md': 'name: unt-skill\n' } },
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('with empty blocklists, default-session install copies everything (regression guard)', async () => {
    const { buildVolumeMounts } = await importSUT();
    const group = makeGroup('test-default');
    buildVolumeMounts(group, false, jidFor(group.folder), 'default');

    const installedTesslDir = path.join(
      dataDir,
      'sessions',
      'test-default',
      'default',
      '.claude',
      '.tessl',
      'tiles',
      'test',
      'nanoclaw-core',
      'rules',
    );
    expect(fs.existsSync(path.join(installedTesslDir, 'rule-keep.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(installedTesslDir, 'rule-block.md'))).toBe(
      true,
    );

    const filterCalls = loggerCalls.filter(
      (c) => c.msg === 'install_blocklist_filtered',
    );
    expect(filterCalls).toHaveLength(0);
  });

  it('with blocklists, default-session is NOT filtered (filter only fires for maintenance)', async () => {
    ruleBlocklist = new Set(['rule-block.md']);
    skillBlocklist = new Set(['skill-block']);
    const { buildVolumeMounts } = await importSUT();
    const group = makeGroup('test-default-2');
    buildVolumeMounts(group, false, jidFor(group.folder), 'default');

    const installedRulesDir = path.join(
      dataDir,
      'sessions',
      'test-default-2',
      'default',
      '.claude',
      '.tessl',
      'tiles',
      'test',
      'nanoclaw-core',
      'rules',
    );
    expect(fs.existsSync(path.join(installedRulesDir, 'rule-block.md'))).toBe(
      true,
    );

    const filterCalls = loggerCalls.filter(
      (c) => c.msg === 'install_blocklist_filtered',
    );
    expect(filterCalls).toHaveLength(0);
  });

  it('with blocklists, maintenance-session SKIPS blocked rules and emits one log line', async () => {
    ruleBlocklist = new Set(['rule-block.md']);
    skillBlocklist = new Set();
    const { buildVolumeMounts } = await importSUT();
    const group = makeGroup('test-maint-1');
    buildVolumeMounts(group, false, jidFor(group.folder), 'maintenance');

    const installedRulesDir = path.join(
      dataDir,
      'sessions',
      'test-maint-1',
      'maintenance',
      '.claude',
      '.tessl',
      'tiles',
      'test',
      'nanoclaw-core',
      'rules',
    );
    expect(fs.existsSync(path.join(installedRulesDir, 'rule-keep.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(installedRulesDir, 'rule-block.md'))).toBe(
      false,
    );

    const filterCalls = loggerCalls.filter(
      (c) => c.msg === 'install_blocklist_filtered',
    );
    expect(filterCalls).toHaveLength(1);
    const payload = filterCalls[0].payload as {
      sessionName: string;
      filteredRules: string[];
      filteredSkills: string[];
    };
    expect(payload.sessionName).toBe('maintenance');
    expect(payload.filteredRules).toEqual(['nanoclaw-core/rule-block.md']);
    expect(payload.filteredSkills).toEqual([]);
  });

  it('with blocklists, maintenance-session SKIPS blocked skills (both tile and tessl__-prefixed dst)', async () => {
    ruleBlocklist = new Set();
    skillBlocklist = new Set(['skill-block']);
    const { buildVolumeMounts } = await importSUT();
    const group = makeGroup('test-maint-2');
    buildVolumeMounts(group, false, jidFor(group.folder), 'maintenance');

    const tileDstSkills = path.join(
      dataDir,
      'sessions',
      'test-maint-2',
      'maintenance',
      '.claude',
      '.tessl',
      'tiles',
      'test',
      'nanoclaw-core',
      'skills',
    );
    const flatSkillsDst = path.join(
      dataDir,
      'sessions',
      'test-maint-2',
      'maintenance',
      '.claude',
      'skills',
    );
    expect(fs.existsSync(path.join(tileDstSkills, 'skill-keep'))).toBe(true);
    expect(fs.existsSync(path.join(tileDstSkills, 'skill-block'))).toBe(false);
    expect(fs.existsSync(path.join(flatSkillsDst, 'tessl__skill-keep'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(flatSkillsDst, 'tessl__skill-block'))).toBe(
      false,
    );

    const filterCalls = loggerCalls.filter(
      (c) => c.msg === 'install_blocklist_filtered',
    );
    expect(filterCalls).toHaveLength(1);
    const payload = filterCalls[0].payload as { filteredSkills: string[] };
    expect(payload.filteredSkills).toContain('nanoclaw-core/skill-block');
  });
});
