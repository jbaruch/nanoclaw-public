import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyTileScriptsToFlatDir } from './container-runner.js';

// Standalone test file — no `vi.mock('fs')`. The companion
// container-runner.test.ts mocks fs globally for security-critical
// mount-construction assertions; here we need real fs to exercise the
// directory-skipping path that prevented the `Recursive option not
// enabled, cannot copy a directory: __pycache__/` crash that tripped
// the Telegram Swarm circuit breaker.

describe('copyTileScriptsToFlatDir', () => {
  let tmpRoot: string;
  let srcDir: string;
  let dstDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-scripts-copy-'));
    srcDir = path.join(tmpRoot, 'scripts');
    dstDir = path.join(tmpRoot, 'dst');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(dstDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('skips a __pycache__/ subdir without throwing', () => {
    fs.writeFileSync(path.join(srcDir, 'heartbeat-checks.py'), '# stub');
    const pycache = path.join(srcDir, '__pycache__');
    fs.mkdirSync(pycache);
    fs.writeFileSync(
      path.join(pycache, 'heartbeat-checks.cpython-311.pyc'),
      'compiled',
    );

    expect(() => copyTileScriptsToFlatDir(srcDir, dstDir)).not.toThrow();

    expect(fs.existsSync(path.join(dstDir, 'heartbeat-checks.py'))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, '__pycache__'))).toBe(false);
  });

  it('copies regular files into the flat destination', () => {
    fs.writeFileSync(path.join(srcDir, 'a.sh'), '#!/bin/sh\necho a\n');
    fs.writeFileSync(path.join(srcDir, 'b.py'), 'print("b")\n');

    copyTileScriptsToFlatDir(srcDir, dstDir);

    expect(fs.readFileSync(path.join(dstDir, 'a.sh'), 'utf8')).toBe(
      '#!/bin/sh\necho a\n',
    );
    expect(fs.readFileSync(path.join(dstDir, 'b.py'), 'utf8')).toBe(
      'print("b")\n',
    );
  });

  it('preserves symlink entries (regression guard from PR review)', () => {
    // Pre-fix the loop walked names and let cpSync handle them; that
    // included symlinks. Filter chosen as `!isDirectory()` rather than
    // `isFile()` so a symlinked executable still publishes under
    // /workspace/group/scripts/<name> instead of being silently
    // dropped along with the actual __pycache__ crash fix.
    const target = path.join(tmpRoot, 'real-script.sh');
    fs.writeFileSync(target, '#!/bin/sh\necho real\n');
    const linkName = 'aliased.sh';
    fs.symlinkSync(target, path.join(srcDir, linkName));

    copyTileScriptsToFlatDir(srcDir, dstDir);

    expect(fs.existsSync(path.join(dstDir, linkName))).toBe(true);
    expect(fs.readFileSync(path.join(dstDir, linkName), 'utf8')).toBe(
      '#!/bin/sh\necho real\n',
    );
  });

  it('is a no-op when the source dir does not exist', () => {
    const missing = path.join(tmpRoot, 'never-existed');
    expect(() => copyTileScriptsToFlatDir(missing, dstDir)).not.toThrow();
    expect(fs.readdirSync(dstDir)).toEqual([]);
  });

  it('mixes files and dirs in the same source — files copied, dirs skipped', () => {
    fs.writeFileSync(path.join(srcDir, 'one.py'), 'one');
    fs.mkdirSync(path.join(srcDir, '__pycache__'));
    fs.writeFileSync(path.join(srcDir, 'two.sh'), 'two');
    fs.mkdirSync(path.join(srcDir, 'nested'));
    fs.writeFileSync(path.join(srcDir, 'nested', 'inner.txt'), 'inner');

    copyTileScriptsToFlatDir(srcDir, dstDir);

    const dstEntries = fs.readdirSync(dstDir).sort();
    expect(dstEntries).toEqual(['one.py', 'two.sh']);
  });
});
