// Run: node --experimental-strip-types classify.test.ts
import assert from "node:assert/strict";
import { classify, commandOf, prose } from "./classify.ts";

assert.equal(commandOf("cd x && sudo -E timeout 5 curl -s https://a").name, "curl");
assert.equal(classify("bash", { command: "FOO=1 git push origin main" }).station, "web");
assert.equal(classify("bash", { command: "git status" }).station, "shell");
assert.equal(classify("bash", { command: "rg foo | head" }).station, "files");
assert.equal(classify("bash", { command: "npm test" }).station, "shell");
assert.equal(classify("bash", { command: "npx -y cowsay" }).station, "web");
assert.equal(classify("read", { path: "/a/b/c/d.ts" }).label, "read c/d.ts");
assert.equal(classify("read", { path: "/x/skills/ponytail/SKILL.md" }).station, "skills");
assert.equal(classify("write", { path: "/x/memory/notes.md" }).station, "memory");
assert.equal(classify("Agent", { description: "find bugs" }).label, "find bugs");
assert.equal(classify("web_fetch", { url: "https://user:pw@example.com/a?q=1" }).label, "example.com");
assert.equal(classify("mcp__linear__list_issues", {}).station, "web");
assert.equal(classify("codemode", {}).station, "shell");
assert.equal(prose("## Done\n\nI fixed **the bug** in `map.ts`:\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n\n- see [docs](https://x.y)"),
  "Done I fixed the bug in map.ts: see docs");
assert.equal(prose("Writing:\n```ts\nunfinished"), "Writing:");
assert.equal(prose("a ".repeat(400)).length, 600);
console.log("ok");
