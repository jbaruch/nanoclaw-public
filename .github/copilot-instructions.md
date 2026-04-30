# Copilot Instructions for nanoclaw-public

Trust these instructions. Only fall back to repo-wide search if something
here is incomplete or proven wrong by a command failure.

## What this repo is

NanoClaw is a personal Claude assistant that runs in Docker containers and
talks to messaging apps (WhatsApp, Telegram, Slack, Discord, Gmail). The
host orchestrator is a TypeScript / Node ESM app that spawns per-group
containers (`container/Dockerfile`) which run the Anthropic Claude Agent
SDK via `container/agent-runner` (separate npm project). User-facing
features are added via **skills** (markdown files under `.claude/skills/`
or `container/skills/`) — *not* by adding source-code features. See
`CONTRIBUTING.md`: "Source code changes only accepted for bug fixes,
security fixes, simplifications, reducing code. Features must be skills."

- Language: TypeScript (~90%), Bash (~6%), Emacs Lisp (~2%), Python (~1%).
- Repo size: ~13 MB. Top-level `src/` has ~50 `.ts` files; entry is
  `src/index.ts`. Big files: `src/container-runner.ts` (~79 KB),
  `src/index.ts` (~45 KB), `src/ipc.ts` (~42 KB), `src/db.ts` (~39 KB).
- Default branch: `main`. License: MIT. This is a fork of
  `qwibitai/nanoclaw`; upstream issues live there (`gh issue list --repo
  qwibitai/nanoclaw`). Issues are disabled on this fork.
- The orchestrator is a long-running daemon driven by `launchd` (macOS).
  It is **not** a library and there is nothing to "deploy" from a CI run —
  CI only validates correctness.

## Build, lint, test — the only commands CI runs

CI (`.github/workflows/ci.yml`, runs on every PR to `main`) does, in
this exact order, on `ubuntu-latest` with `actions/setup-node@v4` at
`node-version: 20`:

```
npm ci
npm run format:check     # prettier --check "src/**/*.ts"
npx tsc --noEmit         # typecheck (same as `npm run typecheck`)
npx vitest run           # tests (same as `npm test`)
```

**Always run these four, in this order, before pushing.** If any fails,
the PR check will fail.

### Environment requirements (validated)

- **Node.js 20+ is required** (`package.json` `engines.node: ">=20"`,
  `type: "module"`). `.nvmrc` says `22` (used locally); CI uses 20. Both
  work. Node <20 will fail `npm ci` because of `better-sqlite3@11.10.0`
  and `vitest@^4`.
- **Use `npm ci`, not `npm install`**, for a clean, reproducible install
  matching `package-lock.json`. `npm install` will rewrite the lockfile
  and CI will not match.
- `npm ci` also runs `prepare: husky` which installs the pre-commit hook
  (`.husky/pre-commit` runs `npm run format:fix`). This is harmless in
  CI/sandbox but if `husky` fails because there's no `.git` directory
  (rare), run `npm ci --ignore-scripts` then continue.
- Native module: `better-sqlite3` compiles on install. On Linux this
  needs `python3`, `make`, and a C++ toolchain (present on
  `ubuntu-latest`). On a stripped sandbox install, prebuilt binaries
  are usually fetched; if compilation fails, install build-essential.
- No `.env` is needed for build/typecheck/test. The CI-only secrets in
  `.env.example` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TESSL_TOKEN`)
  are consumed only by the policy-review workflows, not by `npm test`.

### Lint vs. format — important gotcha

CI runs **`format:check` (Prettier)**, not ESLint. ESLint is configured
(`eslint.config.js`) and exposed via `npm run lint`, but **the CI
workflow does not run it**. Still, run `npm run lint` before pushing
non-trivial changes — it enforces project-specific rules:

- `'preserve-caught-error'` (custom): every `catch` must declare its
  parameter. Use `catch (err)` or `catch (_err)`, never bare `catch {}`.
- `no-catch-all/no-catch-all`: warns on overly broad catches.
- `@typescript-eslint/no-unused-vars` is **error**. Prefix intentionally
  unused names with `_` (`_err`, `_arg`).
- `@typescript-eslint/no-explicit-any`: warning, avoid `any`.
- ESLint ignores `node_modules/`, `dist/`, `container/`, `groups/`, so
  changes under `container/` are not linted at the root level.

If you change formatting, **always run `npm run format:fix` before
committing** — `format:check` will fail otherwise. Prettier config
(`.prettierrc`) is just `{"singleQuote": true}`.

### Tests

- Runner: Vitest 4. Config `vitest.config.ts` includes
  `src/**/*.test.ts` and `setup/**/*.test.ts`. Tests are colocated with
  source (e.g. `src/db.ts` ↔ `src/db.test.ts`).
- A second config `vitest.skills.config.ts` covers
  `.claude/skills/**/tests/*.test.ts` and is **not** run by CI; only
  invoke it explicitly if you touch skills with tests:
  `npx vitest run --config vitest.skills.config.ts`.
- Run a single file: `npx vitest run src/timezone.test.ts`. Watch:
  `npm run test:watch`.
- Tests are hermetic — they create temp dirs / temp SQLite DBs. No
  network, no Docker, no real messenger credentials are required. If a
  test needs Docker (a few `container-runner.*.test.ts` shell out via
  mocks), it mocks `child_process`; do not assume Docker must be
  installed.

### Build (rarely needed)

- `npm run build` → `tsc` emits to `dist/` (gitignored). Required only
  if you run `npm start`. CI does **not** run `npm run build` — it uses
  `tsc --noEmit`. The runtime path in production uses `tsx` via the
  launchd plist, not the compiled output.
- `container/agent-runner/` is a **separate npm project** with its own
  `package.json` and `tsconfig.json` (no lockfile, no tests, not
  covered by root CI). If you change files there, `cd container/agent-runner && npm install && npx tsc --noEmit` to validate locally. The
  container image build (`container/build.sh` → `container/Dockerfile`)
  is not part of CI.

### Setup / dev / run

- `npm run dev` → `tsx src/index.ts` (host orchestrator). Needs a real
  `.env`, sqlite store, etc. Do not attempt this in a CI sandbox.
- `npm run setup` → interactive `tsx setup/index.ts`. Don't run
  unattended.
- `setup.sh` and shell scripts under `scripts/` are operator tooling for
  the maintainer's host (deploy, log rotation, sync to public mirror).
  They are **not** part of build/test and should not be invoked by an
  agent making code changes.

## Project layout (so you don't have to grep)

```
/                         repo root
├── src/                  TypeScript orchestrator (entry: index.ts)
│   ├── index.ts                main loop / launchd entry
│   ├── container-runner.ts     spawns/manages per-group containers
│   ├── container-runtime.ts    docker/podman abstraction
│   ├── ipc.ts, ipc-auth.ts     host ↔ container IPC
│   ├── credential-proxy.ts     secret access for containers
│   ├── db.ts, db-migration.ts  better-sqlite3 store + migrations
│   ├── group-queue.ts          per-group message queue
│   ├── task-scheduler.ts       cron-style scheduled tasks
│   ├── router.ts, routing.ts   message routing
│   ├── formatting.ts, text-styles.ts  channel formatting
│   ├── mount-security.ts, sender-allowlist.ts  security gates
│   ├── channels/               per-channel adapters (Telegram, etc.)
│   └── *.test.ts               Vitest tests, colocated
├── container/            container image + agent runner
│   ├── Dockerfile              container image (Claude Code inside)
│   ├── entrypoint.sh, build.sh
│   ├── agent-runner/           separate npm project (Claude SDK)
│   └── skills/                 container-side skills (markdown)
├── setup/                interactive `npm run setup` flow + tests
├── scripts/              operator shell scripts (not for CI)
│   └── run-migrations.ts       DB migration runner (tsx)
├── groups/               per-group config (mostly gitignored)
├── docs/                 design docs (skills-as-branches.md, etc.)
├── config-examples/, launchd/, emacs/, assets/, repo-tokens/
├── .claude/, .agents/, .codex/  agent instruction surfaces (gitignored
│                                except .claude tracked bits)
├── .github/workflows/    ci.yml, label-pr.yml, bump-version.yml,
│                         update-tokens.yml, review-{openai,anthropic}*
├── .github/PULL_REQUEST_TEMPLATE.md   PR template — see "Pull Requests"
├── .github/CODEOWNERS
├── tsconfig.json         strict, ES2022, NodeNext, src→dist
├── eslint.config.js      flat config (see "Lint vs. format")
├── vitest.config.ts, vitest.skills.config.ts
├── .prettierrc           {"singleQuote": true}
├── .nvmrc                22 (CI uses 20; both work, ≥20 required)
├── package.json, package-lock.json
├── docker-compose.yml, Dockerfile.orchestrator
├── tessl.json            Tessl manifest (vendored tiles in .tessl/)
├── README.md, README_ja.md, README_zh.md
├── CONTRIBUTING.md, CODE_OF_CONDUCT.md, CONTRIBUTORS.md, CHANGELOG.md
└── CLAUDE.md             instructions for Claude Code on the host
```

## Other CI workflows

- `label-pr.yml` (PR opened/edited): reads checkboxes in the PR body and
  applies labels (`PR: Skill`, `PR: Fix`, `PR: Refactor`, `PR: Docs`,
  etc.). **Always use `.github/PULL_REQUEST_TEMPLATE.md` and check
  exactly one type box** — failing to do so leaves the PR unlabeled.
  Including the line `contributing-guide: v1` in the body adds the
  `follows-guidelines` label.
- `review-anthropic.lock.yml` and `review-openai.lock.yml`: AI policy
  reviewers (Tessl coding-policy). They run on PRs and post review
  comments. They need repo secrets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `TESSL_TOKEN`. They do not block merge but their comments should be
  addressed. The `.lock.yml` files are generated; **do not hand-edit**
  — edit the corresponding `review-*.md` source if a change is needed.
- `bump-version.yml`, `update-tokens.yml`: maintenance automation, not
  relevant to code PRs.

## Coding conventions to avoid CI churn

- **Single quotes** in TS (`.prettierrc`). 2-space indent (Prettier
  default). Always run `npm run format:fix` before committing.
- ESM only (`"type": "module"`). Use `import` with explicit `.js`
  extensions for relative imports compiled by NodeNext (e.g.
  `import { foo } from './bar.js'`). TypeScript files compile to `.js`.
- Strict TS — fix all errors; don't add `// @ts-ignore` without a
  reason comment. Avoid `any`.
- Never write `try { ... } catch { ... }`; ESLint rule
  `preserve-caught-error` will fail the lint pass. Use
  `catch (err)` or `catch (_err)`.
- Tests live next to the code they test as `*.test.ts` and are picked up
  by Vitest automatically. Add tests for any new logic in `src/`.
- Don't commit anything matching `.gitignore` — notably `dist/`, `.env`,
  `node_modules/`, `data/`, `store/`, `logs/`, `.tessl/tiles/`,
  `.claude/skills/tessl__*`, `AGENTS.md`.
- Keep PRs focused on one change (`CONTRIBUTING.md`: "One thing per PR").
- For new user-facing capabilities, prefer adding a **skill** under
  `.claude/skills/` (host) or `container/skills/` (container) over
  modifying `src/`. See `CONTRIBUTING.md` for skill types.

## Quick validation recipe before any PR

```
nvm use 20 || nvm use 22       # any Node ≥20
npm ci                          # NOT `npm install`
npm run format:fix              # auto-fix formatting
npm run lint                    # local-only, but recommended
npx tsc --noEmit
npx vitest run
```

If all four (format:check / lint / tsc / vitest) pass locally, the
`CI` check on the PR will pass.
