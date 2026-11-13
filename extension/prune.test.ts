// Run: node --experimental-strip-types prune.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AGE_MS, prune } from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "am-prune-"));
const make = (name: string, ageMs: number) => {
	const path = join(dir, name);
	writeFileSync(path, "{}");
	const when = (Date.now() - ageMs) / 1000;
	utimesSync(path, when, when);
	return path;
};
const hour = 60 * 60 * 1000;
const mine = make("t1.json", 3 * MAX_AGE_MS); // this session's own file: kept however old
const fresh = make("t2.json", hour); // another session, recent: kept
const stale = make("t3.json", MAX_AGE_MS + hour); // another session, a day quiet: deleted
const leftover = make("t4.json.tmp", MAX_AGE_MS + hour); // a temporary file left behind: deleted
const other = make("notes.txt", 3 * MAX_AGE_MS); // not ours: never touched

prune(dir, mine);
assert.ok(existsSync(mine), "own file kept");
assert.ok(existsSync(fresh), "recent file kept");
assert.ok(!existsSync(stale), "day-old file deleted");
assert.ok(!existsSync(leftover), "leftover temporary file deleted");
assert.ok(existsSync(other), "files that are not ours are left alone");
prune(join(dir, "missing"), mine); // no folder: no error
console.log("ok");
