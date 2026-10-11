import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const BIN = join(fileURLToPath(import.meta.url), "..", "..", "bin", "x.mjs");
const LIB = join(fileURLToPath(import.meta.url), "..", "..", "dist", "index.js");

function run(cwd, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
    });
  });
}

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), "x-integ-")));
}

function writeConfig(dir, script) {
  // Use direct path import for most tests to isolate from loader concerns
  writeFileSync(
    join(dir, "x.config.mjs"),
    script.replace(/'zet-x'/g, `'${LIB}'`)
  );
}

function writeRealConfig(dir, script) {
  // Use bare 'zet-x' import — relies on the loader hook set up by bin/x.mjs
  writeFileSync(join(dir, "x.config.mjs"), script);
}

describe("integration", () => {
  it("exits 1 when no config found", async () => {
    const dir = tmpDir();
    const result = await run(dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot find x\.config\.mjs/);
  });

  it("executes a simple shell command via .run", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run\`echo hello world\`;
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hello world/);
  });

  it("executes a simple shell command via .run() variadic", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hello world');
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hello world/);
  });

  it("passes arguments to callback via $ context", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('greet {name}')
   .callback(($) => {
     process.stdout.write('Hello ' + $.arg('name'));
   });
`
    );
    const result = await run(dir, ["greet", "World"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Hello World/);
  });

  it("handles group commands", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { group } from 'zet-x';
const be = group('be', 'Back-End');
be.register('ping')
  .description('Ping backend')
  .run('echo', 'pong');
`
    );
    const result = await run(dir, ["be", "ping"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /pong/);
  });

  it("shows global help with --help", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { group, register } from 'zet-x';
const be = group('be', 'Back-End services');
be.register('temp').description('smth');
register('up').description('UP All Containers');
`
    );
    const result = await run(dir, ["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: x <command>/);
    assert.match(result.stdout, /Back-End services/);
    assert.match(result.stdout, /be temp/);
    assert.match(result.stdout, /smth/);
    assert.match(result.stdout, /up/);
    assert.match(result.stdout, /UP All Containers/);
  });

  it("shows global help with no args", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').description('Say hello');
`
    );
    const result = await run(dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: x <command>/);
  });

  it("shows command help with --help", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('build {target} {--Verbose}')
   .description('Build the project');
`
    );
    const result = await run(dir, ["build", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: x build/);
    assert.match(result.stdout, /Build the project/);
    assert.match(result.stdout, /--verbose/);
    assert.match(result.stdout, /--help/);
  });

  it("forwards rest args with ... in .run", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('run ...').run\`echo ...\`;
`
    );
    const result = await run(dir, ["run", "a", "b", "c"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /a b c/);
  });

  it("$.user returns the user CWD", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('cwd')
   .callback(($) => {
     process.stdout.write($.user());
   });
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["cwd"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, sub);
  });

  it("$.root returns the project root", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('root')
   .callback(($) => {
     process.stdout.write($.root());
   });
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["root"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, dir);
  });

  it("$.user() and $.root() join subpaths", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('paths')
   .callback(($) => {
     process.stdout.write(JSON.stringify({
       userSub: $.user('test'),
       rootSub: $.root('src'),
     }));
   });
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["paths"]);
    assert.equal(result.code, 0);
    const paths = JSON.parse(result.stdout);
    assert.equal(paths.userSub, join(sub, "test"));
    assert.equal(paths.rootSub, join(dir, "src"));
  });

  it("forwards exit codes", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('fail')
   .callback(() => {
     process.exit(42);
   });
`
    );
    const result = await run(dir, ["fail"]);
    assert.equal(result.code, 42);
  });

  it("rejects reserved 'cli' group prefix", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { group } from 'zet-x';
group('cli', 'CLI');
`
    );
    const result = await run(dir, ["--help"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /reserved/);
  });

  it("errors on unknown command", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["nonexistent"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown command/);
  });

  it("suggests closest command on typo", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
register('build').run('echo', 'building');
`
    );
    const result = await run(dir, ["helo"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Did you mean: x hello/);
  });

  it("errors on missing required argument", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('greet {name}')
   .callback(() => {});
`
    );
    const result = await run(dir, ["greet"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /missing required argument/);
  });

  it("handles options in callback via $ context", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('build {--verbose} {--output=}')
   .callback(($) => {
     const parts = [];
     if ($.option('--verbose')) parts.push('verbose');
     if ($.option('--output')) parts.push('out=' + $.option('--output'));
     process.stdout.write(parts.join(','));
   });
`
    );
    const result = await run(dir, ["build", "--verbose", "--output=dist"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "verbose,out=dist");
  });

  it("finds config in parent directory", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('found').run('echo', 'found-it');
`
    );
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const result = await run(nested, ["found"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /found-it/);
  });

  it("resolves 'zet-x' bare import via loader hook", async () => {
    const dir = tmpDir();
    writeRealConfig(
      dir,
      `
import { register } from 'zet-x';
register('ping').run('echo', 'loader-works');
`
    );
    const result = await run(dir, ["ping"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /loader-works/);
  });

  it("registers the loader hook without a Node deprecation warning", async () => {
    const dir = tmpDir();
    writeRealConfig(
      dir,
      `
import { register } from 'zet-x';
register('ping').run('echo', 'loader-works');
`
    );
    const result = await run(dir, ["ping"]);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /DeprecationWarning/);
  });

  it("shows friendly error for duplicate command (no raw stack trace)", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
register('hello').run('echo', 'hi again');
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /x: Duplicate command 'hello'/);
    assert.match(result.stderr, /x\.config\.mjs/);
    assert.doesNotMatch(result.stderr, /node:internal/);
  });

  it("config without export default works (named imports only)", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hi/);
  });

  it("template used in .run() variadic mode", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, template } from 'zet-x';
const artisan = template(() => ['artisan', 'migrate']);
register('migrate ...')
   .run('echo', 'exec', artisan());
`
    );
    const result = await run(dir, ["migrate"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /exec artisan migrate/);
  });

  it("template interpolated in .run tagged template", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, template } from 'zet-x';
const artisan = template(() => ['artisan', 'migrate']);
register('migrate ...').run\`echo exec \${artisan()} ...\`;
`
    );
    const result = await run(dir, ["migrate", "--seed"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /exec artisan migrate --seed/);
  });

  it("$.silent captures output in callback", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('capture')
   .callback(async ($) => {
     const result = await $.silent\`echo captured\`;
     process.stdout.write('GOT:' + result.output.trim());
   });
`
    );
    const result = await run(dir, ["capture"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "GOT:captured");
  });

  it("$.run executes a command in callback", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('doit')
   .callback(async ($) => {
     await $.run\`echo from-context\`;
   });
`
    );
    const result = await run(dir, ["doit"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /from-context/);
  });

  it("register with description shorthand", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello', 'Say hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["hello", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Say hello/);
  });
});

describe("x init", () => {
  it("creates x.config.mjs in empty directory", async () => {
    const dir = tmpDir();
    const result = await run(dir, ["init"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Created x\.config\.mjs/);
    assert.ok(existsSync(join(dir, "x.config.mjs")));
    const content = readFileSync(join(dir, "x.config.mjs"), "utf8");
    assert.match(content, /import \{ register \} from 'zet-x'/);
  });

  it("errors when x.config.mjs already exists", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "x.config.mjs"), "// existing");
    const result = await run(dir, ["init"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already initialized/);
  });

  it("does not traverse to parent directory", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "x.config.mjs"), "// parent config");
    const sub = join(dir, "child");
    mkdirSync(sub);
    const result = await run(sub, ["init"]);
    assert.equal(result.code, 0);
    assert.ok(existsSync(join(sub, "x.config.mjs")));
  });
});

describe("auto-types", () => {
  it("does NOT generate .x/index.d.ts by default", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 0);
    assert.ok(!existsSync(join(dir, ".x", "index.d.ts")));
  });

  it("generates .x/index.d.ts when autoPublishIde() is called", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, autoPublishIde } from 'zet-x';
autoPublishIde();
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["hello"]);
    assert.equal(result.code, 0);
    const dts = readFileSync(join(dir, ".x", "index.d.ts"), "utf8");
    assert.match(dts, /declare module "zet-x"/);
    assert.match(dts, /ExecutionContext/);
    assert.match(dts, /CommandBuilder/);
  });
});

describe("x cli", () => {
  it("x cli shows help listing subcommands", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /publish/);
    assert.match(result.stdout, /init-completion/);
  });

  it("x cli --help shows help", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: x cli/);
  });

  it("x cli unknown-command errors", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "nonexistent"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown cli command/);
  });
});

describe("x cli publish", () => {
  it("x cli publish --help shows publish subcommands", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /\bai\b/);
    assert.match(result.stdout, /\bide\b/);
    assert.match(result.stdout, /Usage: x cli publish <command>/);
  });

  it("x cli publish with no args shows help", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /\bai\b/);
    assert.match(result.stdout, /\bide\b/);
  });

  it("x cli publish ai creates zet-x.md in project root (default)", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ai"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Created/);
    const content = readFileSync(join(dir, "zet-x.md"), "utf8");
    assert.match(content, /AI agent reference/);
  });

  it("x cli publish ai creates zet-x.md in configured directory path", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, setAiPublishPath } from 'zet-x';
setAiPublishPath('docs/');
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ai"]);
    assert.equal(result.code, 0);
    assert.ok(existsSync(join(dir, "docs", "zet-x.md")));
  });

  it("x cli publish ai writes to exact file when path ends with .md", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, setAiPublishPath } from 'zet-x';
setAiPublishPath('.ai/skills/zet-x/SKILL.md');
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ai"]);
    assert.equal(result.code, 0);
    const content = readFileSync(join(dir, ".ai", "skills", "zet-x", "SKILL.md"), "utf8");
    assert.match(content, /AI agent reference/);
  });

  it("x cli publish ai writes to exact file when path ends with .mdc", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, setAiPublishPath } from 'zet-x';
setAiPublishPath('.cursor/rules/x.mdc');
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ai"]);
    assert.equal(result.code, 0);
    assert.ok(existsSync(join(dir, ".cursor", "rules", "x.mdc")));
  });

  it("x cli publish ai prepends skill frontmatter when asSkill is true", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, setAiPublishPath } from 'zet-x';
setAiPublishPath('.cursor/skills/zet-x/SKILL.md', true);
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ai"]);
    assert.equal(result.code, 0);
    const content = readFileSync(join(dir, ".cursor", "skills", "zet-x", "SKILL.md"), "utf8");
    assert.ok(content.startsWith("---\n"), "should start with frontmatter delimiter");
    assert.match(content, /name: zet-x/);
    assert.match(content, /description: /);
    assert.match(content, /AI agent reference/);
  });

  it("x cli publish ai omits skill frontmatter when asSkill is false", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, setAiPublishPath } from 'zet-x';
setAiPublishPath('docs/zet-x.md', false);
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ai"]);
    assert.equal(result.code, 0);
    const content = readFileSync(join(dir, "docs", "zet-x.md"), "utf8");
    assert.ok(!content.startsWith("---\n"), "should not start with frontmatter");
    assert.match(content, /AI agent reference/);
  });

  it("x cli publish ide creates .d.ts in .x/ (default)", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ide"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Created TypeScript declarations/);
    const dts = readFileSync(join(dir, ".x", "index.d.ts"), "utf8");
    assert.match(dts, /declare module "zet-x"/);
  });

  it("x cli publish ide creates .d.ts in configured path", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, setIdePublishPath } from 'zet-x';
setIdePublishPath('.types/');
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ide"]);
    assert.equal(result.code, 0);
    const dts = readFileSync(join(dir, ".types", "index.d.ts"), "utf8");
    assert.match(dts, /declare module "zet-x"/);
  });

  it("x cli publish ide does not delete other files in .x/", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    // Create .x/ with a user file
    mkdirSync(join(dir, ".x"), { recursive: true });
    writeFileSync(join(dir, ".x", "my-notes.txt"), "user data");
    const result = await run(dir, ["cli", "publish", "ide"]);
    assert.equal(result.code, 0);
    assert.ok(existsSync(join(dir, ".x", "index.d.ts")));
    assert.equal(readFileSync(join(dir, ".x", "my-notes.txt"), "utf8"), "user data");
  });

  it("x cli publish ide with custom path does not delete default .x/", async () => {
    const dir = tmpDir();
    // First publish to default .x/
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    await run(dir, ["cli", "publish", "ide"]);
    assert.ok(existsSync(join(dir, ".x", "index.d.ts")));
    // Now publish to custom path
    writeConfig(
      dir,
      `
import { register, setIdePublishPath } from 'zet-x';
setIdePublishPath('.types/');
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "ide"]);
    assert.equal(result.code, 0);
    assert.ok(existsSync(join(dir, ".types", "index.d.ts")));
    assert.ok(existsSync(join(dir, ".x", "index.d.ts")), "old .x/index.d.ts should still exist");
  });

  it("x --help does NOT show cli commands or init", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').description('Say hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["--help"]);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /\bpublish\b/);
    assert.doesNotMatch(result.stdout, /\binit\b/);
  });

  it("x cli publish unknown-command errors", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "publish", "nonexistent"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown publish command/);
  });
});

describe("x cli init-completion", () => {
  it("outputs bash completion script", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "init-completion", "bash"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /complete -F _x_completions x/);
  });

  it("outputs zsh completion script", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "init-completion", "zsh"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /compdef _x x/);
  });

  it("errors on unsupported shell", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["cli", "init-completion", "fish"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Usage: x cli init-completion/);
  });
});

describe("x --completions", () => {
  it("outputs root commands and group prefixes", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, group } from 'zet-x';
register('hello').run('echo', 'hi');
register('build').run('echo', 'building');
const be = group('be', 'Backend');
be.register('migrate').run('echo', 'migrating');
`
    );
    const result = await run(dir, ["--completions"]);
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split("\n");
    assert.ok(lines.includes("hello"));
    assert.ok(lines.includes("build"));
    assert.ok(lines.includes("be"));
    assert.ok(lines.includes("cli"));
    assert.ok(!lines.includes("be:migrate"));
  });

  it("outputs group subcommands for second position", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, group } from 'zet-x';
register('hello').run('echo', 'hi');
const be = group('be', 'Backend');
be.register('migrate').run('echo', 'migrating');
be.register('seed').run('echo', 'seeding');
`
    );
    const result = await run(dir, ["--completions", "be"]);
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split("\n");
    assert.ok(lines.includes("migrate"));
    assert.ok(lines.includes("seed"));
    assert.ok(!lines.includes("hello"));
  });

  it("outputs cli subcommands for second position", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["--completions", "cli"]);
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split("\n");
    assert.ok(lines.includes("publish"));
    assert.ok(lines.includes("init-completion"));
    assert.ok(!lines.includes("hello"));
  });

  it("outputs cli publish subcommands for third position", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('hello').run('echo', 'hi');
`
    );
    const result = await run(dir, ["--completions", "cli", "publish"]);
    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split("\n");
    assert.ok(lines.includes("ai"));
    assert.ok(lines.includes("ide"));
  });
});

describe("userCwd", () => {
  it("direct .run command runs from project root by default", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('pwd', 'Print CWD').run\`pwd\`;
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["pwd"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), dir);
  });

  it(".userCwd() makes direct command run from user CWD", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('pwd', 'Print CWD')
  .userCwd()
  .run\`pwd\`;
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["pwd"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), sub);
  });

  it(".userCwd() makes callback run from user CWD", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('cwd', 'Print CWD')
  .userCwd()
  .callback(async ($) => {
    const result = await $.silent\`pwd\`;
    process.stdout.write(result.output.trim());
  });
`
    );
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const result = await run(sub, ["cwd"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, sub);
  });
});

describe("template enhancements", () => {
  it("zero-arg template used without () in tagged template", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, template } from 'zet-x';
const compose = template(() => ['docker', 'compose']);
register('up').run\`echo \${compose} up\`;
`
    );
    const result = await run(dir, ["up"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /docker compose up/);
  });

  it("template returning string gets split on whitespace", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, template } from 'zet-x';
const compose = template(() => 'docker compose');
register('up').run\`echo \${compose()} up\`;
`
    );
    const result = await run(dir, ["up"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /docker compose up/);
  });

  it("zero-arg template auto-executes in variadic .run()", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, template } from 'zet-x';
const compose = template(() => ['docker', 'compose']);
register('up').run('echo', compose, 'up');
`
    );
    const result = await run(dir, ["up"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /docker compose up/);
  });

  it("nested templates work in .run tagged template", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, template } from 'zet-x';
const base = template(() => ['docker', 'compose']);
const full = template((cmd) => [base(), 'exec', cmd]);
register('shell').run\`echo \${full('app')} bash\`;
`
    );
    const result = await run(dir, ["shell"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /docker compose exec app bash/);
  });
});

describe("mustRun", () => {
  it("$.mustRun throws on non-zero exit code", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('fail')
  .callback(async ($) => {
    await $.mustRun('false');
  });
`
    );
    const result = await run(dir, ["fail"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Command failed with exit code 1/);
  });

  it("$.mustSilent throws on non-zero exit code", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('fail')
  .callback(async ($) => {
    await $.mustSilent('false');
  });
`
    );
    const result = await run(dir, ["fail"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Command failed with exit code 1/);
  });

  it("$.mustRun succeeds on zero exit code", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('ok')
  .callback(async ($) => {
    await $.mustRun('true');
    process.stdout.write('done');
  });
`
    );
    const result = await run(dir, ["ok"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /done/);
  });
});

describe("ENOENT error visibility", () => {
  it("shows error when command not found in $.run with inherit", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('bad')
  .callback(async ($) => {
    await $.run('nonexistent-command-xyz');
  });
`
    );
    const result = await run(dir, ["bad"]);
    assert.match(result.stderr, /Command not found: nonexistent-command-xyz/);
  });
});

describe("no action defined", () => {
  it("errors when command has no .run or .callback", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register } from 'zet-x';
register('empty', 'Does nothing');
`
    );
    const result = await run(dir, ["empty"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no action defined/);
  });
});

describe("group help", () => {
  it("x db --help shows only group commands", async () => {
    const dir = tmpDir();
    writeConfig(
      dir,
      `
import { register, group } from 'zet-x';
register('hello').run('echo', 'hi');
const db = group('db', 'Database');
db.register('migrate', 'Run migrations').run('echo', 'migrating');
db.register('seed', 'Seed database').run('echo', 'seeding');
`
    );
    const result = await run(dir, ["db", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: x db/);
    assert.match(result.stdout, /migrate/);
    assert.match(result.stdout, /seed/);
    assert.doesNotMatch(result.stdout, /hello/);
  });
});
