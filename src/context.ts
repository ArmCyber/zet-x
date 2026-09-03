import { spawn as nodeSpawn } from "node:child_process";
import { resolve as pathResolve, join } from "node:path";
import { createInterface } from "node:readline";
import { CommandOutput, TemplateResult, flattenParts } from "./shared.js";
import { outAnsi, errAnsi, isTaggedTemplate } from "./util.js";

export const REST_SYMBOL: unique symbol = Symbol("rest");


export function buildRunParts(strings: TemplateStringsArray, values: unknown[]): (string | symbol)[] {
  const parts: (string | symbol)[] = [];
  for (let i = 0; i < strings.length; i++) {
    const words = strings[i].split(/\s+/).filter(Boolean);
    for (const word of words) {
      parts.push(word === "..." ? REST_SYMBOL : word);
    }
    if (i < values.length) {
      const val = values[i];
      if (typeof val === "function" && (val as any)._isZetTemplate) {
        if ((val as any)._expectedArgs === 0) {
          const result = (val as any)();
          parts.push(...result.parts);
        } else {
          throw new Error(
            "A template was used without being called -- add () with the required arguments"
          );
        }
      } else if (val instanceof TemplateResult) {
        parts.push(...val.parts);
      } else if (Array.isArray(val)) {
        parts.push(...val.map(String));
      } else {
        parts.push(String(val));
      }
    }
  }
  return parts;
}


export function expandRestSymbol(parts: (string | symbol)[], restArgs: string[]): string[] {
  const result: string[] = [];
  for (const p of parts) {
    if (p === REST_SYMBOL) {
      result.push(...restArgs);
    } else {
      result.push(p as string);
    }
  }
  return result;
}


export function spawnCommand(parts: string[], options: { stdio: "inherit" | "pipe"; cwd?: string }): Promise<CommandOutput> {
  if (parts.length === 0) {
    throw new Error("Cannot execute an empty command");
  }

  return new Promise((resolve) => {
    const [cmd, ...args] = parts;
    const child = nodeSpawn(cmd, args, options);
    let errorOccurred = false;

    child.on("error", (err: NodeJS.ErrnoException) => {
      errorOccurred = true;
      const msg = err.code === "ENOENT"
        ? `Command not found: ${parts[0]}`
        : err.message;
      if (options.stdio === "inherit") {
        process.stderr.write(`${errAnsi("31")}x: ${msg}${errAnsi("0")}\n`);
        resolve(new CommandOutput(1, null, null, null));
      } else {
        resolve(new CommandOutput(1, msg, null, msg));
      }
    });

    if (options.stdio === "pipe") {
      const allChunks: Buffer[] = [];
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout!.on("data", (d: Buffer) => { allChunks.push(d); outChunks.push(d); });
      child.stderr!.on("data", (d: Buffer) => { allChunks.push(d); errChunks.push(d); });
      child.on("close", (code: number | null) => {
        if (errorOccurred) return;
        resolve(new CommandOutput(
          code ?? 1,
          Buffer.concat(allChunks).toString(),
          Buffer.concat(outChunks).toString(),
          Buffer.concat(errChunks).toString(),
        ));
      });
    } else {
      child.on("close", (code: number | null) => {
        if (errorOccurred) return;
        resolve(new CommandOutput(code ?? 1, null, null, null));
      });
    }
  });
}


export interface PathHelper {
  (sub?: string): string;
  [Symbol.toPrimitive](): string;
  toString(): string;
}

export function createPathHelper(basePath: string): PathHelper {
  const fn = ((sub?: string) => sub ? join(basePath, sub) : basePath) as PathHelper;
  fn[Symbol.toPrimitive] = () => basePath;
  fn.toString = () => basePath;
  return fn;
}


export class ExecutionContext {
  private _args: Record<string, string>;
  private _options: Record<string, string | true>;
  private _restArgs: string[];
  private _rootDir: string;
  private _userDir: string;
  private _cwd: string;
  private _rootHelper: PathHelper;
  private _userHelper: PathHelper;

  constructor(
    args: Record<string, string>,
    options: Record<string, string | true>,
    restArgs: string[],
    rootDir: string,
    userDir: string,
    initialCwd: string,
  ) {
    this._args = args;
    this._options = options;
    this._restArgs = restArgs;
    this._rootDir = rootDir;
    this._userDir = userDir;
    this._cwd = initialCwd;
    this._rootHelper = createPathHelper(rootDir);
    this._userHelper = createPathHelper(userDir);
  }

  arg(name: string): string | null {
    return this._args[name] ?? null;
  }

  option(name: string): string | true | null {
    return this._options[name] ?? null;
  }

  run(stringsOrParts: TemplateStringsArray | unknown, ...values: unknown[]): Promise<CommandOutput> {
    let expanded: string[];
    if (isTaggedTemplate(stringsOrParts)) {
      const parts = buildRunParts(stringsOrParts, values);
      expanded = expandRestSymbol(parts, this._restArgs);
    } else {
      expanded = flattenParts([stringsOrParts, ...values]) as string[];
    }
    return spawnCommand(expanded, { stdio: "inherit", cwd: this._cwd });
  }

  async mustRun(stringsOrParts: TemplateStringsArray | unknown, ...values: unknown[]): Promise<CommandOutput> {
    const result = await this.run(stringsOrParts, ...values);
    return result.throw();
  }

  silent(stringsOrParts: TemplateStringsArray | unknown, ...values: unknown[]): Promise<CommandOutput> {
    let expanded: string[];
    if (isTaggedTemplate(stringsOrParts)) {
      const parts = buildRunParts(stringsOrParts, values);
      expanded = expandRestSymbol(parts, this._restArgs);
    } else {
      expanded = flattenParts([stringsOrParts, ...values]) as string[];
    }
    return spawnCommand(expanded, { stdio: "pipe", cwd: this._cwd });
  }

  async mustSilent(stringsOrParts: TemplateStringsArray | unknown, ...values: unknown[]): Promise<CommandOutput> {
    const result = await this.silent(stringsOrParts, ...values);
    return result.throw();
  }

  line(msg: string): void {
    process.stdout.write(`${msg}\n`);
  }

  info(msg: string): void {
    process.stdout.write(`${outAnsi("32")}${msg}${outAnsi("0")}\n`);
  }

  warn(msg: string): void {
    process.stderr.write(`${errAnsi("33")}${msg}${errAnsi("0")}\n`);
  }

  error(msg: string): void {
    process.stderr.write(`${errAnsi("31")}${msg}${errAnsi("0")}\n`);
  }

  private _readLine(): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    return new Promise<string>((res) => {
      rl.once("close", () => { res(""); });
      rl.once("line", (line) => {
        res(line);
        rl.close();
      });
    });
  }

  async confirm(msg: string, defaultValue: boolean = false): Promise<boolean> {
    const yellow = errAnsi("33");
    const reset = errAnsi("0");
    const hint = defaultValue ? "[Y/n]" : "[y/N]";
    while (true) {
      process.stderr.write(`${yellow}${msg} ${hint}${reset} `);
      const answer = (await this._readLine()).trim().toLowerCase();

      if (answer === "") return !!defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      process.stderr.write(`${errAnsi("31")}Please answer y or n.${errAnsi("0")}\n`);
    }
  }

  async prompt(msg: string, defaultValue: string = ""): Promise<string> {
    const cyan = errAnsi("36");
    const reset = errAnsi("0");
    const hint = defaultValue ? ` ${errAnsi("2")}(${defaultValue})${errAnsi("0")}` : "";
    process.stderr.write(`${cyan}${msg}${hint}${reset} `);
    const answer = await this._readLine();
    return answer || defaultValue;
  }

  get root(): PathHelper {
    return this._rootHelper;
  }

  get user(): PathHelper {
    return this._userHelper;
  }

  cd(path: string): void {
    this._cwd = pathResolve(this._cwd, path);
  }
}
