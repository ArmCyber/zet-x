# ZET X

> **X** stands for **execute** — a lightweight task runner for your project.

A project-level task runner for teams. Define dev commands in a config file, run them with `x <command>`.

> This is not a CLI framework like Commander or Yargs. Those help you build CLIs. This is a task runner — it runs your project's commands.

## Install

```sh
npm install -g zet-x
```

Requires Node.js ^18.19 or >=20.6.

### Shell Completion (Optional)

Add to your shell profile to enable tab completions in your terminal:

```sh
# bash
eval "$(x cli init-completion bash)"

# zsh (macOS)
eval "$(x cli init-completion zsh)"
```

Common shell profile locations:
- **bash**: `~/.bashrc` or `~/.bash_profile`
- **zsh**: `~/.zshrc`

## Getting Started

```sh
mkdir my-project && cd my-project
x init
x hello
```

`x init` creates an `x.config.mjs` with a starter command. Edit it to add your own. Run `x` or `x --help` to see all registered commands.

## Configuration File

`x` traverses up from the current directory looking for `x.config.mjs`. Commands are registered as side effects via named imports.

```js
import { register } from 'zet-x';

register('up', 'Start containers')
  .run`docker compose up -d`;
```

## API Reference

### Command Registration

```js
import { register, group } from 'zet-x';

// Simple command
register('up', 'Start containers')
  .run`docker compose up -d`;

// With signature (args, options, rest)
register('deploy {env} {--Force}', 'Deploy to environment')
  .callback(async ($) => {
    const env = $.arg('env');
    $.info(`Deploying to ${env}...`);
    if ($.option('--force')) $.warn('Force deploy enabled');
    await $.mustRun`deploy.sh ${env}`;
  });

// Group
const db = group('db', 'Database');
db.register('migrate ...', 'Run migrations').run`docker compose exec app migrate ...`;
```

### Signature Syntax

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

Short flags are derived from uppercase letters at the start of hyphen-separated segments: `--Preserve-Cache` -> `-PC`. The long name is always stored lowercase.

### `.run` — Defining Commands

`.run` works as both a tagged template (recommended) and a regular function call.

**Tagged template (recommended)** — whitespace in static parts is split into separate arguments. Interpolated values are kept as single tokens (safe for paths with spaces).

```js
register('build', 'Build project').run`npm run build`;

// Interpolation keeps the value as one token
const target = 'my output dir';
register('clean', 'Clean output').run`rm -rf ${target}`;

// Rest args with ...
register('npm ...', 'Run npm').run`npm ...`;
// x npm install lodash  ->  npm install lodash
```

**Function call** — also accepts variadic string arguments for programmatic use.

```js
register('up', 'Start containers').run('docker', 'compose', 'up', '-d');
```

### `.userCwd()` Method

Run a command from the user's current working directory instead of the project root:

```js
register('ls', 'List files')
  .userCwd()
  .run`ls -la`;
```

### Templates

Reuse common command prefixes:

```js
import { register, template } from 'zet-x';

const compose = template((service) => ['docker', 'compose', 'exec', '-it', service]);

register('shell', 'Open shell')
  .run`${compose('app')} bash`;

register('migrate ...', 'Run migrations')
  .run`${compose('app')} migrate ...`;
```

Template functions can return an array of strings or a single string (which gets split on whitespace). Templates validate argument count based on `fn.length`. Zero-arg templates can be used without `()` — `${compose}` works the same as `${compose()}`.

### Callback with `$` Context

Callbacks receive an `ExecutionContext` object (`$`) with everything needed to run commands and access parsed arguments. Callbacks should be `async` for all features to work:

```js
register('deploy {env} {--Verbose}')
  .callback(async ($) => {
    const env = $.arg('env');       // string | null
    const verbose = $.option('--verbose');  // string | true | null

    // Run a command (output visible) — does not throw on failure
    await $.run`deploy.sh ${env}`;

    // Run and throw on failure
    await $.mustRun`deploy.sh ${env}`;

    // Run silently (capture output)
    const result = await $.silent`git rev-parse HEAD`;
    $.info(`Deployed ${result.stdout.trim()}`);
  });
```

`$.run` and `$.silent` also accept variadic args: `await $.run('docker', 'compose', 'up')`.

`$.run` does not throw on failure — use `$.mustRun` or chain `.throw()` to stop on errors.

#### `$` Methods

| Method | Description |
|---|---|
| `$.arg(name)` | Get parsed argument (`string \| null`) |
| `$.option('--name')` | Get option (`string \| true \| null`) |
| `$.run\`cmd\`` | Spawn with inherited stdio |
| `$.mustRun\`cmd\`` | Like `$.run` but throws on non-zero exit code |
| `$.silent\`cmd\`` | Spawn with piped stdio, returns `CommandOutput` |
| `$.mustSilent\`cmd\`` | Like `$.silent` but throws on non-zero exit code |
| `$.line(msg)` | Plain text to stdout (no color) |
| `$.info(msg)` | Green message to stdout |
| `$.warn(msg)` | Yellow message to stderr |
| `$.error(msg)` | Red message to stderr |
| `$.confirm(msg, default?)` | Yellow prompt `[y/N]` or `[Y/n]`, returns `boolean`. Re-prompts on invalid input |
| `$.prompt(msg, default?)` | Cyan prompt, returns the answer. Empty input returns `default` |
| `$.root` | Project root — callable: `$.root('src')`, or string: `` `${$.root}` `` |
| `$.user` | User CWD — callable: `$.user('test')`, or string: `` `${$.user}` `` |
| `$.cd(path)` | Change working directory for subsequent `run`/`silent` calls |

`$.root` and `$.user` are `PathHelper` objects — they work as both functions and strings via `Symbol.toPrimitive`.

#### `CommandOutput`

Returned by `$.silent`:

| Property | Type |
|---|---|
| `.code` | `number` |
| `.output` | `string \| null` (combined stdout+stderr) |
| `.stdout` | `string \| null` |
| `.stderr` | `string \| null` |
| `.succeeded` | `boolean` |
| `.failed` | `boolean` |
| `.throw()` | Throws if failed, returns `this` if succeeded |

### Groups

Organize commands under a prefix:

```js
import { group } from 'zet-x';

const db = group('db', 'Database');
db.register('migrate ...', 'Run migrations').run`docker compose exec app migrate ...`;
db.register('seed', 'Seed database').run`docker compose exec app db-seed`;
```

```sh
x db migrate --fresh
x db seed
```

The names `init` and `cli` are reserved and cannot be used as group prefixes or command names.

### Splitting Config Files

Use standard ES module imports to split your config across multiple files:

```js
// x.config.mjs
import { register } from 'zet-x';
import './x/docker.mjs';
import './x/deploy.mjs';

register('hello', 'Say hello').run`echo hi`;
```

```js
// x/docker.mjs
import { register, template } from 'zet-x';

const compose = template((service) => ['docker', 'compose', 'exec', '-it', service]);
register('shell', 'Open shell').run`${compose('app')} bash`;
```

Templates and groups defined in one file are available to all files — they share the same module singleton. Export a template from a shared file and import it wherever needed:

```js
// x/shared.mjs
import { template } from 'zet-x';
export const compose = template((service) => ['docker', 'compose', 'exec', '-it', service]);
```

```js
// x/docker.mjs
import { register } from 'zet-x';
import { compose } from './shared.mjs';

register('shell', 'Open shell').run`${compose('app')} bash`;
register('logs', 'View logs').run`docker compose logs -f`;
```

### Config Paths

```js
import { setAiPublishPath, setIdePublishPath, autoPublishIde } from 'zet-x';

setAiPublishPath('docs/');                             // zet-x.md -> docs/zet-x.md
setAiPublishPath('.ai/guidelines/sample-name.md');     // exact file path
setAiPublishPath('.claude/skills/SKILL.md', true);     // prepend skill frontmatter (name + description)
setIdePublishPath('.types/');                          // .d.ts -> .types/index.d.ts
autoPublishIde();                                      // auto-regenerate .x/index.d.ts on every run
```

## Built-in Commands

### `x init`

Creates `x.config.mjs` in the current directory with a starter command.

### `x cli publish ai`

Generates `zet-x.md` — an AI agent reference for your project's commands. By default writes to the project root. Configure with `setAiPublishPath()`. Pass `true` as the second argument to prepend YAML skill frontmatter (name + description).

### `x cli publish ide`

Generates TypeScript declarations for IDE autocompletion. By default writes to `.x/`. Configure with `setIdePublishPath()`.

### `x cli init-completion <bash|zsh>`

Outputs a shell completion script.

### Auto-generated Help

```sh
x --help           # global help
x <command> --help  # command-specific help
```

### Auto-generated Types

When `autoPublishIde()` is called in your config, `x` regenerates `.x/index.d.ts` with TypeScript declarations for IDE support on every run. This happens silently and never breaks normal operation. You can also generate types on demand with `x cli publish ide`.

## Full Example

```js
import { register, group, template, setAiPublishPath } from 'zet-x';

setAiPublishPath('docs/');

const compose = template((service) => ['docker', 'compose', 'exec', '-it', service]);

// Groups
const db = group('db', 'Database');
db.register('migrate ...', 'Run migrations')
  .run`${compose('app')} db-migrate ...`;
db.register('seed', 'Seed database')
  .run`${compose('app')} db-seed`;

// Root commands
register('up', 'Start all containers')
  .run`docker compose up -d`;

register('down', 'Stop all containers')
  .run`docker compose down`;

register('deploy {env} {--Force}', 'Deploy to environment')
  .callback(async ($) => {
    const env = $.arg('env');
    if ($.option('--force')) {
      $.warn('Force deploy — skipping checks');
    } else if (!await $.confirm(`Deploy to ${env}?`)) {
      return;
    }
    $.info(`Deploying to ${env}...`);
    await $.mustRun`deploy.sh ${env}`;
  });
```

## How It Works

1. `x` binary traverses up from CWD to find `x.config.mjs`
2. Sets up a module resolution hook so the config can `import { register } from 'zet-x'`
3. Imports the config (side effects register commands), then runs the matched command
4. Commands run from the project root — use `$.root` and `$.user` in callbacks to resolve paths, or `.userCwd()` to run from the user's directory

## Test

```sh
npm test
```
