#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONFIG_NAME = "x.config.mjs";

const cliArgs = process.argv.slice(2);

if (cliArgs[0] === "--version" || cliArgs[0] === "-v") {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

if (cliArgs[0] === "init") {
  const configFile = join(process.cwd(), "x.config.mjs");
  if (existsSync(configFile)) {
    process.stderr.write("x is already initialized in this directory\n");
    process.exit(1);
  }
  writeFileSync(
    configFile,
    `import { register } from 'zet-x';

register('hello', 'Say hello')
  .callback(async ($) => {
    $.info('Hello from ZET X!');
  });
`
  );
  process.stdout.write("Created x.config.mjs\n");
  process.exit(0);
}


if (cliArgs[0] === "cli" && cliArgs[1] === "init-completion") {
  const shell = cliArgs[2];
  if (shell === "bash") {
    process.stdout.write(`_x_completions() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  local completions
  if [ $COMP_CWORD -eq 1 ]; then
    completions=$(x --completions 2>/dev/null)
  elif [ $COMP_CWORD -eq 2 ]; then
    completions=$(x --completions "\${COMP_WORDS[1]}" 2>/dev/null)
  elif [ $COMP_CWORD -eq 3 ]; then
    completions=$(x --completions "\${COMP_WORDS[1]}" "\${COMP_WORDS[2]}" 2>/dev/null)
  fi
  COMPREPLY=( $(compgen -W "$completions" -- "$cur") )
}
complete -F _x_completions x
`);
    process.exit(0);
  } else if (shell === "zsh") {
    process.stdout.write(`# Completion for x
_x() {
  local -a commands
  if (( CURRENT == 2 )); then
    commands=(\${(f)"$(x --completions 2>/dev/null)"})
    _describe 'command' commands
  elif (( CURRENT == 3 )); then
    commands=(\${(f)"$(x --completions \${words[2]} 2>/dev/null)"})
    _describe 'subcommand' commands
  elif (( CURRENT == 4 )); then
    commands=(\${(f)"$(x --completions \${words[2]} \${words[3]} 2>/dev/null)"})
    _describe 'subcommand' commands
  fi
}
compdef _x x
`);
    process.exit(0);
  } else {
    process.stderr.write("Usage: x cli init-completion <bash|zsh>\n");
    process.exit(1);
  }
}


function findConfig(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const configPath = findConfig(process.cwd());

if (!configPath) {
  process.stderr.write(
    "x: cannot find x.config.mjs in the current or any parent directory\n"
  );
  process.exit(1);
}

// Register a module resolution hook so configs can `import { register } from 'zet-x'`
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [major, minor] = process.versions.node.split(".").map(Number);

const supported = (major === 18 && minor >= 19) || (major === 20 && minor >= 6) || major > 20;
if (!supported) {
  const y = !process.env.NO_COLOR && process.stderr.isTTY ? "\x1b[1;33m" : "";
  const r = y ? "\x1b[0m" : "";
  process.stderr.write(
    `${y}x: Node.js ${process.versions.node} is not supported. Requires ^18.19 or >=20.6.${r}\n`
  );
}

const nodeArgs = [];

if (major > 20 || (major === 20 && minor >= 6) || (major === 18 && minor >= 19)) {
  nodeArgs.push(
    "--import",
    pathToFileURL(join(pkgRoot, "dist", "register.js")).href
  );
} else {
  nodeArgs.push(
    "--loader",
    pathToFileURL(join(pkgRoot, "dist", "loader.js")).href
  );
}

const runnerPath = join(pkgRoot, "dist", "runner.js");
const projectRoot = dirname(configPath);

const child = spawn(
  process.execPath,
  [...nodeArgs, runnerPath, configPath, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      X_ROOT_DIR: projectRoot,
    },
  }
);

process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
