import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Guard the core's gzipped size so it can't silently bloat. Keep some headroom
// over the current ~3KB.
const LIMIT = 6000;

const file = new URL("../dist/index.js", import.meta.url);
const gz = gzipSync(readFileSync(file)).length;

console.log(`@whisperr/web core: ${gz} bytes gzipped (limit ${LIMIT})`);
if (gz > LIMIT) {
  console.error(`FAIL: core bundle exceeds ${LIMIT} bytes gzipped.`);
  process.exit(1);
}
console.log("size OK");
