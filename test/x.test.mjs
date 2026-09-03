import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const srcStat = statSync(join(fileURLToPath(import.meta.url), "../../src/index.ts"));
const distStat = statSync(join(fileURLToPath(import.meta.url), "../../dist/index.js"));
if (distStat.mtimeMs < srcStat.mtimeMs) {
  process.stderr.write("Warning: dist/ is older than src/. Run 'npm run build' first.\n");
  process.exit(1);
}

import {
  parseSignature,
  parseArgv,
  Command,
  CommandBuilder,
  Group,
  CommandOutput,
  TemplateResult,
  formatGlobalHelp,
  formatCommandHelp,
  formatGroupHelp,
  flattenParts,
  rootGroup,
  groups,
  _getCliConfigForTesting,
  register,
  group,
  template,
  setAiPublishPath,
  setIdePublishPath,
  autoPublishIde,
  buildRunParts,
  expandRestSymbol,
  REST_SYMBOL,
  ExecutionContext,
  _resetForTesting,
} from "../dist/index.js";

afterEach(() => _resetForTesting());

describe("parseSignature", () => {
  it("parses a simple command name", () => {
    const sig = parseSignature("up");
    assert.equal(sig.name, "up");
    assert.deepEqual(sig.args, []);
    assert.deepEqual(sig.options, []);
    assert.equal(sig.acceptsRest, false);
  });

  it("parses rest args", () => {
    const sig = parseSignature("migrate ...");
    assert.equal(sig.name, "migrate");
    assert.equal(sig.acceptsRest, true);
  });

  it("parses required argument", () => {
    const sig = parseSignature("build {target}");
    assert.equal(sig.args.length, 1);
    assert.equal(sig.args[0].name, "target");
    assert.equal(sig.args[0].required, true);
    assert.equal(sig.args[0].description, "");
  });

  it("parses optional argument", () => {
    const sig = parseSignature("build {target?}");
    assert.equal(sig.args[0].name, "target");
    assert.equal(sig.args[0].required, false);
  });

  it("parses required argument with description", () => {
    const sig = parseSignature("build {target the build target}");
    assert.equal(sig.args[0].name, "target");
    assert.equal(sig.args[0].required, true);
    assert.equal(sig.args[0].description, "the build target");
  });

  it("parses optional argument with description", () => {
    const sig = parseSignature("build {target? the build target}");
    assert.equal(sig.args[0].name, "target");
    assert.equal(sig.args[0].required, false);
    assert.equal(sig.args[0].description, "the build target");
  });

  it("parses boolean option", () => {
    const sig = parseSignature("build {--verbose}");
    assert.equal(sig.options.length, 1);
    assert.equal(sig.options[0].long, "--verbose");
    assert.equal(sig.options[0].acceptsValue, false);
    assert.equal(sig.options[0].short, null);
  });

  it("parses value option (with =)", () => {
    const sig = parseSignature("build {--output=}");
    assert.equal(sig.options[0].long, "--output");
    assert.equal(sig.options[0].acceptsValue, true);
  });

  it("parses boolean option with description", () => {
    const sig = parseSignature("build {--verbose enable verbose output}");
    assert.equal(sig.options[0].long, "--verbose");
    assert.equal(sig.options[0].acceptsValue, false);
    assert.equal(sig.options[0].description, "enable verbose output");
  });

  it("parses value option with description", () => {
    const sig = parseSignature("build {--output= the output path}");
    assert.equal(sig.options[0].long, "--output");
    assert.equal(sig.options[0].acceptsValue, true);
    assert.equal(sig.options[0].description, "the output path");
  });

  it("extracts short flag from uppercase starting letters", () => {
    const sig = parseSignature("build {--Preserve-Cache}");
    assert.equal(sig.options[0].long, "--preserve-cache");
    assert.equal(sig.options[0].short, "-PC");
  });

  it("no short flag when all lowercase", () => {
    const sig = parseSignature("build {--verbose}");
    assert.equal(sig.options[0].short, null);
  });

  it("extracts single uppercase letter as short flag", () => {
    const sig = parseSignature("build {--Verbose}");
    assert.equal(sig.options[0].long, "--verbose");
    assert.equal(sig.options[0].short, "-V");
  });

  it("rejects uppercase in middle of segment", () => {
    assert.throws(
      () => parseSignature("build {--preservE-cache}"),
      /uppercase letters are only allowed at the start/
    );
  });

  it("rejects multi-word command name", () => {
    assert.throws(
      () => parseSignature("build deploy {target}"),
      /Unexpected token/
    );
  });

  it("rejects required argument after optional", () => {
    assert.throws(
      () => parseSignature("build {a?} {b}"),
      /Required argument 'b' cannot follow an optional argument/
    );
  });

  it("rejects duplicate argument names", () => {
    assert.throws(
      () => parseSignature("build {name} {name}"),
      /Duplicate argument name/
    );
  });

  it("parses complex signature with all features", () => {
    const sig = parseSignature(
      "test {arg1 required argument} {arg2? optional argument} {--option} {--Preserve-Cache= option desc} ..."
    );
    assert.equal(sig.name, "test");
    assert.equal(sig.args.length, 2);
    assert.equal(sig.args[0].name, "arg1");
    assert.equal(sig.args[0].required, true);
    assert.equal(sig.args[0].description, "required argument");
    assert.equal(sig.args[1].name, "arg2");
    assert.equal(sig.args[1].required, false);
    assert.equal(sig.args[1].description, "optional argument");
    assert.equal(sig.options.length, 2);
    assert.equal(sig.options[0].long, "--option");
    assert.equal(sig.options[0].acceptsValue, false);
    assert.equal(sig.options[1].long, "--preserve-cache");
    assert.equal(sig.options[1].acceptsValue, true);
    assert.equal(sig.options[1].short, "-PC");
    assert.equal(sig.options[1].description, "option desc");
    assert.equal(sig.acceptsRest, true);
  });
});

describe("parseArgv", () => {
  function makeCmd(signature) {
    const parsed = parseSignature(signature);
    const cmd = new Command(parsed.name, null, parsed);
    return cmd;
  }

  it("parses positional arguments", () => {
    const cmd = makeCmd("build {target} {mode?}");
    const result = parseArgv(["production", "fast"], cmd);
    assert.deepEqual(result.args, { target: "production", mode: "fast" });
  });

  it("handles missing optional arguments", () => {
    const cmd = makeCmd("build {target} {mode?}");
    const result = parseArgv(["production"], cmd);
    assert.deepEqual(result.args, { target: "production" });
    assert.equal(result.rest.length, 0);
  });

  it("errors on missing required argument", () => {
    const cmd = makeCmd("build {target}");
    const result = parseArgv([], cmd);
    assert.ok(result.error);
    assert.match(result.error, /missing required argument 'target'/);
  });

  it("parses long boolean option", () => {
    const cmd = makeCmd("build {--verbose}");
    const result = parseArgv(["--verbose"], cmd);
    assert.equal(result.options["--verbose"], true);
  });

  it("parses long value option with =", () => {
    const cmd = makeCmd("build {--output=}");
    const result = parseArgv(["--output=dist"], cmd);
    assert.equal(result.options["--output"], "dist");
  });

  it("parses long value option with space", () => {
    const cmd = makeCmd("build {--output=}");
    const result = parseArgv(["--output", "dist"], cmd);
    assert.equal(result.options["--output"], "dist");
  });

  it("parses short flag", () => {
    const cmd = makeCmd("build {--Verbose}");
    const result = parseArgv(["-V"], cmd);
    assert.equal(result.options["--verbose"], true);
  });

  it("parses short value flag", () => {
    const cmd = makeCmd("build {--Output=}");
    const result = parseArgv(["-O", "dist"], cmd);
    assert.equal(result.options["--output"], "dist");
  });

  it("collects rest args", () => {
    const cmd = makeCmd("run ...");
    const result = parseArgv(["a", "b", "c"], cmd);
    assert.deepEqual(result.rest, ["a", "b", "c"]);
  });

  it("errors on unexpected positional without rest", () => {
    const cmd = makeCmd("up");
    const result = parseArgv(["extra"], cmd);
    assert.ok(result.error);
    assert.match(result.error, /unexpected argument 'extra'/);
  });

  it("-- stops option parsing", () => {
    const cmd = makeCmd("run ...");
    const result = parseArgv(["--", "--not-an-option"], cmd);
    assert.deepEqual(result.rest, ["--not-an-option"]);
  });

  it("returns help flag", () => {
    const cmd = makeCmd("build");
    const result = parseArgv(["--help"], cmd);
    assert.equal(result.help, true);
  });

  it("returns help flag for -h", () => {
    const cmd = makeCmd("build");
    const result = parseArgv(["-h"], cmd);
    assert.equal(result.help, true);
  });

  it("errors on unknown option", () => {
    const cmd = makeCmd("build {--verbose}");
    const result = parseArgv(["--unknown"], cmd);
    assert.ok(result.error);
    assert.match(result.error, /unknown option/);
  });

  it("normalizes long option to lowercase", () => {
    const cmd = makeCmd("build {--Verbose}");
    const result = parseArgv(["--verbose"], cmd);
    assert.equal(result.options["--verbose"], true);
  });
});

describe("Group", () => {
  it("creates a group and registers commands", () => {
    const g = new Group("be", "Back-End services");
    assert.equal(g.prefix, "be");
    assert.equal(g.description, "Back-End services");
    const builder = g.register("temp");
    assert.ok(builder instanceof CommandBuilder);
    assert.ok(g.commands.has("temp"));
  });

  it("rejects duplicate command registration", () => {
    const g = new Group("test", "Test");
    g.register("cmd");
    assert.throws(() => g.register("cmd"), /Duplicate command/);
  });

  it("supports fluent chaining with .run", () => {
    const g = new Group("test", "Test");
    const builder = g.register("cmd");
    const result = builder
      .description("desc")
      .run("echo", "hello");
    assert.ok(result instanceof CommandBuilder);
  });

  it("register() rejects reserved 'init' name", () => {
    assert.throws(() => register("init"), /reserved/);
  });

  it("register() rejects reserved 'cli' name", () => {
    assert.throws(() => register("cli"), /reserved/);
  });

  it("group() rejects reserved 'init' prefix", () => {
    assert.throws(() => group("init", "Init"), /reserved/);
  });

  it("group() rejects reserved 'cli' prefix", () => {
    assert.throws(() => group("cli", "CLI"), /reserved/);
  });
});

describe("templates", () => {
  it("creates a template and returns TemplateResult", () => {
    const docker = template(
      (service) => ["docker", "compose", "exec", "-it", service]
    );
    const result = docker("app");
    assert.ok(result instanceof TemplateResult);
    assert.deepEqual(result.parts, ["docker", "compose", "exec", "-it", "app"]);
  });

  it("template with no args works", () => {
    const compose = template(() => ["docker", "compose"]);
    const result = compose();
    assert.deepEqual(result.parts, ["docker", "compose"]);
  });

  it("throws when too few args provided", () => {
    const tmpl = template((a, b) => ["cmd", a, b]);
    assert.throws(() => tmpl("one"), /Template expects 2 arguments, got 1/);
  });

  it("returns string split on whitespace", () => {
    const tmpl = template(() => "docker compose up -d");
    const result = tmpl();
    assert.deepEqual(result.parts, ["docker", "compose", "up", "-d"]);
  });

  it("throws when function returns non-string non-array", () => {
    const tmpl = template(() => 42);
    assert.throws(() => tmpl(), /must return a string or an array/);
  });
});

describe("CommandOutput", () => {
  it("succeeded when code is 0", () => {
    const out = new CommandOutput(0, null, null, null);
    assert.equal(out.code, 0);
    assert.equal(out.succeeded, true);
    assert.equal(out.failed, false);
  });

  it("failed when code is non-zero", () => {
    const out = new CommandOutput(1, "both", "stdout", "stderr");
    assert.equal(out.code, 1);
    assert.equal(out.output, "both");
    assert.equal(out.stdout, "stdout");
    assert.equal(out.stderr, "stderr");
    assert.equal(out.succeeded, false);
    assert.equal(out.failed, true);
  });

  it("throw() throws on failure", () => {
    const out = new CommandOutput(1, null, null, null);
    assert.throws(() => out.throw(), /exit code 1/);
  });

  it("throw() returns this on success", () => {
    const out = new CommandOutput(0, null, null, null);
    assert.equal(out.throw(), out);
  });
});

describe("help formatting", () => {
  it("formatCommandHelp includes all sections", () => {
    const sig = parseSignature(
      "migrate {direction required} {steps? number of steps} {--Verbose} {--Seed= seed file} ..."
    );
    const cmd = new Command("migrate", null, sig);
    cmd.description = "Run database migrations";
    const help = formatCommandHelp(cmd);

    assert.match(help, /Usage: x migrate/);
    assert.match(help, /<direction>/);
    assert.match(help, /\[steps\]/);
    assert.match(help, /\[args\.\.\.\]/);
    assert.match(help, /Run database migrations/);
    assert.match(help, /Arguments:/);
    assert.match(help, /direction/);
    assert.match(help, /\(required\)/);
    assert.match(help, /steps/);
    assert.match(help, /number of steps/);
    assert.match(help, /Options:/);
    assert.match(help, /--verbose/);
    assert.match(help, /--seed <value>/);
    assert.match(help, /-V/);
    assert.match(help, /-S/);
    assert.match(help, /--help, -h/);
  });

  it("formatCommandHelp shows group prefix in usage", () => {
    const sig = parseSignature("temp");
    const grp = new Group("be", "Backend");
    const cmd = new Command("temp", grp, sig);
    cmd.description = "A temp command";
    const help = formatCommandHelp(cmd);

    assert.match(help, /Usage: x be temp/);
  });
});

describe("cliConfig setters", () => {
  it("setAiPublishPath stores the path", () => {
    setAiPublishPath("docs/");
    assert.equal(_getCliConfigForTesting().aiPublishPath, "docs/");
    assert.equal(_getCliConfigForTesting().aiPublishAsSkill, false);
  });

  it("setAiPublishPath stores asSkill flag", () => {
    setAiPublishPath("docs/skill.md", true);
    assert.equal(_getCliConfigForTesting().aiPublishPath, "docs/skill.md");
    assert.equal(_getCliConfigForTesting().aiPublishAsSkill, true);
  });

  it("setAiPublishPath defaults asSkill to false", () => {
    setAiPublishPath("docs/");
    assert.equal(_getCliConfigForTesting().aiPublishAsSkill, false);
    setAiPublishPath("docs/", false);
    assert.equal(_getCliConfigForTesting().aiPublishAsSkill, false);
  });

  it("setIdePublishPath stores the path", () => {
    setIdePublishPath(".types/");
    assert.equal(_getCliConfigForTesting().idePublishPath, ".types/");
  });

  it("autoPublishIde sets the flag", () => {
    assert.equal(_getCliConfigForTesting().autoPublishIde, false);
    autoPublishIde();
    assert.equal(_getCliConfigForTesting().autoPublishIde, true);
  });

  it("_getCliConfigForTesting returns a clone", () => {
    setAiPublishPath("docs/");
    const config = _getCliConfigForTesting();
    config.aiPublishPath = "mutated";
    assert.equal(_getCliConfigForTesting().aiPublishPath, "docs/");
  });
});

describe("uncalled template detection", () => {
  it("throws when an uncalled template with args is passed to flattenParts", () => {
    const docker = template((service) => ["docker", "exec", service]);
    assert.throws(
      () => flattenParts([docker]),
      /template was used without being called/
    );
  });

  it("auto-executes zero-arg template in flattenParts", () => {
    const compose = template(() => ["docker", "compose"]);
    const result = flattenParts([compose]);
    assert.deepEqual(result, ["docker", "compose"]);
  });

  it("auto-executes zero-arg template in buildRunParts", () => {
    const compose = template(() => ["docker", "compose"]);
    const strings = Object.assign(["", " up"], { raw: ["", " up"] });
    const parts = buildRunParts(strings, [compose]);
    assert.deepEqual(parts, ["docker", "compose", "up"]);
  });

  it("throws when template with args is used without calling in buildRunParts", () => {
    const docker = template((service) => ["docker", "exec", service]);
    const strings = Object.assign(["", " bash"], { raw: ["", " bash"] });
    assert.throws(
      () => buildRunParts(strings, [docker]),
      /template was used without being called/
    );
  });

  it("does not throw when a called template is passed", () => {
    const docker = template((service) => ["docker", "exec", service]);
    const result = flattenParts([docker("app")]);
    assert.deepEqual(result, ["docker", "exec", "app"]);
  });
});

describe("buildRunParts", () => {
  it("splits static strings on whitespace", () => {
    const strings = Object.assign(["echo hello  world"], { raw: ["echo hello  world"] });
    const parts = buildRunParts(strings, []);
    assert.deepEqual(parts, ["echo", "hello", "world"]);
  });

  it("keeps interpolated values as single tokens", () => {
    const path = "my file.txt";
    const strings = Object.assign(["echo ", ""], { raw: ["echo ", ""] });
    const parts = buildRunParts(strings, [path]);
    assert.deepEqual(parts, ["echo", "my file.txt"]);
  });

  it("recognizes ... as REST_SYMBOL", () => {
    const strings = Object.assign(["echo ..."], { raw: ["echo ..."] });
    const parts = buildRunParts(strings, []);
    assert.equal(parts.length, 2);
    assert.equal(parts[0], "echo");
    assert.equal(parts[1], REST_SYMBOL);
  });

  it("spreads TemplateResult parts", () => {
    const tr = new TemplateResult(["docker", "compose", "exec"]);
    const strings = Object.assign(["", " app"], { raw: ["", " app"] });
    const parts = buildRunParts(strings, [tr]);
    assert.deepEqual(parts, ["docker", "compose", "exec", "app"]);
  });

  it("spreads array interpolations", () => {
    const flags = ["--verbose", "--dry-run"];
    const strings = Object.assign(["echo ", ""], { raw: ["echo ", ""] });
    const parts = buildRunParts(strings, [flags]);
    assert.deepEqual(parts, ["echo", "--verbose", "--dry-run"]);
  });
});

describe("expandRestSymbol", () => {
  it("replaces REST_SYMBOL with rest args", () => {
    const parts = ["echo", REST_SYMBOL, "end"];
    const expanded = expandRestSymbol(parts, ["a", "b"]);
    assert.deepEqual(expanded, ["echo", "a", "b", "end"]);
  });

  it("passes through when no REST_SYMBOL", () => {
    const parts = ["echo", "hello"];
    const expanded = expandRestSymbol(parts, ["ignored"]);
    assert.deepEqual(expanded, ["echo", "hello"]);
  });
});

describe("CommandBuilder.run", () => {
  it("sets command type and parts from tagged template", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    builder.run`echo hello world`;
    assert.equal(cmd.type, "command");
    assert.deepEqual(cmd.parts, ["echo", "hello", "world"]);
  });

  it("handles interpolation in .run", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    const target = "dist";
    builder.run`echo ${target}`;
    assert.equal(cmd.type, "command");
    assert.deepEqual(cmd.parts, ["echo", "dist"]);
  });

  it("handles ... rest in .run", () => {
    const sig = parseSignature("test ...");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    builder.run`echo ...`;
    assert.equal(cmd.parts.length, 2);
    assert.equal(cmd.parts[0], "echo");
    assert.equal(cmd.parts[1], REST_SYMBOL);
  });

  it("chains .description and .run", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    const result = builder.description("A test").run`echo hi`;
    assert.ok(result instanceof CommandBuilder);
    assert.equal(cmd.description, "A test");
    assert.equal(cmd.type, "command");
  });
});

describe("register with description", () => {
  it("accepts description as second argument", () => {
    const g = new Group("desc-test", "Desc Test");
    g.register("mycmd", "My description");
    const cmd = g.commands.get("mycmd");
    assert.equal(cmd.description, "My description");
  });
});

describe("CommandBuilder.run variadic", () => {
  it("accepts string args", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    builder.run("echo", "hello", "world");
    assert.equal(cmd.type, "command");
    assert.deepEqual(cmd.parts, ["echo", "hello", "world"]);
  });

  it("accepts array arg", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    builder.run(["echo", "hello"]);
    assert.equal(cmd.type, "command");
    assert.deepEqual(cmd.parts, ["echo", "hello"]);
  });

  it("accepts TemplateResult in variadic mode", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    const docker = template((svc) => ["docker", "exec", svc]);
    builder.run("echo", docker("app"));
    assert.deepEqual(cmd.parts, ["echo", "docker", "exec", "app"]);
  });
});

describe("CommandBuilder.userCwd", () => {
  it("stores userCwd flag on command", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    builder.userCwd().run`echo hi`;
    assert.equal(cmd.userCwd, true);
  });

  it("defaults to false", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    assert.equal(cmd.userCwd, false);
  });
});

describe("template nesting", () => {
  it("nested TemplateResult in template array", () => {
    const base = template(() => ["docker", "compose"]);
    const full = template((cmd) => [base(), "exec", cmd]);
    const result = full("app");
    assert.deepEqual(result.parts, ["docker", "compose", "exec", "app"]);
  });

  it("nested zero-arg template auto-executes", () => {
    const base = template(() => ["docker", "compose"]);
    const full = template(() => [base, "up"]);
    const result = full();
    assert.deepEqual(result.parts, ["docker", "compose", "up"]);
  });

  it("nested template with required args throws if not called", () => {
    const base = template((svc) => ["docker", "exec", svc]);
    const full = template(() => [base, "bash"]);
    assert.throws(() => full(), /Template with required arguments must be called/);
  });

  it("TemplateResult in string interpolation inside template", () => {
    const compose = template((svc) => ["docker", "compose", "exec", "-it", svc]);
    const exec = template((command) => `${compose("goodsales-app")} ${command}`);
    const result = exec("bash");
    assert.deepEqual(result.parts, ["docker", "compose", "exec", "-it", "goodsales-app", "bash"]);
  });
});

describe("DTS generation", () => {
  it("DTS_CONTENT contains expected public API", async () => {
    const { DTS_CONTENT } = await import("../dist/dts-content.js");
    assert.ok(DTS_CONTENT.includes('declare module "zet-x"'));
    assert.ok(DTS_CONTENT.includes("CommandOutput"));
    assert.ok(DTS_CONTENT.includes("ExecutionContext"));
    assert.ok(DTS_CONTENT.includes("CommandBuilder"));
    assert.ok(DTS_CONTENT.includes("PathHelper"));
    assert.ok(DTS_CONTENT.includes("TemplateResult"));
    assert.ok(DTS_CONTENT.includes("Group"));
    assert.ok(DTS_CONTENT.includes("register"));
    assert.ok(DTS_CONTENT.includes("group"));
    assert.ok(DTS_CONTENT.includes("template"));
    assert.ok(DTS_CONTENT.includes("mustRun"));
    assert.ok(DTS_CONTENT.includes("mustSilent"));
    assert.ok(DTS_CONTENT.includes("arg"));
    assert.ok(DTS_CONTENT.includes("option"));
    assert.ok(DTS_CONTENT.includes("run"));
    assert.ok(DTS_CONTENT.includes("silent"));
    assert.ok(DTS_CONTENT.includes("info"));
    assert.ok(DTS_CONTENT.includes("warn"));
    assert.ok(DTS_CONTENT.includes("error"));
    assert.ok(DTS_CONTENT.includes("confirm"));
    assert.ok(DTS_CONTENT.includes("prompt"));
    assert.ok(DTS_CONTENT.includes("setAiPublishPath"));
    assert.ok(DTS_CONTENT.includes("setIdePublishPath"));
    assert.ok(DTS_CONTENT.includes("autoPublishIde"));
  });
});

describe("formatGroupHelp", () => {
  it("shows only the group's commands", () => {
    const g = new Group("db", "Database");
    const sig1 = parseSignature("migrate");
    const cmd1 = new Command("migrate", g, sig1);
    cmd1.description = "Run migrations";
    g.commands.set("migrate", cmd1);

    const sig2 = parseSignature("seed");
    const cmd2 = new Command("seed", g, sig2);
    cmd2.description = "Seed database";
    g.commands.set("seed", cmd2);

    const help = formatGroupHelp(g);
    assert.match(help, /Usage: x db/);
    assert.match(help, /Database/);
    assert.match(help, /migrate/);
    assert.match(help, /seed/);
    assert.match(help, /Run migrations/);
  });
});

describe("_resetForTesting", () => {
  it("clears all registered commands and groups", () => {
    const g = new Group("test-reset", "Test");
    groups.set("test-reset", g);
    rootGroup.commands.set("temp-cmd", new Command("temp-cmd", null, parseSignature("temp-cmd")));
    _resetForTesting();
    assert.equal(rootGroup.commands.size, 0);
    assert.equal(groups.size, 0);
    assert.equal(_getCliConfigForTesting().aiPublishPath, null);
    assert.equal(_getCliConfigForTesting().aiPublishAsSkill, false);
    assert.equal(_getCliConfigForTesting().autoPublishIde, false);
  });
});

describe("duplicate short flags", () => {
  it("rejects duplicate short flags in signature", () => {
    assert.throws(
      () => parseSignature("build {--Verbose} {--Valid}"),
      /Duplicate short flag '-V'/
    );
  });
});

describe("CommandBuilder overwrite guard", () => {
  it("throws when .callback is called after .run", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    builder.run`echo hi`;
    assert.throws(
      () => builder.callback(() => {}),
      /already has a command action defined/
    );
  });

  it("throws when .run is called after .callback", () => {
    const sig = parseSignature("test");
    const cmd = new Command("test", null, sig);
    const builder = new CommandBuilder(cmd);
    builder.callback(() => {});
    assert.throws(
      () => builder.run`echo hi`,
      /already has a callback action defined/
    );
  });
});
