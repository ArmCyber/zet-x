import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errAnsi } from "./util.js";

export const REGISTRY_URL = "https://registry.npmjs.org/zet-x/latest";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
// A background check that has not reported back after this long is assumed dead
const PENDING_TTL_MS = 10000;

export interface UpdateState {
  lastCheck: number;
  latest: string | null;
  pending: number;
}

export function stateFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(base, "zet-x", "update-check.json");
}

export function readState(file: string): UpdateState {
  const state: UpdateState = { lastCheck: 0, latest: null, pending: 0 };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw.lastCheck === "number") state.lastCheck = raw.lastCheck;
    if (typeof raw.latest === "string") state.latest = raw.latest;
    if (typeof raw.pending === "number") state.pending = raw.pending;
  } catch {
    // Missing or unreadable state means "never checked"
  }
  return state;
}

function writeState(file: string, state: UpdateState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function isNewerVersion(latest: string, current: string): boolean {
  const a = VERSION_RE.exec(latest);
  const b = VERSION_RE.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  // Same x.y.z: a release is newer than its own pre-releases
  return !a[4] && !!b[4];
}

export function isCheckDue(state: UpdateState, now: number): boolean {
  const sinceCheck = now - state.lastCheck;
  const sincePending = now - state.pending;
  const stale = sinceCheck < 0 || sinceCheck >= CHECK_INTERVAL_MS;
  const inFlight = sincePending >= 0 && sincePending < PENDING_TTL_MS;
  return stale && !inFlight;
}

export function isUpdateCheckEnabled(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = !!process.stderr.isTTY,
): boolean {
  // The note goes to stderr; without a terminal (pipes, CI logs) nobody reads it
  if (!isTTY) return false;
  if ((env.CI && env.CI !== "false") || env.NO_UPDATE_NOTIFIER) return false;
  // Nested `x` inside a command: the outermost invocation reports
  if (env.X_ROOT_DIR) return false;
  // Runs on every <tab>
  if (argv[0] === "--completions") return false;
  return true;
}

export async function fetchLatestVersion(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    // Loaded here so only the background worker pays for the HTTP stack
    const { get } = url.startsWith("http:") ? await import("node:http") : await import("node:https");
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      get(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) }, resolve)
        .on("error", reject);
    });
    res.setEncoding("utf8");
    let body = "";
    for await (const chunk of res) body += chunk;
    if (res.statusCode !== 200) return null;
    const version: unknown = JSON.parse(body).version;
    return typeof version === "string" && VERSION_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

// Runs in the detached worker (update-worker.ts)
export async function refreshUpdateState(file: string, url: string = REGISTRY_URL): Promise<void> {
  const latest = await fetchLatestVersion(url);
  const state = readState(file);
  try {
    if (latest === null) {
      // Registry unreachable: keep lastCheck as is so the next run checks again
      writeState(file, { ...state, pending: 0 });
    } else {
      writeState(file, { lastCheck: Date.now(), latest, pending: 0 });
    }
  } catch {
    // Best-effort
  }
}

export function requestUpdateCheck(file: string, url: string = REGISTRY_URL): boolean {
  try {
    const state = readState(file);
    const now = Date.now();
    if (!isCheckDue(state, now)) return false;

    // Stamped first: if the cache is not writable a check could never be recorded, so none is started
    writeState(file, { ...state, pending: now });
    const worker = fileURLToPath(new URL("./update-worker.js", import.meta.url));
    const child = spawn(process.execPath, [worker, file, url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function getUpdateNotice(file: string, current: string): string {
  const { latest } = readState(file);
  if (!latest || !isNewerVersion(latest, current)) return "";

  const yellow = errAnsi("33");
  const dim = errAnsi("2");
  const reset = errAnsi("0");
  return (
    `\n${yellow}x: an update is available: ${current} → ${latest}${reset}\n` +
    `${dim}Please run "npm install -g zet-x" to update.${reset}\n`
  );
}

function installedVersion(): string {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

// Called by bin/x.mjs before the command runs. Kicks off the daily background
// check when it is due and returns a function that prints the update note (if
// any) once the command has finished. Never throws: updates are best-effort.
export function startUpdateCheck(argv: string[]): () => void {
  const noop = () => {};
  try {
    if (!isUpdateCheckEnabled(argv)) return noop;
    const file = stateFilePath();
    requestUpdateCheck(file);
    return () => {
      try {
        process.stderr.write(getUpdateNotice(file, installedVersion()));
      } catch {
        // Best-effort
      }
    };
  } catch {
    return noop;
  }
}
