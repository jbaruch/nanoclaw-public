import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  KNOWN_VANILLA_TEMPLATE_HASHES,
  buildPlan,
  applyPlan,
} from './migrate-thin-claude-md.js';

// Pick any known-vanilla hash to seed test fixtures with content that
// hashes to it (we don't have the exact original bytes, so generate
// content and add ITS hash to a local copy of the set for the
// test).
function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-thin-claudemd-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeGroup(folderName: string, claudeMdContent?: string): string {
  const dir = path.join(tmpRoot, 'groups', folderName);
  fs.mkdirSync(dir, { recursive: true });
  if (claudeMdContent !== undefined) {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMdContent);
  }
  return dir;
}

describe('buildPlan', () => {
  it('classifies a non-vanilla file as customized (warn-and-leave)', () => {
    // Real vanilla hashes were sampled from the NAS production data,
    // not test data, so we can't easily round-trip a "vanilla" fixture
    // here — that case is covered by the synthetic-hash test below.
    // This case asserts the dispatch in the OTHER direction: any
    // unrecognized content lands in `customizedToWarn`, never
    // `vanillaToDelete`.
    makeGroup('telegram_test', 'arbitrary non-vanilla content\n');
    const plan = buildPlan(path.join(tmpRoot, 'groups'));
    expect(plan.vanillaToDelete).toEqual([]);
    expect(plan.customizedToWarn).toHaveLength(1);
    expect(plan.customizedToWarn[0].path).toBe(
      path.join(tmpRoot, 'groups', 'telegram_test', 'CLAUDE.md'),
    );
  });

  it('always queues MEMORY.md creation for groups missing it', () => {
    makeGroup('telegram_a', 'whatever\n');
    makeGroup('telegram_b'); // no CLAUDE.md, no MEMORY.md
    const plan = buildPlan(path.join(tmpRoot, 'groups'));
    expect(plan.memoryMdToCreate.sort()).toEqual(
      [
        path.join(tmpRoot, 'groups', 'telegram_a', 'MEMORY.md'),
        path.join(tmpRoot, 'groups', 'telegram_b', 'MEMORY.md'),
      ].sort(),
    );
  });

  it('records groups that already have MEMORY.md as already-migrated', () => {
    const dir = makeGroup('telegram_with_memory', 'whatever\n');
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# pre-existing\n');
    const plan = buildPlan(path.join(tmpRoot, 'groups'));
    expect(plan.memoryMdToCreate).toEqual([]);
    expect(plan.alreadyHaveMemoryMd).toEqual([
      path.join(dir, 'MEMORY.md'),
    ]);
  });

  it('skips CLAUDE.md handling for main/ and global/ (git-managed templates)', () => {
    makeGroup('main', 'main admin template\n');
    makeGroup('global', 'global template\n');
    makeGroup('telegram_real', 'whatever\n');
    const plan = buildPlan(path.join(tmpRoot, 'groups'));
    // CLAUDE.md decisions are only made for per-group copies — main and
    // global are kept in sync by `git pull`, the migration must not
    // touch their CLAUDE.md regardless of hash.
    expect(plan.customizedToWarn).toHaveLength(1);
    expect(plan.customizedToWarn[0].path).toContain('telegram_real');
    expect(plan.vanillaToDelete).toEqual([]);
  });

  it('places MEMORY.md in main/ (so its @import resolves) but not in global/', () => {
    makeGroup('main', 'main admin template\n');
    makeGroup('global', 'global template\n');
    makeGroup('telegram_real', 'whatever\n');
    const plan = buildPlan(path.join(tmpRoot, 'groups'));
    expect(plan.memoryMdToCreate.sort()).toEqual(
      [
        path.join(tmpRoot, 'groups', 'main', 'MEMORY.md'),
        path.join(tmpRoot, 'groups', 'telegram_real', 'MEMORY.md'),
      ].sort(),
    );
    expect(
      plan.memoryMdToCreate.some((p) => p.includes('/global/')),
    ).toBe(false);
  });

  it('records groups already missing CLAUDE.md as already-migrated', () => {
    makeGroup('telegram_already_done'); // no CLAUDE.md
    const plan = buildPlan(path.join(tmpRoot, 'groups'));
    expect(plan.alreadyMissingClaudeMd).toEqual([
      path.join(tmpRoot, 'groups', 'telegram_already_done', 'CLAUDE.md'),
    ]);
    expect(plan.vanillaToDelete).toEqual([]);
    expect(plan.customizedToWarn).toEqual([]);
  });

  it('captures size + first line for customized files (operator triage)', () => {
    const content = 'Custom first line\n\nMore custom content\n';
    makeGroup('telegram_custom', content);
    const plan = buildPlan(path.join(tmpRoot, 'groups'));
    expect(plan.customizedToWarn[0].firstLine).toBe('Custom first line');
    expect(plan.customizedToWarn[0].bytes).toBe(
      Buffer.byteLength(content, 'utf-8'),
    );
    expect(plan.customizedToWarn[0].sha).toBe(sha256(Buffer.from(content)));
  });
});

describe('buildPlan vanilla-hash dispatch', () => {
  // Synthetic vanilla case: write content whose hash we KNOW is in the
  // known-vanilla set by injecting a synthetic hash. This proves the
  // dispatch logic works without depending on the production-sampled
  // hashes (which represent specific historical templates we can't
  // reconstruct byte-for-byte from this test).
  it('deletes files whose hash is in the known-vanilla set', () => {
    const content = 'synthetic vanilla content\n';
    const hash = sha256(Buffer.from(content));
    KNOWN_VANILLA_TEMPLATE_HASHES.add(hash);
    try {
      makeGroup('telegram_synth_vanilla', content);
      const plan = buildPlan(path.join(tmpRoot, 'groups'));
      expect(plan.vanillaToDelete).toEqual([
        path.join(tmpRoot, 'groups', 'telegram_synth_vanilla', 'CLAUDE.md'),
      ]);
      expect(plan.customizedToWarn).toEqual([]);
    } finally {
      KNOWN_VANILLA_TEMPLATE_HASHES.delete(hash);
    }
  });
});

describe('applyPlan', () => {
  it('deletes vanilla files and creates MEMORY.md placeholders', () => {
    const dir = makeGroup('telegram_apply', 'doomed\n');
    const plan = {
      vanillaToDelete: [path.join(dir, 'CLAUDE.md')],
      customizedToWarn: [],
      memoryMdToCreate: [path.join(dir, 'MEMORY.md')],
      alreadyMissingClaudeMd: [],
      alreadyHaveMemoryMd: [],
    };
    applyPlan(plan);
    expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true);
    const memContent = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf-8');
    expect(memContent).toContain('# Memory — telegram_apply');
  });

  it('does not touch files outside the plan (idempotency hook)', () => {
    const dir = makeGroup('telegram_safe', 'left alone\n');
    const plan = {
      vanillaToDelete: [],
      customizedToWarn: [],
      memoryMdToCreate: [],
      alreadyMissingClaudeMd: [],
      alreadyHaveMemoryMd: [],
    };
    applyPlan(plan);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe(
      'left alone\n',
    );
  });
});
