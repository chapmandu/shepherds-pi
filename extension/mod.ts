// Puts the Herdr panel (the package's mods/shepherds-pi) into the Herdr app, so one `pi install` sets up both halves.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Hidden, so Herdr does not reload the panel for it; records which version was copied. */
const MARKER = ".installed-version";

/**
 * Copies the panel from `src` to `dest` when it is missing or from another version.
 * Copies over the top and never deletes first: Herdr stops watching a mod folder that was removed.
 */
export function installMod(src: string, dest: string, version: string): "installed" | "current" | "skipped" {
	if (!existsSync(src)) return "skipped"; // the extension was loaded without the rest of the package
	if (existsSync(dest) && realpathSync(src) === realpathSync(dest)) return "skipped"; // the folder is linked here already
	const marker = join(dest, MARKER);
	if (existsSync(marker) && readFileSync(marker, "utf8").trim() === version) return "current";
	mkdirSync(dest, { recursive: true });
	cpSync(src, dest, { recursive: true, force: true });
	writeFileSync(marker, version);
	return "installed";
}
