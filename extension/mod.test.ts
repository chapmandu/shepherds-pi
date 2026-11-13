// Run: node --experimental-strip-types mod.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMod } from "./mod.ts";

const root = mkdtempSync(join(tmpdir(), "am-mod-"));
const src = join(root, "package", "mods", "shepherds-pi");
const dest = join(root, "herdr-app", "mods", "shepherds-pi");
mkdirSync(join(src, "icons"), { recursive: true });
writeFileSync(join(src, "main.js"), "v1");
writeFileSync(join(src, "icons", "pi.svg"), "<svg/>");

assert.equal(installMod(src, dest, "0.1.0"), "installed", "first start: copied in");
assert.equal(readFileSync(join(dest, "main.js"), "utf8"), "v1");
assert.ok(existsSync(join(dest, "icons", "pi.svg")), "with its icons");

writeFileSync(join(dest, "gpui-kit.d.ts"), "written by Herdr");
assert.equal(installMod(src, dest, "0.1.0"), "current", "same version: left alone");

writeFileSync(join(src, "main.js"), "v2");
assert.equal(installMod(src, dest, "0.2.0"), "installed", "new version: copied again");
assert.equal(readFileSync(join(dest, "main.js"), "utf8"), "v2");
assert.ok(existsSync(join(dest, "gpui-kit.d.ts")), "copied over the top: nothing deleted first");

const linked = join(root, "linked");
symlinkSync(src, linked);
assert.equal(installMod(src, linked, "0.3.0"), "skipped", "a folder already linked to the package is not copied onto itself");
assert.equal(installMod(join(root, "missing"), dest, "0.3.0"), "skipped", "no panel in the package: nothing to do");
console.log("ok");
