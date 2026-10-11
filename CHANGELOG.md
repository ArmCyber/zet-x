# Changelog

## [1.0.8]

### Fixed

- `x` exited with code 0 when it was interrupted with Ctrl+C or terminated, so in `x build && x deploy` the next command still ran. It now ends by the same signal, like any other interrupted command.

## [1.0.7]

### Added

- Update check — once a day `x` checks the npm registry in the background and, when a newer version of `zet-x` is available, prints a note after the command finishes: `Please run "npm install -g zet-x" to update.` It is only a note; nothing is enforced. If npm is unreachable the check is skipped silently and retried on the next run. Skipped when stderr is not a terminal, in CI, and when `NO_UPDATE_NOTIFIER` is set.

## [1.0.6]

### Fixed

- Node.js 26 printed `[DEP0205] DeprecationWarning: module.register() is deprecated` on every run. The loader hook is now registered with `module.registerHooks()` where available (Node >=22.15 / >=23.5) and falls back to `module.register()` on older versions.

## [1.0.5]

### Changed

- Move to GitHub

## [1.0.4]

### Added

- `$.line(msg)` — output plain text to stdout with no color formatting.

## [1.0.3]

### Fixed

- Fixed `[Symbol.toPrimitive]` in generated TypeScript declarations causing TS2585 errors in IDEs with older TypeScript lib targets.
- Fixed `$.confirm()` and `$.prompt()` always returning false/empty values.
- Fixed zsh tab completion not registering when loaded via `eval`.

### Changed

- `x cli publish ide` no longer creates a `.gitignore` in the output directory.
- `setIdePublishPath('path/')` now writes directly to `path/index.d.ts` instead of `path/.x/index.d.ts`.
- `x cli publish ide` no longer deletes the output directory before writing — it overwrites the file in place (safer for directories with other user files).

### Added

- `$.confirm(msg, default?)` — optional second parameter sets the default value (shown as `[Y/n]` or `[y/N]`). Invalid input re-prompts.
- `$.prompt(msg, default?)` — optional second parameter sets the default value returned on empty input.
- Documented in AI reference that `$.option()` flag names must be all lowercase regardless of registration.
- Documented that callbacks should be `async` for all features to work.

## [1.0.2]

### Changed

- Updated skill frontmatter `description` for better activation matching.

## [1.0.1]

### Added

- `setAiPublishPath(path, asSkill?)` — new optional second parameter `asSkill`. When `true`, `x cli publish ai` prepends YAML skill frontmatter (`name` and `description`) to the generated markdown file.

## [1.0.0]

Initial release.

- Zero-dependency ESM task runner for Node.js (>=18.19).
- `register()`, `group()`, `template()` for defining commands in `x.config.mjs`.
- `CommandBuilder` with `.run` (tagged template and variadic), `.callback()`, `.userCwd()`, `.description()`.
- `ExecutionContext` (`$`) with `arg()`, `option()`, `run`, `silent`, `mustRun`, `mustSilent`, `info`/`warn`/`error`, `confirm`/`prompt`, `root`/`user` PathHelpers, `cd()`.
- Template composition and nesting with auto-execution of zero-arg templates.
- Signature parsing with positional args, options, short flags, and rest args.
- Built-in CLI: `x init`, `x cli publish ai`, `x cli publish ide`, `x cli init-completion`.
- `setAiPublishPath()`, `setIdePublishPath()`, `autoPublishIde()` for configuring output paths.
- Shell completion for bash and zsh.
- Command suggestions via Levenshtein distance on typos.
- Filtered stack traces and colored error output (respects `NO_COLOR`).
