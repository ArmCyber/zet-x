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
dist/             Compiled JS output (gitignored)
bin/x.mjs         CLI entry point (not compiled, stays .mjs)
test/
  x.test.mjs      Unit tests
  integration.test.mjs  Integration tests (spawns bin/x.mjs against temp dirs)
```

## Architecture

### Execution flow

```
bin/x.mjs  →  spawns child process  →  dist/runner.js  →  imports x.config.mjs  →  calls init()
```

1. **`bin/x.mjs`** — CLI entry. Handles `x init` and `x cli init-completion` before config search. Walks up from CWD to find `x.config.mjs`. Detects Node version for ESM loader strategy (`--import` + register for >=18.19/>=20.6, `--loader` for older). Spawns runner with `X_ROOT_DIR` env var.

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
- **Auto-types** — `regenerateTypes()` writes `.x/index.d.ts` when `autoPublishIde()` is called in config (opt-in). Silently fails.

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

## Conventions

- Zero runtime dependencies. Node built-ins only. TypeScript + @types/node are devDependencies.
- Source is TypeScript in `src/`, compiled to `dist/` via `tsc`. Tests stay as `.mjs`.
- Config files use named imports: `import { register } from 'zet-x'`. No `export default` required.
- Errors shown to users must be red, with stack traces filtered to user code only.
- Respect `NO_COLOR` env var and per-stream TTY detection.
