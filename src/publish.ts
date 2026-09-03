import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { outAnsi } from "./util.js";

function showPublishHelp(): void {
  const yellow = outAnsi("33");
  const green = outAnsi("32");
  const dim = outAnsi("2");
  const reset = outAnsi("0");

  const lines: string[] = [];
  lines.push(`${yellow}Usage:${reset} x cli publish ${dim}<command>${reset}`);
  lines.push("");
  lines.push(`${yellow}Commands:${reset}`);
  lines.push(`  ${green}ai${reset}     Generate zet-x.md (AI agent documentation)`);
  lines.push(`  ${green}ide${reset}    Generate TypeScript declarations for IDE support`);
  lines.push("");
  lines.push(`${dim}Output paths are configurable in x.config.mjs:${reset}`);
  lines.push(`  ${dim}setAiPublishPath('docs/')${reset}            zet-x.md → docs/zet-x.md`);
  lines.push(`  ${dim}setAiPublishPath('SKILL.md', true)${reset}   prepend skill frontmatter`);
  lines.push(`  ${dim}setIdePublishPath('.types/')${reset}         .d.ts → .types/index.d.ts`);
  process.stdout.write(lines.join("\n") + "\n");
}

function loadAiReference(): string {
  const templatePath = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "ai-reference.md");
  return readFileSync(templatePath, "utf8");
}

function isMarkdownFile(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdc");
}

interface CliConfig {
  aiPublishPath: string | null;
  aiPublishAsSkill: boolean;
  idePublishPath: string | null;
}

const SKILL_FRONTMATTER = `---
name: zet-x
description: x command runner reference. Use this skill when the user mentions zet x, x config mjs, project tasks or commands, or asks about configuring/running commands with the zet x or simply x.
---

`;

function handleAiRules(projectRoot: string, config: CliConfig): void {
  let filePath: string;

  if (config.aiPublishPath) {
    const resolved = join(projectRoot, config.aiPublishPath);
    if (isMarkdownFile(config.aiPublishPath)) {
      filePath = resolved;
      mkdirSync(dirname(filePath), { recursive: true });
    } else {
      mkdirSync(resolved, { recursive: true });
      filePath = join(resolved, "zet-x.md");
    }
  } else {
    filePath = join(projectRoot, "zet-x.md");
  }

  let content = loadAiReference();
  if (config.aiPublishAsSkill) {
    content = SKILL_FRONTMATTER + content;
  }

  writeFileSync(filePath, content);
  process.stdout.write(`Created ${filePath}\n`);
}

async function handleIdeSpecs(projectRoot: string, config: CliConfig): Promise<void> {
  // @ts-expect-error — dts-content.js is generated post-compile by scripts/generate-dts.mjs
  const { DTS_CONTENT } = await import("./dts-content.js") as { DTS_CONTENT: string };
  let dir: string;

  if (config.idePublishPath) {
    dir = join(projectRoot, config.idePublishPath);
  } else {
    dir = join(projectRoot, ".x");
  }

  mkdirSync(dir, { recursive: true });
  const dtsPath = join(dir, "index.d.ts");
  writeFileSync(dtsPath, DTS_CONTENT);
  process.stdout.write(`Created TypeScript declarations at ${dtsPath}\n`);
}


export async function handleCli(argv: string[], projectRoot: string, config: CliConfig): Promise<void> {
  const subcommand = argv[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    showPublishHelp();
    return;
  }

  if (subcommand === "ai") {
    handleAiRules(projectRoot, config);
    return;
  }

  if (subcommand === "ide") {
    await handleIdeSpecs(projectRoot, config);
    return;
  }

  process.stderr.write(`x: unknown publish command '${subcommand}'\n`);
  showPublishHelp();
  process.exit(1);
}
