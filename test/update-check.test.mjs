import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  REGISTRY_URL,
  stateFilePath,
  readState,
  isNewerVersion,
  isCheckDue,
  isUpdateCheckEnabled,
  fetchLatestVersion,
  refreshUpdateState,
  requestUpdateCheck,
  getUpdateNotice,
} from "../dist/update-check.js";

const BIN = join(fileURLToPath(import.meta.url), "..", "..", "bin", "x.mjs");
const LIB = join(fileURLToPath(import.meta.url), "..", "..", "dist", "index.js");

const HOUR = 60 * 60 * 1000;

function tmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), "x-update-")));
}

function stateFile() {
  return join(tmpDir(), "zet-x", "update-check.json");
}

function seedState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

// Local stand-in for the npm registry. `handler` receives (req, res).
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/zet-x/latest`;
  try {
    return await fn(url);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const respondWith = (version) => (req, res) => res.end(JSON.stringify({ name: "zet-x", version }));

// A URL nothing listens on — what an unreachable registry looks like
async function unreachableUrl() {
  return withServer(() => {}, async (url) => url);
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("isNewerVersion", () => {
  it("detects newer patch, minor and major versions", () => {
    assert.equal(isNewerVersion("1.0.7", "1.0.6"), true);
    assert.equal(isNewerVersion("1.1.0", "1.0.6"), true);
    assert.equal(isNewerVersion("2.0.0", "1.9.9"), true);
  });

  it("compares numerically, not as strings", () => {
    assert.equal(isNewerVersion("1.0.10", "1.0.9"), true);
    assert.equal(isNewerVersion("1.10.0", "1.9.0"), true);
    assert.equal(isNewerVersion("1.0.9", "1.0.10"), false);
  });

  it("returns false for the same or an older version", () => {
    assert.equal(isNewerVersion("1.0.6", "1.0.6"), false);
    assert.equal(isNewerVersion("1.0.5", "1.0.6"), false);
    assert.equal(isNewerVersion("1.9.9", "2.0.0"), false);
  });

  it("treats a release as newer than its own pre-release", () => {
    assert.equal(isNewerVersion("1.0.7", "1.0.7-beta.1"), true);
    assert.equal(isNewerVersion("1.0.7-beta.1", "1.0.7"), false);
    assert.equal(isNewerVersion("1.0.7-beta.1", "1.0.6"), true);
  });

  it("returns false for anything that is not a version", () => {
    assert.equal(isNewerVersion("latest", "1.0.6"), false);
    assert.equal(isNewerVersion("9.9.9\x1b[31m", "1.0.6"), false);
    assert.equal(isNewerVersion("", "1.0.6"), false);
    assert.equal(isNewerVersion("2.0.0", "unknown"), false);
  });
});

describe("update state", () => {
  it("stores the state under XDG_CACHE_HOME when set", () => {
    assert.equal(
      stateFilePath({ XDG_CACHE_HOME: "/var/cache/me" }),
      join("/var/cache/me", "zet-x", "update-check.json")
    );
  });

  it("falls back to ~/.cache when XDG_CACHE_HOME is unset or relative", () => {
    const expected = join(homedir(), ".cache", "zet-x", "update-check.json");
    assert.equal(stateFilePath({}), expected);
    assert.equal(stateFilePath({ XDG_CACHE_HOME: "relative/cache" }), expected);
  });

  it("reads a missing file as 'never checked'", () => {
    assert.deepEqual(readState(stateFile()), { lastCheck: 0, latest: null, pending: 0 });
  });

  it("reads a corrupt file as 'never checked'", () => {
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true });
    for (const content of ["", "{not json", "null", "[]", '"text"']) {
      writeFileSync(file, content);
      assert.deepEqual(readState(file), { lastCheck: 0, latest: null, pending: 0 });
    }
  });

  it("ignores fields of the wrong type", () => {
    const file = stateFile();
    seedState(file, { lastCheck: "yesterday", latest: 7, pending: null });
    assert.deepEqual(readState(file), { lastCheck: 0, latest: null, pending: 0 });
  });

  it("reads back a valid state", () => {
    const file = stateFile();
    seedState(file, { lastCheck: 1000, latest: "1.2.3", pending: 5 });
    assert.deepEqual(readState(file), { lastCheck: 1000, latest: "1.2.3", pending: 5 });
  });
});

describe("isCheckDue", () => {
  const now = 1800000000000;

  it("is due when never checked", () => {
    assert.equal(isCheckDue({ lastCheck: 0, latest: null, pending: 0 }, now), true);
  });

  it("is not due within 24 hours of a successful check", () => {
    assert.equal(isCheckDue({ lastCheck: now - 1000, latest: "1.0.6", pending: 0 }, now), false);
    assert.equal(isCheckDue({ lastCheck: now - 23 * HOUR, latest: "1.0.6", pending: 0 }, now), false);
  });

  it("is due again once 24 hours have passed", () => {
    assert.equal(isCheckDue({ lastCheck: now - 24 * HOUR, latest: "1.0.6", pending: 0 }, now), true);
    assert.equal(isCheckDue({ lastCheck: now - 72 * HOUR, latest: "1.0.6", pending: 0 }, now), true);
  });

  it("is not due while a check is already running", () => {
    assert.equal(isCheckDue({ lastCheck: 0, latest: null, pending: now - 2000 }, now), false);
  });

  it("is due when a running check never reported back", () => {
    assert.equal(isCheckDue({ lastCheck: 0, latest: null, pending: now - 60 * 1000 }, now), true);
  });

  it("is due when the clock moved backwards", () => {
    assert.equal(isCheckDue({ lastCheck: now + HOUR, latest: "1.0.6", pending: 0 }, now), true);
    assert.equal(isCheckDue({ lastCheck: 0, latest: null, pending: now + HOUR }, now), true);
  });
});

describe("isUpdateCheckEnabled", () => {
  it("is enabled in an interactive terminal", () => {
    assert.equal(isUpdateCheckEnabled(["hello"], {}, true), true);
    assert.equal(isUpdateCheckEnabled([], {}, true), true);
    assert.equal(isUpdateCheckEnabled(["--help"], {}, true), true);
  });

  it("is disabled when stderr is not a terminal", () => {
    assert.equal(isUpdateCheckEnabled(["hello"], {}, false), false);
  });

  it("is disabled in CI", () => {
    assert.equal(isUpdateCheckEnabled(["hello"], { CI: "true" }, true), false);
    assert.equal(isUpdateCheckEnabled(["hello"], { CI: "1" }, true), false);
    assert.equal(isUpdateCheckEnabled(["hello"], { CI: "false" }, true), true);
  });

  it("is disabled by NO_UPDATE_NOTIFIER", () => {
    assert.equal(isUpdateCheckEnabled(["hello"], { NO_UPDATE_NOTIFIER: "1" }, true), false);
  });

  it("is disabled for x invoked from inside an x command", () => {
    assert.equal(isUpdateCheckEnabled(["hello"], { X_ROOT_DIR: "/project" }, true), false);
  });

  it("is disabled for shell completion", () => {
    assert.equal(isUpdateCheckEnabled(["--completions"], {}, true), false);
    assert.equal(isUpdateCheckEnabled(["--completions", "db"], {}, true), false);
  });
});

describe("fetchLatestVersion", () => {
  it("asks the npm registry for the latest zet-x by default", () => {
    assert.equal(REGISTRY_URL, "https://registry.npmjs.org/zet-x/latest");
  });

  it("returns the version reported by the registry", async () => {
    let seen;
    const version = await withServer(
      (req, res) => {
        seen = req.url;
        respondWith("1.2.3")(req, res);
      },
      (url) => fetchLatestVersion(url)
    );
    assert.equal(version, "1.2.3");
    assert.equal(seen, "/zet-x/latest");
  });

  it("returns null on an error response", async () => {
    for (const status of [404, 500, 503]) {
      const version = await withServer(
        (req, res) => {
          res.statusCode = status;
          res.end(JSON.stringify({ version: "1.2.3" }));
        },
        (url) => fetchLatestVersion(url)
      );
      assert.equal(version, null, `status ${status}`);
    }
  });

  it("returns null when the response is not the expected JSON", async () => {
    const bodies = ["<html>Sign in to the network</html>", "", "null", "{}", '{"version":2}', '{"version":"latest"}'];
    for (const body of bodies) {
      const version = await withServer((req, res) => res.end(body), (url) => fetchLatestVersion(url));
      assert.equal(version, null, `body ${JSON.stringify(body)}`);
    }
  });

  it("returns null when the registry is unreachable", async () => {
    assert.equal(await fetchLatestVersion(await unreachableUrl()), null);
  });

  it("gives up when the registry does not answer in time", async () => {
    const started = Date.now();
    const version = await withServer(() => {}, (url) => fetchLatestVersion(url, 100));
    assert.equal(version, null);
    assert.ok(Date.now() - started < 3000, "should stop at the timeout");
  });

  it("gives up when the response stalls midway", async () => {
    const version = await withServer(
      (req, res) => res.write('{"version":'),
      (url) => fetchLatestVersion(url, 100)
    );
    assert.equal(version, null);
  });
});

describe("refreshUpdateState", () => {
  it("records the latest version and the time of the check", async () => {
    const file = stateFile();
    const before = Date.now();
    await withServer(respondWith("2.0.0"), (url) => refreshUpdateState(file, url));
    const state = readState(file);
    assert.equal(state.latest, "2.0.0");
    assert.equal(state.pending, 0);
    assert.ok(state.lastCheck >= before && state.lastCheck <= Date.now());
  });

  it("does not count a failed check, so the next run checks again", async () => {
    const file = stateFile();
    const now = Date.now();
    seedState(file, { lastCheck: 0, latest: null, pending: now });
    await refreshUpdateState(file, await unreachableUrl());
    const state = readState(file);
    assert.deepEqual(state, { lastCheck: 0, latest: null, pending: 0 });
    assert.equal(isCheckDue(state, now), true);
  });

  it("keeps what was already known when a later check fails", async () => {
    const file = stateFile();
    const lastCheck = Date.now() - 30 * HOUR;
    seedState(file, { lastCheck, latest: "1.5.0", pending: Date.now() });
    await refreshUpdateState(file, await unreachableUrl());
    assert.deepEqual(readState(file), { lastCheck, latest: "1.5.0", pending: 0 });
  });

  it("does not throw when the state cannot be written", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "blocked"), "a file where the cache directory should be");
    const file = join(dir, "blocked", "update-check.json");
    await withServer(respondWith("2.0.0"), (url) => refreshUpdateState(file, url));
    assert.deepEqual(readState(file), { lastCheck: 0, latest: null, pending: 0 });
  });
});

describe("requestUpdateCheck", () => {
  it("checks in the background and records the latest version", async () => {
    const file = stateFile();
    await withServer(respondWith("3.1.4"), async (url) => {
      assert.equal(requestUpdateCheck(file, url), true);
      assert.ok(await waitFor(() => readState(file).latest === "3.1.4"), "worker should record the version");
    });
    const state = readState(file);
    assert.equal(state.pending, 0);
    assert.equal(isCheckDue(state, Date.now()), false);
  });

  it("does not check again within 24 hours", async () => {
    const file = stateFile();
    const seeded = { lastCheck: Date.now() - HOUR, latest: "1.0.6", pending: 0 };
    seedState(file, seeded);
    let requests = 0;
    await withServer(
      (req, res) => {
        requests++;
        respondWith("9.9.9")(req, res);
      },
      async (url) => {
        assert.equal(requestUpdateCheck(file, url), false);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    );
    assert.equal(requests, 0);
    assert.deepEqual(readState(file), seeded);
  });

  it("checks again once the last check is older than 24 hours", async () => {
    const file = stateFile();
    seedState(file, { lastCheck: Date.now() - 25 * HOUR, latest: "1.0.6", pending: 0 });
    await withServer(respondWith("1.0.7"), async (url) => {
      assert.equal(requestUpdateCheck(file, url), true);
      assert.ok(await waitFor(() => readState(file).latest === "1.0.7"));
    });
  });

  it("does not start a second check while one is running", async () => {
    const file = stateFile();
    await withServer(() => {}, async (url) => {
      assert.equal(requestUpdateCheck(file, url), true);
      assert.equal(requestUpdateCheck(file, url), false);
    });
  });

  it("stays silent when the registry is unreachable and retries on the next run", async () => {
    const file = stateFile();
    const deadUrl = await unreachableUrl();

    assert.equal(requestUpdateCheck(file, deadUrl), true);
    assert.ok(await waitFor(() => readState(file).pending === 0), "failed worker should finish");
    assert.deepEqual(readState(file), { lastCheck: 0, latest: null, pending: 0 });
    assert.equal(getUpdateNotice(file, "1.0.6"), "");

    // Next run, registry is back
    await withServer(respondWith("1.0.7"), async (url) => {
      assert.equal(requestUpdateCheck(file, url), true);
      assert.ok(await waitFor(() => readState(file).latest === "1.0.7"));
    });
    assert.match(getUpdateNotice(file, "1.0.6"), /an update is available/);
  });

  it("does nothing when the cache directory cannot be created", async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "blocked"), "a file where the cache directory should be");
    const file = join(dir, "blocked", "update-check.json");
    let requests = 0;
    await withServer(
      (req, res) => {
        requests++;
        respondWith("9.9.9")(req, res);
      },
      async (url) => {
        assert.equal(requestUpdateCheck(file, url), false);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    );
    assert.equal(requests, 0);
  });
});

describe("getUpdateNotice", () => {
  it("tells the user how to update when a newer version is known", () => {
    const file = stateFile();
    seedState(file, { lastCheck: Date.now(), latest: "1.0.7", pending: 0 });
    const notice = getUpdateNotice(file, "1.0.6");
    assert.match(notice, /x: an update is available: 1\.0\.6 → 1\.0\.7/);
    assert.match(notice, /Please run "npm install -g zet-x" to update\./);
    assert.ok(notice.endsWith("\n"));
  });

  it("is empty when the installed version is current", () => {
    const file = stateFile();
    seedState(file, { lastCheck: Date.now(), latest: "1.0.6", pending: 0 });
    assert.equal(getUpdateNotice(file, "1.0.6"), "");
  });

  it("is empty once the user has updated past the cached version", () => {
    const file = stateFile();
    seedState(file, { lastCheck: Date.now(), latest: "1.0.7", pending: 0 });
    assert.equal(getUpdateNotice(file, "1.0.7"), "");
    assert.equal(getUpdateNotice(file, "2.0.0"), "");
  });

  it("is empty when nothing has been checked yet", () => {
    assert.equal(getUpdateNotice(stateFile(), "1.0.6"), "");
  });

  it("never prints a cached value that is not a version", () => {
    const file = stateFile();
    seedState(file, { lastCheck: Date.now(), latest: "9.9.9\x1b[2J", pending: 0 });
    assert.equal(getUpdateNotice(file, "1.0.6"), "");
  });
});

describe("update check through bin/x.mjs", () => {
  function run(cwd, args, env) {
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

  function project() {
    const dir = tmpDir();
    writeFileSync(
      join(dir, "x.config.mjs"),
      `import { register } from '${LIB}';\nregister('hello').run('echo', 'hi');\n`
    );
    return dir;
  }

  it("stays out of the way when output is not a terminal", async () => {
    const cache = tmpDir();
    const file = join(cache, "zet-x", "update-check.json");
    const seeded = JSON.stringify({ lastCheck: 0, latest: "999.0.0", pending: 0 });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, seeded);

    const result = await run(project(), ["hello"], { XDG_CACHE_HOME: cache });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hi\n");
    assert.doesNotMatch(result.stderr, /update is available/);
    // Untouched state: no note was due to be shown and no background check was started
    assert.equal(readFileSync(file, "utf8"), seeded);
  });

  it("does not create a cache file when output is not a terminal", async () => {
    const cache = tmpDir();
    const result = await run(project(), ["hello"], { XDG_CACHE_HOME: cache });
    assert.equal(result.code, 0);
    assert.ok(!existsSync(join(cache, "zet-x")));
  });
});
