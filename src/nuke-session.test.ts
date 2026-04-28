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

describe('wipeSessionJsonl tool-results directory wipe', () => {
  // Companion coverage to the JSONL transcript suite above. The SDK
  // writes a per-session sub-directory at `<slug>/<sessionId>/`
  // (containing tool-call result snapshots like image attachments,
  // search outputs) alongside `<sessionId>.jsonl`. Pre-existing
  // behavior unlinked only the JSONL, leaving the dir orphaned. These
  // tests pin the extended contract: both artifacts go away on wipe,
  // and the same realpath-containment / symlink-as-link / DoS-cap
  // discipline applies.
  it('removes the tool-results directory alongside the JSONL', () => {
    const slugDir = path.join(
      projectsDir('test_group', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(slugDir, { recursive: true });
    const jsonlPath = path.join(slugDir, 'abc-123.jsonl');
    const toolResultsDir = path.join(slugDir, 'abc-123');
    fs.writeFileSync(jsonlPath, 'transcript');
    fs.mkdirSync(toolResultsDir);
    fs.writeFileSync(path.join(toolResultsDir, 'tool-1.json'), '{}');
    fs.writeFileSync(path.join(toolResultsDir, 'tool-2.json'), '{}');

    const deleted = wipeSessionJsonl('test_group', 'default', 'abc-123');

    // 1 jsonl + 1 tool-results dir = 2.
    expect(deleted).toBe(2);
    expect(fs.existsSync(jsonlPath)).toBe(false);
    expect(fs.existsSync(toolResultsDir)).toBe(false);
  });

  it('removes the tool-results directory even when the JSONL is absent', () => {
    // Real failure mode: the SDK can land tool-result files before the
    // first transcript flush, and a crash mid-run can leave the dir
    // without its companion .jsonl. The wipe should still clean up.
    const slugDir = path.join(
      projectsDir('orphan_group', 'maintenance'),
      '-workspace-group',
    );
    fs.mkdirSync(slugDir, { recursive: true });
    const toolResultsDir = path.join(slugDir, 'crashed-sess');
    fs.mkdirSync(toolResultsDir);
    fs.writeFileSync(path.join(toolResultsDir, 'half-written.json'), '{');

    const deleted = wipeSessionJsonl(
      'orphan_group',
      'maintenance',
      'crashed-sess',
    );

    expect(deleted).toBe(1);
    expect(fs.existsSync(toolResultsDir)).toBe(false);
  });

  it('returns 0 when neither artifact exists', () => {
    const slugDir = path.join(
      projectsDir('empty_group', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(slugDir, { recursive: true });

    const deleted = wipeSessionJsonl('empty_group', 'default', 'never-was');
    expect(deleted).toBe(0);
  });

  it('removes a symlinked tool-results directory without following it', () => {
    // Defense against a compromised container that swaps its tool-
    // results dir for a symlink pointing at a sensitive host path
    // ($HOME, /etc, etc.) hoping the wipe's `recursive: true` walks
    // through and deletes it. We must unlink the LINK only.
    const slugDir = path.join(
      projectsDir('symlink_dir_group', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(slugDir, { recursive: true });

    // Build a target tree the symlink points at. If the helper
    // followed the link, it would `rmSync` this whole tree.
    const decoyTarget = path.join(TEST_DATA_DIR, 'decoy_target');
    fs.mkdirSync(decoyTarget, { recursive: true });
    const sentinel = path.join(decoyTarget, 'must_survive.txt');
    fs.writeFileSync(sentinel, 'sentinel');

    const symlinkPath = path.join(slugDir, 'sid');
    fs.symlinkSync(decoyTarget, symlinkPath, 'dir');

    const deleted = wipeSessionJsonl('symlink_dir_group', 'default', 'sid');

    // Symlink itself was unlinked.
    expect(deleted).toBe(1);
    expect(fs.existsSync(symlinkPath)).toBe(false);
    // Target tree untouched.
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('sentinel');
  });

  it('leaves a regular file at the dir path alone (refuses to unlink unexpected entry)', () => {
    // The SDK only writes directories at this path. A regular file
    // here means something else put it there — leave it alone rather
    // than deleting state we can't account for.
    const slugDir = path.join(
      projectsDir('file_at_dir_group', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(slugDir, { recursive: true });
    const unexpectedFile = path.join(slugDir, 'sid');
    fs.writeFileSync(unexpectedFile, 'mystery');

    const deleted = wipeSessionJsonl('file_at_dir_group', 'default', 'sid');

    expect(deleted).toBe(0);
    expect(fs.existsSync(unexpectedFile)).toBe(true);
    expect(fs.readFileSync(unexpectedFile, 'utf8')).toBe('mystery');
  });

  it('does not follow symlinks INSIDE the tool-results directory during recursive remove', () => {
    // Compromised container scatters host-pointing symlinks inside
    // its own tool-results dir; rmSync's recursive walk must remove
    // the LINKS only, never traverse through to delete host files.
    // Node's fs.rmSync does not follow symlinks by default — this
    // test pins that guarantee against future Node behavior changes.
    const slugDir = path.join(
      projectsDir('inner_symlink_group', 'default'),
      '-workspace-group',
    );
    fs.mkdirSync(slugDir, { recursive: true });

    const sensitiveTarget = path.join(TEST_DATA_DIR, 'sensitive_outside');
    fs.mkdirSync(sensitiveTarget, { recursive: true });
    const sensitiveFile = path.join(sensitiveTarget, 'secret.txt');
    fs.writeFileSync(sensitiveFile, 'secret');

    const toolResultsDir = path.join(slugDir, 'sid');
    fs.mkdirSync(toolResultsDir);
    // A regular file inside the dir (legitimate SDK output).
    fs.writeFileSync(path.join(toolResultsDir, 'tool-1.json'), '{}');
    // A symlink inside the dir pointing OUT to a sensitive host path.
    fs.symlinkSync(
      sensitiveTarget,
      path.join(toolResultsDir, 'attack-link'),
      'dir',
    );

    const deleted = wipeSessionJsonl('inner_symlink_group', 'default', 'sid');

    expect(deleted).toBe(1);
    expect(fs.existsSync(toolResultsDir)).toBe(false);
    // Sensitive target tree must still be intact.
    expect(fs.existsSync(sensitiveFile)).toBe(true);
    expect(fs.readFileSync(sensitiveFile, 'utf8')).toBe('secret');
  });

  // Note on coverage gap: `removeToolResultsDirInSlug`'s realpath-
  // containment refusal path (the directory-branch check that compares
  // the dir's realpath against the slug's realpath) is not exercised
  // by these tests. Triggering it requires a TOCTOU race where an
  // ancestor symlink is swapped between the outer slug lstat in
  // `wipeSessionJsonl` and the inner realpath in
  // `removeToolResultsDirInSlug` — not deterministically reproducible
  // in a unit test. The JSONL helper carries an analogous gap. The
  // realpath check remains as defense-in-depth alongside the
  // symlink-branch and slug-lstat checks that ARE tested above.

  it('removes the tool-results dir across multiple project-slug subdirectories', () => {
    // Mirror of the JSONL slow-path test: an operator-renamed slug
    // makes the fast-path miss; the slow-path walk must still find
    // and wipe the tool-results dir under every slug it visits.
    const slugA = path.join(
      projectsDir('group_x', 'maintenance'),
      '-workspace-group',
    );
    const slugB = path.join(
      projectsDir('group_x', 'maintenance'),
      '-workspace-renamed',
    );
    fs.mkdirSync(slugA, { recursive: true });
    fs.mkdirSync(slugB, { recursive: true });
    const dirA = path.join(slugA, 'sess-1');
    const dirB = path.join(slugB, 'sess-1');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirA, 'a.json'), '{}');
    fs.writeFileSync(path.join(dirB, 'b.json'), '{}');

    const deleted = wipeSessionJsonl('group_x', 'maintenance', 'sess-1');

    // 2 dirs (no JSONLs in this fixture).
    expect(deleted).toBe(2);
    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(false);
  });
});
