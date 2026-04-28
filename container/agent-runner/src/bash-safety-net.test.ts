import { describe, it, expect } from 'vitest';

import {
  BASH_SAFETY_RULE_IDS,
  evaluateBashCommand,
} from './bash-safety-net.js';

describe('evaluateBashCommand', () => {
  describe('rm -rf root-level deletes', () => {
    const blocked = [
      'rm -rf /',
      'rm -rf /workspace',
      'rm -rf /workspace/',
      'rm -rf /workspace/.',
      'rm -rf /workspace/..',
      'rm -rf ~',
      'rm -rf ~/',
      'rm -rf $HOME',
      'rm -rf $HOME/',
      'rm -rf /home/node',
      'rm -rf /home/node/',
      'rm -fr /',
      'rm -r -f /',
      'rm -f -r /workspace',
      'rm -rf -- /',
      'rm -rf -- /workspace',
      'rm --recursive --force /',
      'rm --force --recursive /workspace',
      'cd /tmp; rm -rf /',
      'rm -rf / && echo done',
    ];
    for (const cmd of blocked) {
      it(`denies ${JSON.stringify(cmd)}`, () => {
        const result = evaluateBashCommand(cmd);
        expect(result.deny).toBe(true);
        expect(result.matched).toBe('rm-rf-root');
      });
    }

    const allowed = [
      'rm -rf node_modules',
      'rm -rf ./build',
      'rm -rf staging/old-tile',
      'rm -rf /workspace/group/conversations/old.md',
      'rm -rf /tmp/scratch',
      'rm -f file.txt',
      'rm /workspace/foo',
    ];
    for (const cmd of allowed) {
      it(`allows ${JSON.stringify(cmd)}`, () => {
        expect(evaluateBashCommand(cmd).deny).toBe(false);
      });
    }
  });

  describe('git push --force to main/master', () => {
    const blocked = [
      'git push --force origin main',
      'git push -f origin main',
      'git push --force-with-lease origin main',
      'git push --force origin HEAD:main',
      'git push -f origin master',
      'git push --force upstream master',
      'git push origin +main',
      'git push origin +master',
      'git push origin +HEAD:main',
    ];
    for (const cmd of blocked) {
      it(`denies ${JSON.stringify(cmd)}`, () => {
        const result = evaluateBashCommand(cmd);
        expect(result.deny).toBe(true);
        expect(result.matched).toBe('force-push-main');
      });
    }

    const allowed = [
      'git push --force origin feat/foo',
      'git push -f origin fix/bug-123',
      'git push origin main',
      'git push --force origin worktree-epic+hooks',
      'git push origin HEAD:feat/x',
    ];
    for (const cmd of allowed) {
      it(`allows ${JSON.stringify(cmd)}`, () => {
        expect(evaluateBashCommand(cmd).deny).toBe(false);
      });
    }
  });

  describe('mkfs', () => {
    it('denies mkfs.ext4', () => {
      expect(evaluateBashCommand('mkfs.ext4 /dev/sda1').deny).toBe(true);
    });
    it('denies bare mkfs', () => {
      expect(evaluateBashCommand('mkfs /dev/sda1').deny).toBe(true);
    });
    it('denies mkfs after a shell separator', () => {
      expect(evaluateBashCommand('cd /tmp && mkfs.ext4 /dev/sda1').deny).toBe(true);
      expect(evaluateBashCommand('echo go; mkfs /dev/sda1').deny).toBe(true);
    });
    it('allows benign command containing the substring "mkfs" without word boundary', () => {
      expect(evaluateBashCommand('echo nomkfs').deny).toBe(false);
    });
    it('allows mkfs as an argument to another command (prose mention)', () => {
      expect(evaluateBashCommand('echo mkfs.ext4 docs.md').deny).toBe(false);
      expect(evaluateBashCommand('grep mkfs README.md').deny).toBe(false);
    });
  });

  describe('dd to raw disk', () => {
    it('denies dd of=/dev/sda', () => {
      expect(
        evaluateBashCommand('dd if=image.iso of=/dev/sda bs=4M').deny,
      ).toBe(true);
    });
    it('denies dd of=/dev/nvme0n1', () => {
      expect(evaluateBashCommand('dd if=/tmp/x of=/dev/nvme0n1').deny).toBe(true);
    });
    it('allows dd to a regular file', () => {
      expect(
        evaluateBashCommand('dd if=/dev/zero of=/tmp/zeros bs=1M count=10').deny,
      ).toBe(false);
    });
  });

  describe('redirect to raw block device', () => {
    it('denies > /dev/sda', () => {
      expect(evaluateBashCommand('cat foo > /dev/sda').deny).toBe(true);
    });
    it('allows > /dev/null', () => {
      expect(evaluateBashCommand('cat foo > /dev/null').deny).toBe(false);
    });
    it('allows > regular file', () => {
      expect(evaluateBashCommand('echo hi > out.txt').deny).toBe(false);
    });
  });

  describe('chmod -R 777', () => {
    it('denies chmod -R 777 anywhere', () => {
      expect(evaluateBashCommand('chmod -R 777 /workspace').deny).toBe(true);
    });
    it('denies chmod --recursive 777', () => {
      expect(evaluateBashCommand('chmod --recursive 777 .').deny).toBe(true);
    });
    it('allows chmod 755 file', () => {
      expect(evaluateBashCommand('chmod 755 script.sh').deny).toBe(false);
    });
    it('allows chmod -R 755 (less-permissive)', () => {
      expect(evaluateBashCommand('chmod -R 755 ./build').deny).toBe(false);
    });
  });

  describe('chown -R on mount roots', () => {
    it('denies chown -R on /workspace', () => {
      expect(evaluateBashCommand('chown -R node:node /workspace').deny).toBe(true);
    });
    it('denies chown -R on $HOME', () => {
      expect(evaluateBashCommand('chown -R node:node $HOME').deny).toBe(true);
    });
    it('allows chown -R on a subtree', () => {
      expect(
        evaluateBashCommand('chown -R node:node /workspace/group/foo').deny,
      ).toBe(false);
    });
  });

  describe('fork bomb', () => {
    it('denies the canonical fork bomb', () => {
      expect(evaluateBashCommand(':(){ :|: & };:').deny).toBe(true);
    });
    it('denies whitespace-relaxed fork bomb', () => {
      expect(evaluateBashCommand(': ( ) { : | : & } ; :').deny).toBe(true);
    });
  });

  describe('input shape', () => {
    it('returns deny=false for non-string command', () => {
      expect(evaluateBashCommand(undefined).deny).toBe(false);
      expect(evaluateBashCommand(null).deny).toBe(false);
      expect(evaluateBashCommand(42).deny).toBe(false);
      expect(evaluateBashCommand({ command: 'rm -rf /' }).deny).toBe(false);
    });
    it('returns deny=false for empty string', () => {
      expect(evaluateBashCommand('').deny).toBe(false);
    });
  });

  it('exposes a stable rule-id catalogue', () => {
    expect(BASH_SAFETY_RULE_IDS).toEqual([
      'rm-rf-root',
      'force-push-main',
      'mkfs',
      'dd-to-disk',
      'redirect-to-disk',
      'chmod-recursive-777',
      'chown-recursive-mount-root',
      'fork-bomb',
    ]);
  });
});
