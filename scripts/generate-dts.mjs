#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist");

const indexDts = readFileSync(join(DIST, "index.d.ts"), "utf8");
const contextDts = readFileSync(join(DIST, "context.d.ts"), "utf8");
const sharedDts = readFileSync(join(DIST, "shared.d.ts"), "utf8");

// Extract class/interface declarations and convert to interface-only DTS
// We build the module declaration by hand from the compiled types

function extractBlock(source, pattern) {
  const idx = source.indexOf(pattern);
  if (idx === -1) return null;
  let depth = 0;
  let start = idx;
  let foundOpen = false;
  for (let i = idx; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      foundOpen = true;
    } else if (source[i] === "}") {
      depth--;
      if (foundOpen && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

function classToInterface(block, name, skipFields = []) {
  let lines = block.split("\n");
  // Remove the class declaration line and closing brace
  lines = lines.slice(1, -1);

  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip constructor, private, #private
    if (trimmed.startsWith("constructor(")) continue;
    if (trimmed.startsWith("private ")) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed === "") continue;
    if (skipFields.some(f => trimmed.startsWith(f))) continue;
    // Remove 'declare' keyword
    let cleaned = line.replace(/\bdeclare\s+/, "");
    // Remove access modifiers
    cleaned = cleaned.replace(/\bpublic\s+/, "");
    result.push(cleaned);
  }

  return `  interface ${name} {\n${result.join("\n")}\n  }`;
}

// --- Extract CommandOutput from shared.d.ts ---
const commandOutputBlock = extractBlock(sharedDts, "export declare class CommandOutput");
const commandOutputIface = commandOutputBlock
  ? classToInterface(commandOutputBlock, "CommandOutput")
  : null;

// --- Extract TemplateResult from shared.d.ts ---
const templateResultBlock = extractBlock(sharedDts, "export declare class TemplateResult");
const templateResultIface = templateResultBlock
  ? classToInterface(templateResultBlock, "TemplateResult")
  : null;

// --- Extract PathHelper from context.d.ts ---
const pathHelperBlock = extractBlock(contextDts, "export interface PathHelper");
let pathHelperIface = null;
if (pathHelperBlock) {
  pathHelperIface = "  " + pathHelperBlock
    .split("\n")
    .filter(line => !line.includes("[Symbol.toPrimitive]"))
    .join("\n")
    .replace("export interface", "interface")
    .split("\n").join("\n  ");
}

// --- Extract ExecutionContext from context.d.ts ---
const execCtxBlock = extractBlock(contextDts, "export declare class ExecutionContext");
const execCtxIface = execCtxBlock
  ? classToInterface(execCtxBlock, "ExecutionContext")
  : null;

// --- Extract CommandBuilder from index.d.ts ---
const cmdBuilderBlock = extractBlock(indexDts, "export declare class CommandBuilder");
let cmdBuilderIface = cmdBuilderBlock
  ? classToInterface(cmdBuilderBlock, "CommandBuilder")
  : null;

// --- Extract Group from index.d.ts ---
const groupBlock = extractBlock(indexDts, "export declare class Group");
const groupIface = groupBlock
  ? classToInterface(groupBlock, "Group", ["commands:"])
  : null;

// Build the module declaration
const parts = [];
parts.push('declare module "zet-x" {');

if (commandOutputIface) parts.push(commandOutputIface);
parts.push("");

if (pathHelperIface) parts.push(pathHelperIface);
parts.push("");

if (execCtxIface) parts.push(execCtxIface);
parts.push("");

if (templateResultIface) parts.push(templateResultIface);
parts.push("");

if (cmdBuilderIface) parts.push(cmdBuilderIface);
parts.push("");

if (groupIface) parts.push(groupIface);
parts.push("");

// Add exported functions
const functionExports = [
  "  export function register(signature: string, description?: string): CommandBuilder;",
  "  export function group(prefix: string, description: string): Group;",
  "  export function template(fn: (...args: (string | TemplateResult)[]) => string | unknown[]): (...args: (string | TemplateResult)[]) => TemplateResult;",
  "  export function setAiPublishPath(path: string | null, asSkill?: boolean): void;",
  "  export function setIdePublishPath(path: string | null): void;",
  "  export function autoPublishIde(): void;",
];
parts.push(functionExports.join("\n"));

parts.push("}");

const dtsContent = parts.join("\n") + "\n";

// Write as a JS module that exports the string
const output = `export const DTS_CONTENT = ${JSON.stringify(dtsContent)};\n`;
writeFileSync(join(DIST, "dts-content.js"), output);

console.log("Generated dist/dts-content.js");
