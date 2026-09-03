import { pathToFileURL } from "node:url";
import { formatUncaughtError, init } from "./index.js";

process.on("uncaughtException", (err: Error) => {
  process.stderr.write(formatUncaughtError(err));
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  process.stderr.write(formatUncaughtError(err));
  process.exit(1);
});

const configPath = process.argv[2];
const runnerScript = process.argv[1];
process.argv = [process.argv[0], runnerScript, ...process.argv.slice(3)];

try {
  await import(pathToFileURL(configPath).href);
} catch (err) {
  process.stderr.write(formatUncaughtError(err as Error));
  process.exit(1);
}

await init();
