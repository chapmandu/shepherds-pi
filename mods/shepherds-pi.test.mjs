// Draws the panel once with a sample board, outside Herdr, to catch mistakes `herdr-app check` misses
// (it draws with no data). Run: node mods/shepherds-pi.test.mjs
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Any element method returns the element, so every builder chain works; callbacks are run to reach their code.
const el = () => new Proxy(function () {}, {
  get: (_t, k) => (k === "then" ? undefined : k === "when" ? (c, f) => (c ? f(el()) : el()) : (...args) => { for (const a of args) if (typeof a === "string") globalThis.drawn?.push(a); for (const a of args) if (typeof a === "function" && a.length <= 1) try { a(el()); } catch (e) { throw e; } return el(); }),
  apply: () => el(),
});
const stubs = `
const el = ${el.toString()};
class View {}
const div = el, svg = el, image = el, h_flex = el, v_flex = el;
const appHome = () => "/home/x/.config/herdr-app";
const exec = async () => ({ code: 0, stdout: "x", stderr: "" }); // as if a picture were found
const PathBuilder = { stroke: el, fill: el };
const theme = () => new Proxy({}, { get: () => "#336699" });
const focused = () => ({ terminal: "t1", tab: "tab1" });
const panes = () => [];
const agents = () => [];
const home = () => "/home/x";
let board = null;
const readTextFile = async () => board;
const watchFolder = () => new Promise(() => {});
globalThis.window = { paint_path: el };
export const setBoard = (b) => { board = b; };
`;
const src = readFileSync(new URL("./shepherds-pi/main.js", import.meta.url), "utf8").replace(/^import .*$/gm, "");
const file = join(mkdtempSync(join(tmpdir(), "am-")), "main.mjs");
writeFileSync(file, stubs + src);
const mod = await import(file);

const n = Date.now();
const E = (station, label, status, ago) => ({ id: `${station}${ago}`, station, label, status, start: n - ago, ...(status === "run" ? {} : { end: n - ago + 1500 }) });
mod.setBoard(JSON.stringify({
  model: "claude-x", context: 75, cost: 1.5,
  counts: { you: 2, model: 3, files: 2, shell: 1 }, faults: { shell: 1 },
  route: [{ station: "you", at: n - 50000 }, { station: "files", at: n - 1000 }],
  links: { "files>you": { n: 1, at: n - 1000 }, "shell>you": { n: 2, at: n - 3600000 } }, // one fresh, one long quiet
  entries: [E("you", "new message", "ok", 90000), E("files", "read a.ts", "ok", 80000), E("you", "answer ready", "ok", 70000),
    E("you", "new message", "ok", 50000), E("model", "x · step 1", "ok", 40000), E("shell", "npm", "err", 30000),
    E("files", "edit a.ts", "run", 1000), E("model", "x · step 2", "run", 500)],
  doneAt: n - 70000,
}));

const view = new mod.default();
const cx = { timer: { every() {} }, spawn: (f) => f(cx), notify() {} };
view.init({}, cx);
await new Promise((r) => setTimeout(r, 10));
assert.ok(view.board, "the board loads");
assert.equal(view.avatar, "mods/shepherds-pi/avatar.png", "a picture of your own in the mod folder comes first");
view.open.add(view.board.entries[0].id); // an earlier turn opened
const says = () => { globalThis.drawn = []; view.render(cx); return globalThis.drawn; };
assert.ok(says().includes("edit a.ts"), "working: the running call leads");

// Waiting for you: nothing running, the answer given.
view.board = { ...view.board, entries: view.board.entries.filter((e) => e.status !== "run").concat(E("you", "answer ready", "ok", 100)) };
assert.ok(says().includes("Waiting for you"), "after the answer: waiting");

// Between two steps nothing runs, but the turn is not over: never "Waiting for you".
view.board = { ...view.board, entries: view.board.entries.slice(0, -1).concat(E("you", "new message", "ok", 50), E("files", "read b.ts", "ok", 20)) };
const between = says();
assert.ok(between.includes("Working") && !between.includes("Waiting for you"), "between steps: working");
// A fresh session, before any message: idle, not working.
view.board = { ...view.board, entries: [] };
const fresh = says();
assert.ok(fresh.includes("Idle") && !fresh.includes("Working"), "fresh session: idle");

// An earlier turn whose end was never recorded stops where the next turn starts, not at "now".
view.board = { ...view.board, entries: [E("you", "new message", "ok", 90000), E("files", "read c.ts", "ok", 80000),
  E("you", "new message", "ok", 50000), E("shell", "npm test", "run", 1000)] };
assert.ok(says().some((s) => s.endsWith("· 40s")), "the earlier turn lasted 40s, up to the next message");

// The conversation: your message, the agent's replies, long ones cut short; earlier turns titled by what you asked.
const T = (entry, text) => ({ ...entry, text });
view.board = { ...view.board, entries: [
  T(E("you", "new message", "ok", 90000), "Fix the login bug"), E("you", "answer ready", "ok", 85000),
  T(E("you", "new message", "ok", 50000), "Now add a test"),
  T(E("model", "x · step 1", "ok", 40000), "I'll look at the tests first. " + "word ".repeat(60)),
  E("files", "read a.test.ts", "ok", 30000), E("shell", "npm test", "run", 1000)] };
const talk = says();
assert.ok(talk.includes("Thinking") && !talk.includes("Now add a test"), "the agent's thinking shows; your own message does not");
assert.ok(talk.some((s) => s.startsWith("I'll look at the tests first.") && s.endsWith("…")), "a long reply is cut short");
assert.ok(talk.includes("Show more"), "and can be opened");
assert.ok(talk.some((s) => s.includes("Fix the login bug")), "the earlier turn is titled by what you asked");
assert.ok(talk.some((s) => s.startsWith("2 calls · 1 step")), "messages are not counted as calls");
// Movement: a call starts and ends, the agent moves to a new station. Flights launch, draw at every step, and clean up.
const pending = [];
const mcx = { ...cx, timer: { every() {}, after: (_ms, fn) => pending.push(fn) } };
const a = { ...view.board, route: [{ station: "files", at: n - 9000 }] };
const b2 = { ...a, entries: a.entries.concat(E("web", "gh", "err", 10)), route: [...a.route, { station: "web", at: n - 10 }] };
view.motion(mcx, a, b2);
assert.ok(view.flights.size >= 2, "packets out to the station and along the route");
for (let i = 0; pending.length && i < 100; i++) { pending.shift()(mcx); view.render(mcx); }
assert.equal(pending.length, 0, "every timer ran");
assert.equal(view.flights.size, 0, "every flight landed");
assert.equal(view.ripples.size, 0, "every ripple faded");
console.log("ok");
