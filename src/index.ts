import { spawn as nodeSpawn } from "node:child_process";
import { join } from "node:path";
import {
  ExecutionContext,
  buildRunParts,
  expandRestSymbol,
  REST_SYMBOL,
  spawnCommand,
} from "./context.js";
import { regenerateTypes } from "./types-generator.js";
import { outAnsi, errAnsi, isTaggedTemplate } from "./util.js";
import { CommandOutput, TemplateResult, flattenParts } from "./shared.js";
import type { TemplateFn } from "./shared.js";

export { CommandOutput, TemplateResult, flattenParts } from "./shared.js";
export type { TemplateFn } from "./shared.js";
export { ExecutionContext, buildRunParts, expandRestSymbol, REST_SYMBOL, spawnCommand } from "./context.js";
export type { PathHelper } from "./context.js";

const PKG_ROOT_URL = new URL("../", import.meta.url).href;

export function formatUncaughtError(err: Error): string {
  const red = errAnsi("31");
  const dim = errAnsi("2");
  const reset = errAnsi("0");

  let output = `\n${red}x: ${err.message}${reset}\n`;

  if (err.stack) {
    const stackLines = err.stack.split("\n").slice(1);
    const userLines = stackLines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("at ")) return false;
      if (trimmed.includes(PKG_ROOT_URL)) return false;
      if (trimmed.includes("node:")) return false;
      return true;
    });

    if (userLines.length > 0) {
      output += "\n";
      for (const line of userLines) {
        output += `${dim}${line}${reset}\n`;
      }
    }
  }

  return output;
}



export interface ArgumentDef {
  name: string;
  required: boolean;
  description: string;
}

export interface OptionDef {
  long: string;
  short: string | null;
  acceptsValue: boolean;
  description: string;
}

export interface ParsedSignature {
  name: string;
  args: ArgumentDef[];
  options: OptionDef[];
  acceptsRest: boolean;
}

const TOKEN_RE = /\{[^}]+\}|\.\.\.|[^\s{}]+/g;

function validateOptionName(raw: string): void {
  const name = raw.replace(/^--/, "");
  const segments = name.split("-");
  for (const seg of segments) {
    if (seg.length === 0) continue;
    for (let i = 1; i < seg.length; i++) {
      if (seg[i] >= "A" && seg[i] <= "Z") {
        throw new Error(
          `Invalid option name '--${name}': uppercase letters are only allowed at the start of hyphen-separated segments`
        );
      }
    }
  }
}

function extractShortFlag(name: string): string | null {
  const segments = name.split("-");
  let short = "";
  for (const seg of segments) {
    if (seg.length > 0 && seg[0] >= "A" && seg[0] <= "Z") {
      short += seg[0];
    }
  }
  return short.length > 0 ? `-${short}` : null;
}

export function parseSignature(signature: string): ParsedSignature {
  const tokens = signature.match(TOKEN_RE);
  if (!tokens || tokens.length === 0) {
    throw new Error("Empty signature");
  }

  const name = tokens[0];
  const args: ArgumentDef[] = [];
  const options: OptionDef[] = [];
  let acceptsRest = false;

  let seenOptional = false;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok === "...") {
      acceptsRest = true;
      continue;
    }

    if (tok.startsWith("{") && tok.endsWith("}")) {
      const inner = tok.slice(1, -1).trim();

      if (inner.startsWith("--")) {
        const m = inner.match(/^--([a-zA-Z][\w-]*)([=])?\s*([\s\S]*)?$/);
        if (!m) throw new Error(`Invalid option syntax: ${tok}`);
        const rawName = m[1];
        const hasEquals = !!m[2];
        const desc = (m[3] || "").trim();

        validateOptionName(rawName);

        const longName = rawName.toLowerCase();
        const shortFlag = extractShortFlag(rawName);

        options.push({
          long: `--${longName}`,
          short: shortFlag,
          acceptsValue: hasEquals,
          description: desc,
        });
      } else {
        const m = inner.match(/^([a-zA-Z]\w*)(\?)?\s*([\s\S]*)?$/);
        if (!m) throw new Error(`Invalid argument syntax: ${tok}`);
        const argName = m[1];
        const optional = !!m[2];
        const desc = (m[3] || "").trim();

        if (!optional && seenOptional) {
          throw new Error(
            `Required argument '${argName}' cannot follow an optional argument`
          );
        }
        if (optional) seenOptional = true;

        args.push({
          name: argName,
          required: !optional,
          description: desc,
        });
      }
    } else {
      throw new Error(
        `Unexpected token '${tok}' in signature -- command names must be a single word`
      );
    }
  }

  const allNames = new Set<string>();
  for (const a of args) {
    if (allNames.has(a.name)) {
      throw new Error(`Duplicate argument name '${a.name}'`);
    }
    allNames.add(a.name);
  }
  for (const o of options) {
    if (allNames.has(o.long)) {
      throw new Error(`Duplicate option name '${o.long}'`);
    }
    allNames.add(o.long);
  }

  const shortFlags = new Set<string>();
  for (const o of options) {
    if (o.short) {
      if (shortFlags.has(o.short)) throw new Error(`Duplicate short flag '${o.short}'`);
      shortFlags.add(o.short);
    }
  }

  return { name, args, options, acceptsRest };
}

export class Command {
  name: string;
  group: Group | null;
  signature: ParsedSignature;
  description: string;
  type: "command" | "callback" | null;
  parts: (string | symbol)[] | null;
  userCwd: boolean;
  callback: (($: ExecutionContext) => void | Promise<void>) | null;

  constructor(name: string, group: Group | null, signature: ParsedSignature) {
    this.name = name;
    this.group = group;
    this.signature = signature;
    this.description = "";
    this.type = null;
    this.parts = null;
    this.userCwd = false;
    this.callback = null;
  }
}

export class CommandBuilder {
  #cmd: Command;

  constructor(cmd: Command) {
    this.#cmd = cmd;
  }

  description(text: string): this {
    this.#cmd.description = text;
    return this;
  }

  run(stringsOrParts: TemplateStringsArray | unknown, ...values: unknown[]): this {
    if (this.#cmd.type !== null) {
      throw new Error(`Command '${this.#cmd.name}' already has a ${this.#cmd.type} action defined`);
    }
    this.#cmd.type = "command";
    if (isTaggedTemplate(stringsOrParts)) {
      this.#cmd.parts = buildRunParts(stringsOrParts, values);
    } else {
      this.#cmd.parts = flattenParts([stringsOrParts, ...values]);
    }
    return this;
  }

  userCwd(): this {
    this.#cmd.userCwd = true;
    return this;
  }

  callback(fn: ($: ExecutionContext) => void | Promise<void>): this {
    if (this.#cmd.type !== null) {
      throw new Error(`Command '${this.#cmd.name}' already has a ${this.#cmd.type} action defined`);
    }
    this.#cmd.type = "callback";
    this.#cmd.callback = fn;
    return this;
  }
}

export class Group {
  prefix: string;
  description: string;
  commands: Map<string, Command>;

  constructor(prefix: string, description: string) {
    this.prefix = prefix;
    this.description = description;
    this.commands = new Map();
  }

  register(signature: string, description?: string): CommandBuilder {
    const parsed = parseSignature(signature);

    if (this.commands.has(parsed.name)) {
      throw new Error(
        `Duplicate command '${parsed.name}' in group '${this.prefix || "root"}'`
      );
    }

    const cmd = new Command(parsed.name, this, parsed);
    if (description) cmd.description = description;
    this.commands.set(parsed.name, cmd);
    return new CommandBuilder(cmd);
  }
}

const cliConfig: { aiPublishPath: string | null; aiPublishAsSkill: boolean; idePublishPath: string | null; autoPublishIde: boolean } = {
  aiPublishPath: null,
  aiPublishAsSkill: false,
  idePublishPath: null,
  autoPublishIde: false,
};

export function _getCliConfigForTesting(): { aiPublishPath: string | null; aiPublishAsSkill: boolean; idePublishPath: string | null; autoPublishIde: boolean } {
  return { ...cliConfig };
}

const RESERVED_NAMES = new Set(["init", "cli"]);

export const rootGroup = new Group("", "Commands");
export const groups = new Map<string, Group>();

export function _resetForTesting(): void {
  rootGroup.commands.clear();
  groups.clear();
  cliConfig.aiPublishPath = null;
  cliConfig.aiPublishAsSkill = false;
  cliConfig.idePublishPath = null;
  cliConfig.autoPublishIde = false;
}

export function register(signature: string, description?: string): CommandBuilder {
  const name = signature.match(/^\S+/)?.[0];
  if (name && RESERVED_NAMES.has(name)) {
    throw new Error(`Cannot register command '${name}': '${name}' is a reserved built-in command`);
  }
  if (name && groups.has(name)) {
    throw new Error(`Cannot register command '${name}': a group with the same name already exists`);
  }
  const builder = rootGroup.register(signature);
  if (description) builder.description(description);
  return builder;
}

export function group(prefix: string, description: string): Group {
  if (RESERVED_NAMES.has(prefix)) {
    throw new Error(`The group prefix '${prefix}' is reserved`);
  }
  if (groups.has(prefix)) {
    throw new Error(`Group '${prefix}' already exists`);
  }
  if (rootGroup.commands.has(prefix)) {
    throw new Error(`Cannot create group '${prefix}': a command with the same name already exists`);
  }
  const g = new Group(prefix, description);
  groups.set(prefix, g);
  return g;
}

export function template(fn: (...args: (string | TemplateResult)[]) => string | unknown[]): TemplateFn {
  const wrapper = function (...args: (string | TemplateResult)[]): TemplateResult {
    if (fn.length > 0 && args.length < fn.length) {
      throw new Error(
        `Template expects ${fn.length} arguments, got ${args.length}`
      );
    }
    const result = fn(...args);
    if (typeof result === "string") {
      return new TemplateResult(result.split(/\s+/).filter(Boolean));
    }
    if (!Array.isArray(result)) {
      throw new Error("Template function must return a string or an array");
    }
    const flattened: string[] = [];
    for (const item of result) {
      if (item instanceof TemplateResult) {
        flattened.push(...item.parts);
      } else if (typeof item === "function" && (item as TemplateFn)._isZetTemplate) {
        if ((item as TemplateFn)._expectedArgs === 0) {
          flattened.push(...(item as TemplateFn)().parts);
        } else {
          throw new Error("Template with required arguments must be called");
        }
      } else {
        flattened.push(String(item));
      }
    }
    return new TemplateResult(flattened);
  } as TemplateFn;
  wrapper._isZetTemplate = true;
  wrapper._expectedArgs = fn.length;
  return wrapper;
}

export function setAiPublishPath(path: string | null, asSkill?: boolean): void {
  cliConfig.aiPublishPath = path;
  cliConfig.aiPublishAsSkill = !!asSkill;
}

export function setIdePublishPath(path: string | null): void {
  cliConfig.idePublishPath = path;
}

export function autoPublishIde(): void {
  cliConfig.autoPublishIde = true;
}

export function formatGlobalHelp(): string {
  const yellow = outAnsi("33");
  const green = outAnsi("32");
  const dim = outAnsi("2");
  const reset = outAnsi("0");

  const lines: string[] = [];
  lines.push(`${yellow}Usage:${reset} x ${dim}<command> [options]${reset}`);
  lines.push("");

  const sections: { title: string; entries: { label: string; description: string }[] }[] = [];

  for (const [, g] of groups) {
    if (g.commands.size > 0) {
      const entries: { label: string; description: string }[] = [];
      for (const [, cmd] of g.commands) {
        const label = `${g.prefix} ${cmd.name}`;
        entries.push({ label, description: cmd.description });
      }
      sections.push({ title: g.description || g.prefix, entries });
    }
  }

  if (rootGroup.commands.size > 0) {
    const entries: { label: string; description: string }[] = [];
    for (const [, cmd] of rootGroup.commands) {
      let label = cmd.name;
      if (cmd.signature.acceptsRest) label += " ...";
      entries.push({ label, description: cmd.description });
    }
    sections.push({ title: "Commands", entries });
  }

  let maxWidth = 0;
  for (const section of sections) {
    for (const e of section.entries) {
      if (e.label.length > maxWidth) maxWidth = e.label.length;
    }
  }

  for (const section of sections) {
    lines.push(`${yellow}${section.title}:${reset}`);
    for (const e of section.entries) {
      const padding = " ".repeat(maxWidth - e.label.length + 4);
      lines.push(`  ${green}${e.label}${reset}${padding}${e.description}`);
    }
    lines.push("");
  }

  lines.push(`${dim}Run "x <command> --help" for more information.${reset}`);
  lines.push(`${dim}Run "x cli" for built-in utility commands.${reset}`);
  return lines.join("\n");
}

export function formatCommandHelp(cmd: Command): string {
  const yellow = outAnsi("33");
  const green = outAnsi("32");
  const dim = outAnsi("2");
  const reset = outAnsi("0");

  const sig = cmd.signature;
  const lines: string[] = [];

  let usage = `${yellow}Usage:${reset} x `;
  if (cmd.group && cmd.group.prefix) {
    usage += `${cmd.group.prefix} `;
  }
  usage += cmd.name;
  if (sig.args.length > 0) {
    const argParts = sig.args.map((a) =>
      a.required ? `${dim}<${a.name}>${reset}` : `${dim}[${a.name}]${reset}`
    );
    usage += ` ${argParts.join(" ")}`;
  }
  if (sig.acceptsRest) usage += ` ${dim}[args...]${reset}`;
  if (sig.options.length > 0) usage += ` ${dim}[options]${reset}`;
  lines.push(usage);

  if (cmd.description) {
    lines.push("");
    lines.push(`  ${cmd.description}`);
  }

  if (sig.args.length > 0) {
    lines.push("");
    lines.push(`${yellow}Arguments:${reset}`);
    let argMaxWidth = 0;
    for (const a of sig.args) {
      if (a.name.length > argMaxWidth) argMaxWidth = a.name.length;
    }
    for (const a of sig.args) {
      const suffix = a.required ? ` ${dim}(required)${reset}` : "";
      const desc = a.description || "";
      const padding = " ".repeat(argMaxWidth - a.name.length + 4);
      lines.push(`  ${green}${a.name}${reset}${padding}${desc}${suffix}`);
    }
  }

  lines.push("");
  lines.push(`${yellow}Options:${reset}`);
  const optEntries: { label: string; description: string }[] = [];
  for (const o of sig.options) {
    let label = o.long;
    if (o.acceptsValue) label += " <value>";
    if (o.short) label += `, ${o.short}`;
    optEntries.push({ label, description: o.description || "" });
  }
  optEntries.push({ label: "--help, -h", description: "Show help" });

  let maxOptWidth = 0;
  for (const e of optEntries) {
    if (e.label.length > maxOptWidth) maxOptWidth = e.label.length;
  }
  for (const e of optEntries) {
    const padding = " ".repeat(maxOptWidth - e.label.length + 4);
    lines.push(`  ${green}${e.label}${reset}${padding}${e.description}`);
  }

  return lines.join("\n");
}

export function formatGroupHelp(grp: Group): string {
  const yellow = outAnsi("33");
  const green = outAnsi("32");
  const dim = outAnsi("2");
  const reset = outAnsi("0");

  const lines: string[] = [];
  lines.push(`${yellow}Usage:${reset} x ${grp.prefix} ${dim}<command> [options]${reset}`);
  lines.push("");

  if (grp.description) {
    lines.push(`  ${grp.description}`);
    lines.push("");
  }

  if (grp.commands.size > 0) {
    lines.push(`${yellow}Commands:${reset}`);
    let maxWidth = 0;
    for (const [, cmd] of grp.commands) {
      if (cmd.name.length > maxWidth) maxWidth = cmd.name.length;
    }
    for (const [, cmd] of grp.commands) {
      const padding = " ".repeat(maxWidth - cmd.name.length + 4);
      lines.push(`  ${green}${cmd.name}${reset}${padding}${cmd.description}`);
    }
    lines.push("");
  }

  lines.push(`${dim}Run "x ${grp.prefix} <command> --help" for more information.${reset}`);
  return lines.join("\n");
}

interface ParsedArgv {
  args: Record<string, string>;
  options: Record<string, string | true>;
  rest: string[];
}

interface ParsedArgvHelp {
  help: true;
}

interface ParsedArgvError {
  error: string;
  cmd: Command;
}

export function parseArgv(argv: string[], cmd: Command): ParsedArgv | ParsedArgvHelp | ParsedArgvError {
  const sig = cmd.signature;
  const args: Record<string, string> = {};
  const opts: Record<string, string | true> = {};
  const rest: string[] = [];

  const longMap = new Map<string, OptionDef>();
  const shortMap = new Map<string, OptionDef>();
  for (const o of sig.options) {
    longMap.set(o.long, o);
    if (o.short) shortMap.set(o.short, o);
  }

  let positionalIndex = 0;
  let stopParsing = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!stopParsing && token === "--") {
      stopParsing = true;
      continue;
    }

    if (!stopParsing && (token === "--help" || token === "-h")) {
      return { help: true };
    }

    if (!stopParsing && token.startsWith("--")) {
      let name: string, value: string | undefined;
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        name = token.slice(0, eqIdx);
        value = token.slice(eqIdx + 1);
      } else {
        name = token;
        value = undefined;
      }

      const normalizedName = `--${name.slice(2).toLowerCase()}`;
      const optDef = longMap.get(normalizedName);
      if (!optDef) {
        if (sig.acceptsRest) {
          rest.push(token);
          continue;
        }
        return {
          error: `unknown option '${name}'`,
          cmd,
        };
      }

      if (optDef.acceptsValue) {
        if (value !== undefined) {
          opts[optDef.long] = value;
        } else if (i + 1 < argv.length) {
          const next = argv[i + 1];
          const isNextOption = next.startsWith("--")
            ? longMap.has(`--${next.slice(2).toLowerCase()}`)
            : shortMap.has(next);
          if (!isNextOption) {
            opts[optDef.long] = argv[++i];
          } else {
            return {
              error: `option '${optDef.long}' requires a value`,
              cmd,
            };
          }
        } else {
          return {
            error: `option '${optDef.long}' requires a value`,
            cmd,
          };
        }
      } else {
        if (value !== undefined) {
          return {
            error: `option '${optDef.long}' does not accept a value`,
            cmd,
          };
        }
        opts[optDef.long] = true;
      }
      continue;
    }

    if (!stopParsing && token.startsWith("-") && token.length > 1 && !token.startsWith("--")) {
      const optDef = shortMap.get(token);
      if (!optDef) {
        if (sig.acceptsRest) {
          rest.push(token);
          continue;
        }
        return {
          error: `unknown option '${token}'`,
          cmd,
        };
      }

      if (optDef.acceptsValue) {
        if (i + 1 < argv.length) {
          const next = argv[i + 1];
          const isNextOption = next.startsWith("--")
            ? longMap.has(`--${next.slice(2).toLowerCase()}`)
            : shortMap.has(next);
          if (!isNextOption) {
            opts[optDef.long] = argv[++i];
          } else {
            return {
              error: `option '${optDef.long}' requires a value`,
              cmd,
            };
          }
        } else {
          return {
            error: `option '${optDef.long}' requires a value`,
            cmd,
          };
        }
      } else {
        opts[optDef.long] = true;
      }
      continue;
    }

    if (positionalIndex < sig.args.length) {
      args[sig.args[positionalIndex].name] = token;
      positionalIndex++;
    } else if (sig.acceptsRest) {
      rest.push(token);
    } else {
      return {
        error: `unexpected argument '${token}' for command '${cmd.name}'`,
        cmd,
      };
    }
  }

  for (let j = 0; j < sig.args.length; j++) {
    if (sig.args[j].required && !(sig.args[j].name in args)) {
      return {
        error: `missing required argument '${sig.args[j].name}'`,
        cmd,
      };
    }
  }

  return { args, options: opts, rest };
}

function formatUsageLine(cmd: Command): string {
  const sig = cmd.signature;
  let usage = "Usage: x ";
  if (cmd.group && cmd.group.prefix) {
    usage += `${cmd.group.prefix} `;
  }
  usage += cmd.name;
  for (const a of sig.args) {
    usage += a.required ? ` <${a.name}>` : ` [${a.name}]`;
  }
  if (sig.acceptsRest) usage += " [args...]";
  if (sig.options.length > 0) usage += " [options]";
  return usage;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function suggestCommand(input: string): string | null {
  const allNames: string[] = [];
  for (const [, cmd] of rootGroup.commands) {
    allNames.push(cmd.name);
  }
  for (const [prefix, grp] of groups) {
    for (const [, cmd] of grp.commands) {
      allNames.push(`${prefix} ${cmd.name}`);
    }
  }

  let bestName: string | null = null;
  let bestDist = Infinity;
  for (const name of allNames) {
    const dist = levenshtein(input, name);
    if (dist < bestDist) {
      bestDist = dist;
      bestName = name;
    }
  }

  if (bestName && bestDist <= Math.max(1, Math.floor(bestName.length / 2))) {
    return bestName;
  }
  return null;
}

function showCliHelp(): void {
  const yellow = outAnsi("33");
  const green = outAnsi("32");
  const dim = outAnsi("2");
  const reset = outAnsi("0");

  const lines: string[] = [];
  lines.push(`${yellow}Usage:${reset} x cli ${dim}<command>${reset}`);
  lines.push("");
  lines.push(`${yellow}Commands:${reset}`);
  lines.push(`  ${green}publish ai${reset}               Generate zet-x.md (AI agent documentation)`);
  lines.push(`  ${green}publish ide${reset}              Generate TypeScript declarations for IDE support`);
  lines.push(`  ${green}init-completion <shell>${reset}  Output shell completion script (bash or zsh)`);
  process.stdout.write(lines.join("\n") + "\n");
}

export async function init(): Promise<void> {
  const argv = process.argv.slice(2);
  const rootDir = process.env.X_ROOT_DIR || process.cwd();
  const userDir = process.cwd();

  // Auto-regenerate types (opt-in via autoPublishIde())
  if (cliConfig.autoPublishIde) {
    await regenerateTypes(rootDir, cliConfig.idePublishPath);
  }

  // No args or --help → global help
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(formatGlobalHelp() + "\n");
    process.exit(0);
  }

  const firstArg = argv[0];

  // --completions: output command names one per line (for shell completion)
  if (firstArg === "--completions") {
    const completionArg = argv[1];
    const completionArg2 = argv[2];
    if (completionArg && completionArg2) {
      // Third-position: e.g. x cli publish <tab>
      if (completionArg === "cli" && completionArg2 === "publish") {
        process.stdout.write("ai\n");
        process.stdout.write("ide\n");
      }
    } else if (completionArg) {
      // Second-position: show subcommands for groups or cli
      if (completionArg === "cli") {
        process.stdout.write("publish\n");
        process.stdout.write("init-completion\n");
      } else if (groups.has(completionArg)) {
        const grp = groups.get(completionArg)!;
        for (const [, cmd] of grp.commands) {
          process.stdout.write(cmd.name + "\n");
        }
      }
      // Non-group command — no further completions
    } else {
      // First-position completion: show root commands + group prefixes + cli
      for (const [, cmd] of rootGroup.commands) {
        process.stdout.write(cmd.name + "\n");
      }
      for (const [prefix] of groups) {
        process.stdout.write(prefix + "\n");
      }
      process.stdout.write("cli\n");
    }
    process.exit(0);
  }

  // Built-in `cli` subcommands
  if (firstArg === "cli") {
    const sub = argv[1];
    if (!sub || sub === "--help" || sub === "-h") {
      showCliHelp();
      process.exit(0);
    }
    if (sub === "publish") {
      const { handleCli } = await import("./publish.js");
      await handleCli(argv.slice(2), rootDir, cliConfig);
      process.exit(0);
    }
    // init-completion is handled in bin/x.mjs before config search
    process.stderr.write(`x: unknown cli command '${sub}'\n`);
    process.exit(1);
  }

  // Command resolution
  let targetCmd: Command | null = null;
  let remainingArgv: string[] = [];

  if (groups.has(firstArg)) {
    const grp = groups.get(firstArg)!;
    if (argv.length < 2) {
      process.stderr.write(`${errAnsi("31")}x: missing command for group '${firstArg}'${errAnsi("0")}\n`);
      process.exit(1);
    }
    const cmdName = argv[1];

    if (cmdName === "--help" || cmdName === "-h") {
      process.stdout.write(formatGroupHelp(grp) + "\n");
      process.exit(0);
    }

    targetCmd = grp.commands.get(cmdName) || null;
    if (!targetCmd) {
      let msg = `${errAnsi("31")}x: unknown command '${firstArg} ${cmdName}'${errAnsi("0")}\n`;
      const suggestion = suggestCommand(`${firstArg} ${cmdName}`);
      if (suggestion) msg += `\n  Did you mean: x ${suggestion}?\n`;
      process.stderr.write(msg);
      process.exit(1);
    }
    remainingArgv = argv.slice(2);
  } else {
    targetCmd = rootGroup.commands.get(firstArg) || null;
    if (!targetCmd) {
      let msg = `${errAnsi("31")}x: unknown command '${firstArg}'${errAnsi("0")}\n`;
      const suggestion = suggestCommand(firstArg);
      if (suggestion) msg += `\n  Did you mean: x ${suggestion}?\n`;
      process.stderr.write(msg);
      process.exit(1);
    }
    remainingArgv = argv.slice(1);
  }

  // Parse arguments
  const result = parseArgv(remainingArgv, targetCmd!);

  if ("help" in result) {
    process.stdout.write(formatCommandHelp(targetCmd!) + "\n");
    process.exit(0);
  }

  if ("error" in result) {
    process.stderr.write(`${errAnsi("31")}x: ${result.error}${errAnsi("0")}\n`);
    process.stderr.write(`\n${formatUsageLine(result.cmd)}\n`);
    process.exit(1);
  }

  const parsed = result as ParsedArgv;

  // Execute
  if (targetCmd!.type === "command") {
    const expanded = expandRestSymbol(targetCmd!.parts as (string | symbol)[], parsed.rest);
    if (expanded.length === 0) {
      process.stderr.write(`${errAnsi("31")}x: command has no arguments to execute${errAnsi("0")}\n`);
      process.exit(1);
    }
    const cwdPath = targetCmd!.userCwd ? userDir : rootDir;
    const [cmd, ...args] = expanded;
    const child = nodeSpawn(cmd, args, { stdio: "inherit", cwd: cwdPath });
    const exitCode = await new Promise<number>((resolve) => {
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          process.stderr.write(`${errAnsi("31")}x: command '${cmd}' not found${errAnsi("0")}\n`);
        } else {
          process.stderr.write(`${errAnsi("31")}x: ${err.message}${errAnsi("0")}\n`);
        }
        resolve(1);
      });
      child.on("close", (code: number | null) => {
        resolve(code ?? 1);
      });
    });
    process.exit(exitCode);
  } else if (targetCmd!.type === "callback") {
    const initialCwd = targetCmd!.userCwd ? userDir : rootDir;
    const ctx = new ExecutionContext(
      parsed.args,
      parsed.options,
      parsed.rest,
      rootDir,
      userDir,
      initialCwd,
    );
    try {
      await targetCmd!.callback!(ctx);
    } catch (err) {
      process.stderr.write(formatUncaughtError(err as Error));
      process.exit(1);
    }
  } else {
    process.stderr.write(`${errAnsi("31")}x: command '${targetCmd!.name}' has no action defined${errAnsi("0")}\n`);
    process.exit(1);
  }
}

