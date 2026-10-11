# AGENTS.md

Technical reference for AI agents working on this codebase. See [README.md](./README.md) for user-facing docs.

## Project

ZET X (zet-x) — a zero-dependency ESM task runner for Node.js (>=18.19). Binary is `x`, config file is `x.config.mjs`. Users define commands via named exports, run with `x <command>`.

Repository: https://github.com/ArmCyber/zet-x

## Commands

```sh
npm run build                                # compile TypeScript (src/ → dist/)
npm test                                     # build + run all tests
node --test test/x.test.mjs                  # unit tests only
node --test test/integration.test.mjs        # integration tests only
node --test --test-name-pattern="pattern"    # run tests matching pattern
```

## Structure

```
src/              TypeScript source (compiled to dist/)
  index.ts        Core framework — registration, parsing, help, init()
  context.ts      ExecutionContext ($), buildRunParts, REST_SYMBOL, spawnCommand, PathHelper
  shared.ts       Shared types — CommandOutput, TemplateResult, TemplateFn, flattenParts
  util.ts         Shared helpers — outAnsi, errAnsi, isTaggedTemplate
  publish.ts      x cli publish ai/ide handlers
  types-generator.ts  Auto-regenerates .x/index.d.ts
  loader.ts       ESM resolve hook (maps 'zet-x' → ./index.js)
  register.ts     Registers the loader hook via module.registerHooks(), falling back to module.register() on older Node
  runner.ts       Entry point spawned by bin/x.mjs — imports config, calls init()
  update-check.ts Daily npm update check — state file, due/enabled rules, registry fetch, note
  update-worker.ts  Detached process that fetches the latest version and writes the state file
dist/             Compiled JS output (gitignored)
bin/x.mjs         CLI entry point (not compiled, stays .mjs)
test/
  x.test.mjs      Unit tests
  integration.test.mjs  Integration tests (spawns bin/x.mjs against temp dirs)
  update-check.test.mjs  Update check tests (local HTTP server stands in for the npm registry)
```

## Architecture

### Execution flow

```
bin/x.mjs  →  spawns child process  →  dist/runner.js  →  imports x.config.mjs  →  calls init()
```

1. **`bin/x.mjs`** — CLI entry. Handles `x init` and `x cli init-completion` before config search. Walks up from CWD to find `x.config.mjs`. Detects Node version for ESM loader strategy (`--import` + register for >=18.19/>=20.6, `--loader` for older). Calls `startUpdateCheck()` (see Update check), spawns runner with `X_ROOT_DIR` env var, and prints the update note after the runner exits.

2. **`src/loader.ts`** — ESM resolve hook. Maps bare specifier `'zet-x'` to `./index.js`.

3. **`src/runner.ts`** — Imports config file (side-effect registration), then calls `init()`. No `export default` required from config.

4. **`src/index.ts`** — Core framework. Named exports: `register`, `group`, `template`, `setAiPublishPath`, `setIdePublishPath`, `autoPublishIde`, `init`. Also exports classes/types for testing.

5. **`src/context.ts`** — `ExecutionContext` class (`$`) passed to `.callback(fn)`. Has `arg()`, `option()`, `run` (tagged template or variadic), `silent` (tagged template or variadic), `line/info/warn/error`, `confirm/prompt`, `root`/`user` (PathHelper), `cd()`.

### Key internals

- **Named exports** — `register()`, `group()`, `template()`. No singleton object; module-level state: `rootGroup`, `groups` Map. Template functions can return a string (split on whitespace) or an array. Zero-arg templates auto-execute when used without `()`.
- **`parseSignature(sig)`** — Tokenizes `'deploy {env} {--Force} ...'` using `TOKEN_RE`. Returns `{ name, args, options, acceptsRest }`.
- **Short flags** — Derived from uppercase starts of hyphen-separated segments: `--Preserve-Cache` → `-PC`. Long name stored lowercase.
- **`CommandBuilder`** — Fluent: `.description()`, `.run` (tagged template or variadic), `.userCwd()`, `.callback(fn)`.
- **`.run` overload** — `isTaggedTemplate()` detects tagged template vs variadic call. Tagged template: `buildRunParts()` splits static strings on whitespace, keeps interpolated values as single tokens, recognizes `...` as `REST_SYMBOL`, spreads `TemplateResult`. Variadic: `flattenParts()` recursively flattens arrays and `TemplateResult`.
- **`REST_SYMBOL`** — Unique symbol. `expandRestSymbol()` replaces it with actual rest args at execution time.
- **`ExecutionContext` ($)** — Created per callback. `$.run` and `$.silent` support both tagged template and variadic modes. `$.root`/`$.user` are `PathHelper` (callable + `Symbol.toPrimitive`).
- **`flattenParts(parts)`** — For `.run()` variadic mode. Recursively flattens `TemplateResult` and arrays into string[].
- **`RESERVED_NAMES`** — `new Set(["init", "cli"])`. Blocked in `register()` and `group()`.
- **Error handling** — `uncaughtException`/`unhandledRejection` format errors with filtered stack. Unknown commands suggest closest match via Levenshtein distance.
- **Signals** — `bin/x.mjs` forwards SIGINT/SIGTERM to the runner. When the runner dies from a signal, the bin removes its own handler for it and re-raises it, so `x` ends by that signal instead of exiting 0 (a 0 would let `x build && x deploy` carry on after Ctrl+C).
- **Auto-types** — `regenerateTypes()` writes `.x/index.d.ts` when `autoPublishIde()` is called in config (opt-in). Silently fails.

### Update check

`src/update-check.ts`, driven from `bin/x.mjs` (the runner is not involved). A note only — never blocks, delays or fails a command, and never prints an error.

- **State** — `$XDG_CACHE_HOME/zet-x/update-check.json` (default `~/.cache/zet-x/`): `{ lastCheck, latest, pending }`. `lastCheck` is the time of the last *successful* check, `latest` the version it saw, `pending` the start time of a check that may still be running.
- **Check** — `requestUpdateCheck()` runs before the command. If `lastCheck` is 24h+ old and no check is in flight (`isCheckDue()`), it stamps `pending` and spawns `dist/update-worker.js` detached (`stdio: "ignore"`, `unref()`), so the CLI never waits on the network.
- **Worker** — `refreshUpdateState()` GETs `https://registry.npmjs.org/zet-x/latest` (5s timeout). Success writes `lastCheck` + `latest`. Any failure (offline, DNS, timeout, non-200, bad JSON) only clears `pending`, leaving `lastCheck` untouched so the next run checks again.
- **Note** — after the runner exits, `getUpdateNotice()` re-reads the state and prints to stderr when `latest` is newer than the installed version (`isNewerVersion()`). It shows on every run until the user updates. `latest` must match `VERSION_RE` before it is printed.
- **Disabled** (`isUpdateCheckEnabled()`) — stderr not a TTY, `CI` set, `NO_UPDATE_NOTIFIER` set, `--completions`, or `X_ROOT_DIR` already set (an `x` started from inside an `x` command — only the outermost one reports). `x init`, `--version` and `cli init-completion` exit before the check.
- `node:http(s)` is imported lazily inside `fetchLatestVersion()` so only the worker loads it. The `http:` branch exists for tests.

See README.md for complete API reference tables.

## Built-in CLI Commands

- **`x init`** — In `bin/x.mjs` before config search. Creates `x.config.mjs`.
- **`x cli`** — Subcommand router in `init()`.
  - `x cli publish ai` — Writes `zet-x.md` (AI reference).
  - `x cli publish ide` — Generates `.d.ts` declarations.
  - `x cli init-completion <bash|zsh>` — In `bin/x.mjs`. Outputs shell completion script.
- **`x --completions`** — In `init()`. Outputs command names one per line for shell completion.

Reserved names: `init`, `cli`. Both `register()` and `group()` throw on these.

`x --help` does NOT show `cli` or `init` — only user-registered commands.

## Tests

- **`test/x.test.mjs`** — Unit tests. Imports from `dist/index.js`. Tests parsing, groups, templates, CommandOutput, help, buildRunParts, expandRestSymbol, CommandBuilder.run (tagged template and variadic), .userCwd.
- **`test/integration.test.mjs`** — Spawns `bin/x.mjs` against temp dirs. Uses `realpathSync` for macOS `/tmp` symlink. `writeConfig()` replaces `'zet-x'` with direct dist path. All tests set `NO_COLOR=1`.
- **`test/update-check.test.mjs`** — Imports from `dist/update-check.js`. Never touches the real registry or the real cache: a local `http` server (or a closed port, for "npm is down") is passed as the URL and state files live in temp dirs. `requestUpdateCheck` tests spawn the real detached worker. Spawned `bin/x.mjs` has piped stderr, so the update check is always off in the other test files.

## Conventions

- Zero runtime dependencies. Node built-ins only. TypeScript + @types/node are devDependencies.
- Source is TypeScript in `src/`, compiled to `dist/` via `tsc`. Tests stay as `.mjs`.
- Config files use named imports: `import { register } from 'zet-x'`. No `export default` required.
- Errors shown to users must be red, with stack traces filtered to user code only.
- Respect `NO_COLOR` env var and per-stream TTY detection.
