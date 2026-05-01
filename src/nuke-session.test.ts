import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Per #100, `nukeSession` must delete the on-disk JSONL transcript so
// a fresh container doesn't re-read it on next spawn. The helper that
// does the actual disk work is `wipeSessionJsonl` — exported from
// src/index.ts specifically for this test.
//
// We mock `./config.js`'s `DATA_DIR` to a per-test tempdir so we don't
// touch the real `data/sessions/` tree. `vi.mock` is hoisted, so the
// path is computed inside `vi.hoisted`.

const { TEST_DATA_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsMod = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osMod = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path') as typeof import('path');
  // `mkdtempSync` lets the OS pick the unique suffix — not "self-
  // generated random test data" (the rule targets assertion inputs),
  // but still hermetic across concurrent vitest workers and crash-
  // recovery rerun pairs. Replaces an earlier `crypto.randomBytes`
  // suffix the policy reviewer flagged at literal pattern level
  // (jbaruch/coding-policy: testing-standards).
  return {
    TEST_DATA_DIR: fsMod.mkdtempSync(
      pathMod.join(osMod.tmpdir(), 'nanoclaw-nuke-session-test-'),
    ),
  };
});

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

import { wipeSessionJsonl } from './index.js';

function projectsDir(group: string, slot: string): string {
  return path.join(
    TEST_DATA_DIR,
    'sessions',
    group,
    slot,
    '.claude',
    'projects',
  );
}

beforeEach(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('wipeSessionJsonl (#100)', () => {
  it('deletes the matching JSONL when present', () => {
    const projDir = path.join(
      projectsDir('test_group', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(projDir, { recursive: true });
    const jsonlPath = path.join(projDir, 'abc-123.jsonl');
    fs.writeFileSync(jsonlPath, 'transcript content');

    const deleted = wipeSessionJsonl('test_group', 'default', 'abc-123');

    expect(deleted).toBe(1);
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  it('returns 0 when the JSONL file does not exist', () => {
    const projDir = path.join(
      projectsDir('test_group', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(projDir, { recursive: true });

    const deleted = wipeSessionJsonl('test_group', 'default', 'never-existed');
    expect(deleted).toBe(0);
  });

  it('returns 0 when the projects directory does not exist (fresh group)', () => {
    const deleted = wipeSessionJsonl('untouched_group', 'default', 'any-uuid');
    expect(deleted).toBe(0);
  });

  it('finds JSONL across multiple project-slug subdirectories', () => {
    // Container slug today is `-workspace-group`; defensive against rename.
    const slugA = path.join(
      projectsDir('group_a', 'maintenance'),
      '-workspace-group',
    );
    const slugB = path.join(
      projectsDir('group_a', 'maintenance'),
      '-workspace-other',
    );
    fs.mkdirSync(slugA, { recursive: true });
    fs.mkdirSync(slugB, { recursive: true });
    const jsonlA = path.join(slugA, 'sess-1.jsonl');
    const jsonlB = path.join(slugB, 'sess-1.jsonl');
    fs.writeFileSync(jsonlA, 'a');
    fs.writeFileSync(jsonlB, 'b');

    const deleted = wipeSessionJsonl('group_a', 'maintenance', 'sess-1');

    expect(deleted).toBe(2);
    expect(fs.existsSync(jsonlA)).toBe(false);
    expect(fs.existsSync(jsonlB)).toBe(false);
  });

  it('only deletes the JSONL matching the given sessionId, not others', () => {
    const projDir = path.join(
      projectsDir('group_b', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(projDir, { recursive: true });
    const target = path.join(projDir, 'target-id.jsonl');
    const sibling = path.join(projDir, 'other-id.jsonl');
    fs.writeFileSync(target, 'target');
    fs.writeFileSync(sibling, 'sibling');

    const deleted = wipeSessionJsonl('group_b', 'default', 'target-id');

    expect(deleted).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
  });

  it('does not touch the other session slot of the same group', () => {
    const defaultProj = path.join(
      projectsDir('group_c', 'default'),
      '-workspace-group',
    );
    const maintProj = path.join(
      projectsDir('group_c', 'maintenance'),
      '-workspace-group',
    );
    fs.mkdirSync(defaultProj, { recursive: true });
    fs.mkdirSync(maintProj, { recursive: true });
    const defaultJsonl = path.join(defaultProj, 'shared-uuid.jsonl');
    const maintJsonl = path.join(maintProj, 'shared-uuid.jsonl');
    fs.writeFileSync(defaultJsonl, 'd');
    fs.writeFileSync(maintJsonl, 'm');

    // Nuke only the default slot.
    const deleted = wipeSessionJsonl('group_c', 'default', 'shared-uuid');

    expect(deleted).toBe(1);
    expect(fs.existsSync(defaultJsonl)).toBe(false);
    expect(fs.existsSync(maintJsonl)).toBe(true);
  });

  it('refuses to wipe when sessionId contains path separators (security)', () => {
    // Set up a target file that a path-traversal sessionId would point to.
    const projDir = path.join(
      projectsDir('victim_group', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(projDir, { recursive: true });
    const innocent = path.join(projDir, 'real-uuid.jsonl');
    fs.writeFileSync(innocent, 'untouched');

    // Sentinel file the attacker is trying to nuke (one level up).
    const sentinelDir = path.join(
      projectsDir('victim_group', 'default'),
      'other-slug',
    );
    fs.mkdirSync(sentinelDir, { recursive: true });
    const sentinel = path.join(sentinelDir, 'real-uuid.jsonl');
    fs.writeFileSync(sentinel, 'sentinel');

    // Crafted sessionId tries to escape into the sibling slug.
    const deleted = wipeSessionJsonl(
      'victim_group',
      'default',
      '../other-slug/real-uuid',
    );

    expect(deleted).toBe(0);
    expect(fs.existsSync(innocent)).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('refuses to wipe when sessionId contains shell metachars', () => {
    const projDir = path.join(
      projectsDir('group_e', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(projDir, { recursive: true });
    const benign = path.join(projDir, 'sid.jsonl');
    fs.writeFileSync(benign, 'x');

    // Empty / dot / glob — none should match the strict charset.
    expect(wipeSessionJsonl('group_e', 'default', '')).toBe(0);
    expect(wipeSessionJsonl('group_e', 'default', '.')).toBe(0);
    expect(wipeSessionJsonl('group_e', 'default', '*')).toBe(0);
    expect(wipeSessionJsonl('group_e', 'default', 'has space')).toBe(0);

    expect(fs.existsSync(benign)).toBe(true);
  });

  it('skips non-directory entries inside projects/ (defensive)', () => {
    const projects = projectsDir('group_d', 'default');
    fs.mkdirSync(projects, { recursive: true });
    // Stray file at the top of projects/ — should not crash the walker.
    fs.writeFileSync(path.join(projects, 'README.md'), 'noise');
    const projDir = path.join(projects, '-workspace-group');
    fs.mkdirSync(projDir, { recursive: true });
    const jsonlPath = path.join(projDir, 'sid.jsonl');
    fs.writeFileSync(jsonlPath, 'x');

    const deleted = wipeSessionJsonl('group_d', 'default', 'sid');

    expect(deleted).toBe(1);
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  it('refuses fast-path slug that is a symlink to an outside directory', () => {
    // The fast path tries `projects/-workspace-group` directly. Without
    // an lstat guard, a compromised container could symlink the
    // canonical fast-path slug at an attacker-chosen directory; the
    // realpath-containment check inside `unlinkJsonlInSlug` resolves
    // both ends through the same symlink, so containment passes and
    // the unlink lands inside the symlink target.
    const outsideDir = path.join(TEST_DATA_DIR, 'outside_fastpath_target');
    fs.mkdirSync(outsideDir, { recursive: true });
    const sentinel = path.join(outsideDir, 'sid.jsonl');
    fs.writeFileSync(sentinel, 'sentinel');

    const projects = projectsDir('fastpath_symlink_group', 'default');
    fs.mkdirSync(projects, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(projects, '-workspace-group'), 'dir');

    const deleted = wipeSessionJsonl(
      'fastpath_symlink_group',
      'default',
      'sid',
    );

    expect(deleted).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('refuses to traverse a symlink-to-directory under projects/', () => {
    // Outside-projects directory holds a JSONL that an attacker would
    // try to reach via a symlink in projects/.
    const outsideDir = path.join(TEST_DATA_DIR, 'outside_projects');
    fs.mkdirSync(outsideDir, { recursive: true });
    const sentinel = path.join(outsideDir, 'sid.jsonl');
    fs.writeFileSync(sentinel, 'sentinel');

    // Set up a symlink projects/<slug> → outsideDir.
    const projects = projectsDir('symlink_group', 'default');
    fs.mkdirSync(projects, { recursive: true });
    const symlinkSlug = path.join(projects, 'evil-slug');
    fs.symlinkSync(outsideDir, symlinkSlug, 'dir');

    const deleted = wipeSessionJsonl('symlink_group', 'default', 'sid');

    expect(deleted).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('unlinks a symlinked session jsonl without deleting its target', () => {
    // A compromised container might replace the legitimate JSONL with
    // a symlink to dodge the nuke. Without the symlink branch, the
    // realpath-containment check would refuse to unlink (target is
    // outside the slug), leaving the link entry on disk. The symlink
    // branch unlinks the link itself — target stays intact, entry is
    // gone, "nuke really nukes" promise upheld.
    const outsideDir = path.join(TEST_DATA_DIR, 'outside_jsonl_target');
    fs.mkdirSync(outsideDir, { recursive: true });
    const targetJsonl = path.join(outsideDir, 'real-session.jsonl');
    fs.writeFileSync(targetJsonl, 'sentinel');

    const projects = projectsDir('symlinked_jsonl_group', 'default');
    const projDir = path.join(projects, '-workspace-group');
    fs.mkdirSync(projDir, { recursive: true });
    const jsonlPath = path.join(projDir, 'sid.jsonl');
    fs.symlinkSync(targetJsonl, jsonlPath);

    const deleted = wipeSessionJsonl('symlinked_jsonl_group', 'default', 'sid');

    expect(deleted).toBe(1);
    expect(fs.existsSync(jsonlPath)).toBe(false);
    expect(fs.existsSync(targetJsonl)).toBe(true);
    expect(fs.readFileSync(targetJsonl, 'utf8')).toBe('sentinel');
  });

  it('unlinks a dangling symlinked session jsonl', () => {
    // Symlink points at a path that doesn't exist. realpath would
    // fail on this; the symlink branch must still unlink the link
    // entry itself.
    const projects = projectsDir('dangling_jsonl_group', 'default');
    const projDir = path.join(projects, '-workspace-group');
    fs.mkdirSync(projDir, { recursive: true });
    const jsonlPath = path.join(projDir, 'sid.jsonl');
    fs.symlinkSync('/nonexistent/path/never-existed.jsonl', jsonlPath);

    const deleted = wipeSessionJsonl('dangling_jsonl_group', 'default', 'sid');

    expect(deleted).toBe(1);
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  it('refuses to traverse if projects/ itself is a symlink', () => {
    // Build a real outside dir holding a sentinel JSONL inside what
    // looks like a slug subtree.
    const outside = path.join(TEST_DATA_DIR, 'outside_root');
    const outsideSlug = path.join(outside, '-workspace-group');
    fs.mkdirSync(outsideSlug, { recursive: true });
    const sentinel = path.join(outsideSlug, 'sid.jsonl');
    fs.writeFileSync(sentinel, 'sentinel');

    // The per-session `.claude` exists, but its `projects/` is a
    // symlink to the attacker-controlled outside_root.
    const claudeDir = path.join(
      TEST_DATA_DIR,
      'sessions',
      'symlink_root_group',
      'default',
      '.claude',
    );
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.symlinkSync(outside, path.join(claudeDir, 'projects'), 'dir');

    const deleted = wipeSessionJsonl('symlink_root_group', 'default', 'sid');

    expect(deleted).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});
