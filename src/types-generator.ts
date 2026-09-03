import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export async function regenerateTypes(projectRoot: string, idePublishPath: string | null): Promise<void> {
  try {
    let dir: string;
    if (idePublishPath) {
      dir = join(projectRoot, idePublishPath);
    } else {
      dir = join(projectRoot, ".x");
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // @ts-expect-error — dts-content.js is generated post-compile by scripts/generate-dts.mjs
    const { DTS_CONTENT } = await import("./dts-content.js") as { DTS_CONTENT: string };
    writeFileSync(join(dir, "index.d.ts"), DTS_CONTENT);
  } catch {
    // Types are best-effort
  }
}
