import { refreshUpdateState } from "./update-check.js";

// Detached process spawned by requestUpdateCheck(): <stateFile> <registryUrl>
await refreshUpdateState(process.argv[2], process.argv[3]);
