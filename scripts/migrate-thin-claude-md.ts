#!/usr/bin/env tsx
/**
 * One-time migration for #153 (thin per-group CLAUDE.md).
 *
 * Walks every per-group folder under `groups/` (skipping `main/` and
 * `global/`, which are managed by git pull) and:
 *
 *   1. Compares each `CLAUDE.md` against a fixed list of known-vanilla
 *      template hashes (sampled from the NAS at the time of the
 *      migration design — see #153). Vanilla files are deleted; the
 *      readonly trust-tier mount in `container-runner.ts` takes over
 *      from the next container spawn.
 *   2. Customized files are LEFT IN PLACE with a warning naming the
 *      file, its size, and its first line. The operator must reconcile
 *      manually — typically by extracting the custom content into the
 *      group's `MEMORY.md` and then deleting `CLAUDE.md`.
 *   3. Ensures every group folder has a `MEMORY.md` placeholder so the
 *      `@import` in the new thin `CLAUDE.md` resolves on the first
 *      message in that group.
 *
 * Idempotent: safe to re-run. By default runs in DRY mode (prints what
 * it would do, changes nothing). Pass `--apply` to actually delete and
 * create files.
 *
 * Usage on the NAS:
 *   ssh nas 'cd ~/nanoclaw && tsx scripts/migrate-thin-claude-md.ts'
 *   ssh nas 'cd ~/nanoclaw && tsx scripts/migrate-thin-claude-md.ts --apply'
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// SHA-256 of every per-group `CLAUDE.md` shape sampled on the NAS that
// is bytewise-identical to a historical template (i.e. no operator or
// agent edits). Add a new hash here only if you confirm by inspection
// that the file is purely template content.
export const KNOWN_VANILLA_TEMPLATE_HASHES = new Set<string>([
  // 277 bytes — untrusted vanilla template, 5 groups on the NAS
  // including the live failing case (Old.wtf).
  '4a779ed49ea679ce26cce86f8d6717266116dd6982ab430a69b02a20372bbdac',
  // 533 bytes — old trusted template variant A (`@.tessl/RULES.md` first line).
  '3816bc68b7bfdb6cfc6de0c7a087c6e7d267ab91332ebb9d4ef845368bdb60a8',
  // 354 bytes — old trusted template variant B (`# Andy` first line, no @import).
  'a9652e52b5861358b5831362bb3f6a0251dc8b60a574a36bffcd2e2806c1781f',
]);

// Group folders whose CLAUDE.md is git-managed (a source template,
// not a per-group copy) — `git pull` / `deploy.sh` keeps these in
// sync, so the migration must not delete them. MEMORY.md placement,
// on the other hand, applies to every group folder including main:
// main's thin CLAUDE.md @-imports `/workspace/group/MEMORY.md` and
// will fail to resolve without a placeholder.
const SKIP_CLAUDE_MD_FOLDERS = new Set<string>(['main', 'global']);
// `global/` holds the templates themselves, not a real group, so
// it never gets a MEMORY.md.
const SKIP_MEMORY_MD_FOLDERS = new Set<string>(['global']);

export interface Plan {
  vanillaToDelete: string[];
  customizedToWarn: Array<{
    path: string;
    bytes: number;
    sha: string;
    firstLine: string;
  }>;
  memoryMdToCreate: string[];
  alreadyMissingClaudeMd: string[];
  alreadyHaveMemoryMd: string[];
}

function sha256(filePath: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

export function buildPlan(groupsDir: string): Plan {
  const plan: Plan = {
    vanillaToDelete: [],
    customizedToWarn: [],
    memoryMdToCreate: [],
    alreadyMissingClaudeMd: [],
    alreadyHaveMemoryMd: [],
  };

  for (const entry of fs.readdirSync(groupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const groupDir = path.join(groupsDir, entry.name);
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    const memoryMdPath = path.join(groupDir, 'MEMORY.md');

    // CLAUDE.md handling — only for per-group copies, not git-managed templates.
    if (!SKIP_CLAUDE_MD_FOLDERS.has(entry.name)) {
      if (fs.existsSync(claudeMdPath)) {
        const sha = sha256(claudeMdPath);
        if (KNOWN_VANILLA_TEMPLATE_HASHES.has(sha)) {
          plan.vanillaToDelete.push(claudeMdPath);
        } else {
          const content = fs.readFileSync(claudeMdPath, 'utf-8');
          plan.customizedToWarn.push({
            path: claudeMdPath,
            bytes: Buffer.byteLength(content, 'utf-8'),
            sha,
            firstLine: content.split('\n')[0]?.trim() ?? '',
          });
        }
      } else {
        plan.alreadyMissingClaudeMd.push(claudeMdPath);
      }
    }

    // MEMORY.md placement — every real group, including main. Skipping
    // main here would leave main's CLAUDE.md with an unresolvable
    // `@/workspace/group/MEMORY.md` import on the first spawn.
    if (!SKIP_MEMORY_MD_FOLDERS.has(entry.name)) {
      if (fs.existsSync(memoryMdPath)) {
        plan.alreadyHaveMemoryMd.push(memoryMdPath);
      } else {
        plan.memoryMdToCreate.push(memoryMdPath);
      }
    }
  }

  return plan;
}

function memoryMdContent(folderName: string): string {
  return (
    `# Memory — ${folderName}\n\n` +
    '_Persistent notes the agent has accumulated about this group. ' +
    'Append facts the agent should recall in future sessions._\n'
  );
}

export function applyPlan(plan: Plan): void {
  for (const claudeMdPath of plan.vanillaToDelete) {
    fs.unlinkSync(claudeMdPath);
    console.log(`  deleted vanilla: ${claudeMdPath}`);
  }
  for (const memoryMdPath of plan.memoryMdToCreate) {
    const folderName = path.basename(path.dirname(memoryMdPath));
    fs.writeFileSync(memoryMdPath, memoryMdContent(folderName));
    console.log(`  created MEMORY.md: ${memoryMdPath}`);
  }
}

function printPlan(plan: Plan, applying: boolean): void {
  const verb = applying ? 'Will' : 'Would';
  console.log(
    `\n=== Migration plan${applying ? ' (APPLY)' : ' (DRY RUN — pass --apply to execute)'} ===\n`,
  );

  console.log(`${verb} delete (${plan.vanillaToDelete.length}) — vanilla template, mount takes over:`);
  for (const p of plan.vanillaToDelete) console.log(`    ${p}`);

  console.log(
    `\n${verb} create (${plan.memoryMdToCreate.length}) — MEMORY.md placeholder for @import resolution:`,
  );
  for (const p of plan.memoryMdToCreate) console.log(`    ${p}`);

  console.log(
    `\nLeft in place (${plan.customizedToWarn.length}) — customized, manual reconciliation required:`,
  );
  for (const w of plan.customizedToWarn) {
    console.log(
      `    ${w.path}  (${w.bytes} bytes, sha256=${w.sha.slice(0, 12)}…)`,
    );
    console.log(`        first line: ${w.firstLine}`);
  }

  console.log(`\nAlready migrated:`);
  console.log(
    `    ${plan.alreadyMissingClaudeMd.length} group(s) have no per-group CLAUDE.md (mount handles them)`,
  );
  console.log(
    `    ${plan.alreadyHaveMemoryMd.length} group(s) already have MEMORY.md`,
  );
  console.log('');
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const groupsDir = path.resolve(process.cwd(), 'groups');

  if (!fs.existsSync(groupsDir)) {
    console.error(
      `groups/ directory not found at ${groupsDir} — run from the project root.`,
    );
    process.exit(1);
  }

  const plan = buildPlan(groupsDir);
  printPlan(plan, apply);

  if (apply) {
    applyPlan(plan);
    console.log(`\n=== Done ===`);
    if (plan.customizedToWarn.length > 0) {
      console.log(
        `\n${plan.customizedToWarn.length} customized file(s) require manual reconciliation — see the warnings above.`,
      );
    }
  }
}

// Compare via pathToFileURL — `process.argv[1]` is often a relative
// path (e.g. `tsx scripts/migrate-thin-claude-md.ts` from the project
// root passes `scripts/...` here), and the previous
// `file://${process.argv[1]}` comparison silently fails to match in
// that case, leaving `main()` unrun and the script a quiet no-op.
const isMainModule =
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainModule) {
  main();
}
