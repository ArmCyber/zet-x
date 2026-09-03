# ZET X — AI Reference

AI agent reference for ZET X projects.

**Installation:** This package is installed globally with npm (`npm install -g zet-x`), not as a local project dependency.

## Config File

```js
import { register, group, template } from 'zet-x';

// register commands here
```

Config file must be named `x.config.mjs`. Commands are registered as side effects via named imports.

## Signature Syntax

```
command-name {arg} {arg?} {arg desc} {--option} {--option=} {--Option} {--Opt-Name=} ...
```

| Token | Meaning |
|---|---|
| `{name}` | Required positional argument |
| `{name?}` | Optional positional argument |
| `{name description}` | Required argument with description |
| `{name? description}` | Optional argument with description |
| `{--name}` | Boolean option (flag) |
| `{--name=}` | Option that accepts a value |
| `{--Name}` | Boolean option with short flag `-N` |
| `{--Preserve-Cache=}` | Value option with short flag `-PC` |
| `...` | Accept extra arguments (rest) |

Short flags are derived from uppercase letters at the start of hyphen-separated segments.

## API

### Registration

- `register(signature, description?)` → `CommandBuilder` — Register a root command
- `group(prefix, description)` → `Group` — Create a command group
- `group.register(signature, description?)` → `CommandBuilder` — Register a command in a group

### CommandBuilder (fluent)

- `.description(text)` → `this`
- `.run\`cmd args ...\`` → `this` — Tagged template: define command to spawn (recommended)
- `.run(...parts)` → `this` — Variadic: define command with string parts
- `.userCwd()` → `this` — Run from user's CWD instead of project root
- `.callback(fn)` → `this` — Run a callback (`fn` receives `$: ExecutionContext`, can be async)

### Templates

- `template(fn)` → template function — `fn` receives args, returns a `string` (split on whitespace) or `string[]`
- **Prefer `string` return type** unless the user's existing config uses `string[]` or the command is too long/complex
- Call the returned function to get a `TemplateResult` for use in `.run`
- Zero-arg templates can be used without `()`: `\${compose}` is the same as `\${compose()}`
- Templates can be nested: a template can return other `TemplateResult` values in its array

### ExecutionContext ($)

Passed to `.callback(fn)` (callbacks should be `async` for all features to work):

- `$.arg(name)` → `string | null`
- `$.option('--name')` → `string | true | null` — flag name must be all lowercase regardless of registration (e.g., `{--Force}` → `$.option('--force')`)
- `$.run\`cmd args\`` — Spawn with inherited stdio (also accepts variadic args)
- `$.mustRun\`cmd args\`` — Like `$.run` but throws on non-zero exit code
- `$.silent\`cmd args\`` — Spawn with piped stdio, returns `CommandOutput` (also accepts variadic args)
- `$.mustSilent\`cmd args\`` — Like `$.silent` but throws on non-zero exit code
- `$.info(msg)` — Green, stdout
- `$.warn(msg)` — Yellow, stderr
- `$.error(msg)` — Red, stderr
- `$.confirm(msg, default?)` — Yellow prompt `[y/N]` or `[Y/n]`, returns `boolean`. Re-prompts on invalid input. Empty input returns `default` (default: `false`)
- `$.prompt(msg, default?)` — Cyan prompt, returns the answer. Empty input returns `default` (default: `""`)
- `$.root` — Project root PathHelper (callable: `$.root('src')`, or string: `\`\${$.root}\``)
- `$.user` — User CWD PathHelper
- `$.cd(path)` — Change working directory for subsequent run/silent calls

`$.run` does not throw on failure — use `$.mustRun` or chain `.throw()` to stop on errors.

### CommandOutput

Returned by `$.silent`:

- `.code` — Exit code
- `.output` — Combined stdout+stderr (silent only)
- `.stdout` / `.stderr` — Separated output (silent only)
- `.succeeded` / `.failed` — Boolean getters
- `.throw()` — Throw if failed, return `this` if succeeded

### CLI Config

- `setAiPublishPath(path, asSkill?)` — Set output path for `x cli publish ai`. When `asSkill` is `true`, prepends YAML frontmatter (name + description) to the output
- `setIdePublishPath(path)` — Set output path for `x cli publish ide` (writes `index.d.ts` directly into the specified directory)
- `autoPublishIde()` — Auto-regenerate `.x/index.d.ts` on every `x` run

## Groups

The names `init` and `cli` are reserved. Groups organize commands under a prefix:

```js
const db = group('db', 'Database');
db.register('import ...', 'Import database').run\`docker compose exec db import ...\`;
```

```sh
x db migrate --fresh
```

## Guidelines for AI Agents

When working on ZET X projects:

1. **Respect existing style** — Always prefer the way the user has already implemented things in their `x.config.mjs`. Match their patterns and conventions.

2. **Auto IDE updates** — Never enable/disable `autoPublishIde()` unless the user explicitly requests it.

3. **Default hello command** — The `hello` command is scaffolding. If it's the only command and just returns "Hello from ZET X!", remove it. Otherwise, preserve all existing commands unless explicitly told to remove them.

4. **Minimize custom logic** — Avoid adding custom constraints or complex logic unless requested or strongly needed for DRY principles. Prefer using templates for reusable command patterns (but not for simple 1-word parameters).

5. **Template composition** — Templates can use other templates. This is normal practice — use it freely to build composable command patterns.
