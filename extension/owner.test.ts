// Run: node --experimental-strip-types owner.test.ts
// The main session writes the map; subagents in the same process, and pi processes it starts, never do.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "am-owner-"));
process.env.HOME = home; // where the extension writes, read when it loads
process.env.HC_TERMINAL_ID = "t9";
delete process.env.SHEPHERDS_PI_PID;
const { default: extension } = await import("./index.ts");
const file = join(home, ".cache", "shepherds-pi", "t9.json");
const read = () => JSON.parse(readFileSync(file, "utf8"));
const tick = () => new Promise((done) => setImmediate(done)); // writes are made just after a burst of events

/** A stand-in for pi: keeps each handler so the test can fire events. */
const session = () => {
	const on: Record<string, (e: any, ctx: any) => void> = {};
	extension({ on: (name: string, fn: any) => void (on[name] = fn), registerCommand: () => {} } as any);
	return on;
};
const ctx = (cost: number) => ({
	model: { id: "claude-x" },
	sessionManager: { getEntries: () => [{ type: "message", message: { role: "assistant", usage: { cost: { total: cost } } } }] },
	getContextUsage: () => ({ percent: 10 }),
});

const main = session();
main.session_start({}, ctx(5));
main.input({ text: "fix the bug", source: "interactive" }, ctx(5));
await tick();
assert.equal(read().cost, 5, "the main session writes its map");

const subagent = session(); // pi-subagents: another session in this same process
subagent.session_start({}, ctx(0.1));
subagent.input({ text: "subtask", source: "interactive" }, ctx(0.1));
subagent.message_end({ message: { role: "assistant", content: [] } }, ctx(0.1));
await tick();
assert.equal(read().cost, 5, "a subagent never overwrites the main session's map");
assert.equal(read().entries.length, 1, "nor adds its events to it");

assert.equal(process.env.SHEPHERDS_PI_PID, String(process.pid), "processes this pi starts are told who writes");

// A reload: the old runtime shuts down, a new one starts and takes over.
main.session_shutdown({}, ctx(5));
const reloaded = session();
reloaded.session_start({}, ctx(6));
await tick();
assert.equal(read().cost, 6, "after a reload the new main session writes again");
// A burst of events makes one write, and the cost follows each reply between the full sums.
reloaded.input({ text: "go", source: "interactive" }, ctx(6));
for (let i = 0; i < 10; i++) reloaded.tool_execution_start({ toolCallId: `c${i}`, toolName: "read", args: { path: `/a/b${i}` } }, ctx(6));
reloaded.message_end({ message: { role: "assistant", content: [], usage: { cost: { total: 0.5 } } } }, ctx(6));
await tick();
assert.equal(read().entries.filter((e: any) => e.station === "files").length, 10, "all ten calls are recorded");
assert.equal(read().cost, 6.5, "a reply adds its cost at once");
reloaded.agent_end({ messages: [] }, ctx(7));
assert.equal(read().cost, 7, "the turn's end takes the exact sum, written at once");
console.log("ok");
