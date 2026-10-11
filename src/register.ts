import module from "node:module";
import { resolve } from "./loader.js";

// Node 26 runtime-deprecates module.register() (DEP0205). Use the synchronous
// in-thread hooks where they exist (Node >=22.15 / >=23.5) and fall back to the
// asynchronous off-thread loader on older versions.
if (typeof module.registerHooks === "function") {
  module.registerHooks({ resolve });
} else {
  module.register("./loader.js", import.meta.url);
}
