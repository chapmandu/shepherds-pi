// Shepherd's Pi, pi side: keeps a small picture of what this pi session is doing
// and writes it to ~/.cache/shepherds-pi/<terminal>.json for the Herdr "shepherds-pi" mod to draw.
// Only runs inside a Herdr terminal (HC_TERMINAL_ID is set). Never changes a call or a turn.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, prose, type Station } from "./classify.ts";
import { installMod } from "./mod.ts";

type Status = "run" | "ok" | "err" | "block";
/** `text`: your message, or the agent's thinking for a step: prose only, no code. */
type Entry = { id: string; station: Station; label: string; status: Status; start: number; end?: number; text?: string };
type Board = {
	model?: string;
	context?: number;
	/** Session cost in dollars, summed as pi's footer sums it. */
	cost?: number;
	entries: Entry[];
	counts: Partial<Record<Station, number>>;
	faults: Partial<Record<Station, number>>;
	route: { station: Station; at: number }[];
	/** Every pair of stations the agent moved between this session, as "a>b" in name order, with how often and when last. */
	links: Record<string, { n: number; at: number }>;
	doneAt?: number;
	switchedAt?: number;
};

const KEEP = 60;
const terminal = process.env.HC_TERMINAL_ID;
const dir = join(homedir(), ".cache", "shepherds-pi");
const file = terminal ? join(dir, `${terminal.replace(/[^\w.-]/g, "_")}.json`) : "";

const shortModel = (id?: string) => (id ?? "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 60);

/** Recordings older than this are deleted: they hold what was said, and nothing needs them after a day. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes recordings in `folder` untouched for `maxAge`, and leftover temporary files, except `keep`.
 * A session still running loses nothing: it holds its map in memory and writes it again on its next event.
 */
export function prune(folder: string, keep: string, maxAge = MAX_AGE_MS, now = Date.now()): void {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return; // no folder yet
	}
	for (const name of names) {
		if (!/^[\w.-]+\.json(\.tmp)?$/.test(name)) continue; // only our own files
		const path = join(folder, name);
		if (path === keep) continue;
		try {
			if (now - statSync(path).mtimeMs > maxAge) rmSync(path, { force: true });
		} catch {}
	}
}

/** The package this extension came in: it carries the Herdr panel beside it. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const herdrApp = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");

/** Puts the panel into the Herdr app, when there is one, the first time and after each update of the package. */
function setUpPanel(): void {
	try {
		if (!existsSync(herdrApp)) return; // Herdr's terminal without its app: no panel to draw on
		const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "dev";
		installMod(join(root, "mods", "shepherds-pi"), join(herdrApp, "mods", "shepherds-pi"), version);
	} catch {} // a read-only or sandboxed folder: the panel can still be installed by hand (install.sh)
}

/** Marks, across every session in this process, which copy of the extension writes the terminal's map. */
const OWNER = Symbol.for("shepherds-pi.owner");

export default function (pi: ExtensionAPI) {
	if (!terminal) return;

	pi.registerCommand("shepherds-pi", {
		description: "Open Shepherd's Pi beside this chat",
		handler: async (_args, ctx) => {
			setUpPanel();
			// Splits the pane you typed in, so the map opens beside this chat.
			const failed = await new Promise<string | null>((done) =>
				execFile("herdr-app", ["do", "pane.split", "--direction", "right", "--mod", "shepherds-pi"], { timeout: 10_000 },
					(err, _out, errOut) => done(err ? (String(errOut).trim() || err.message) : null)));
			if (failed) ctx.ui.notify(`Could not open Shepherd's Pi: ${failed}. Is the Herdr app running?`, "error");
		},
	});

	// One writer per terminal: the main session. Subagents and workflow agents run as more sessions in this
	// process, each with its own copy of this extension; a pi started from a command inherits the terminal id.
	// Without this, each would overwrite the map with its own, and the panel would flip between them.
	const me = {};
	const global = globalThis as { [OWNER]?: object };
	let own = false;
	const claim = () => {
		const parent = process.env.SHEPHERDS_PI_PID;
		if (parent && parent !== String(process.pid)) return false; // a pi started by another pi in this terminal
		global[OWNER] ??= me;
		if (global[OWNER] !== me) return false; // a subagent beside the main session
		process.env.SHEPHERDS_PI_PID = String(process.pid); // inherited by any process this pi starts
		return true;
	};

	const fresh = (model?: string): Board => ({ entries: [], counts: {}, faults: {}, route: [], links: {}, model });
	let board = fresh();
	let n = 0;
	let step = 0;
	// The open model step and compaction, each under an id of its own, so an unfinished one can never be mistaken for the next.
	let stepId: string | undefined;
	let compactId: string | undefined;

	// Whatever goes wrong here must never reach the agent.
	let queued = false;
	const write = () => {
		queued = false;
		if (!own) return;
		try {
			// Your user only: the file holds what you and the agent said.
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			writeFileSync(`${file}.tmp`, JSON.stringify({ ...board, updatedAt: Date.now() }), { mode: 0o600 });
			renameSync(`${file}.tmp`, file);
		} catch {}
	};
	// Events that come together (parallel calls start and end in bursts) make one write, just after them.
	const save = () => {
		if (!own || queued) return;
		queued = true;
		setImmediate(() => queued && write());
	};

	const begin = (station: Station, label: string, status: Status = "run", extra?: Partial<Entry>) => {
		const now = Date.now(), id = extra?.id ?? `e${++n}`;
		const entry: Entry = { ...extra, id, station, label: clean(label), status, start: now, ...(status === "run" ? {} : { end: now }) };
		// Keep the newest rows, and every row still running however old.
		const all = [...board.entries, entry];
		board.entries = all.filter((e, i) => i >= all.length - KEEP || e.status === "run");
		board.counts[station] = (board.counts[station] ?? 0) + 1;
		if (station !== "model") {
			const last = board.route.at(-1);
			if (last?.station === station) last.at = now;
			else {
				board.route = [...board.route, { station, at: now }].slice(-6);
				if (last) {
					const key = [last.station, station].sort().join(">");
					board.links[key] = { n: (board.links[key]?.n ?? 0) + 1, at: now };
				}
			}
		}
		// A stopped turn lands on the person's own station and is no fault of anything.
		if ((status === "err" || status === "block") && station !== "you") board.faults[station] = (board.faults[station] ?? 0) + 1;
		save();
		return id;
	};

	/** Closes a running row; answers it, so the caller can add to it before the next save. */
	const finish = (id: string | undefined, status: Status, extra?: Partial<Entry>) => {
		const e = board.entries.find((x) => x.id === id && x.status === "run");
		if (!e) return;
		Object.assign(e, { status, end: Date.now() }, extra);
		if (status === "err" || status === "block") board.faults[e.station] = (board.faults[e.station] ?? 0) + 1;
		save();
	};

	// The same sum as pi's footer: every usage the session recorded, compaction and summaries included.
	const countCost = (ctx: ExtensionContext) => {
		let cost = 0;
		for (const e of ctx.sessionManager.getEntries() as any[]) {
			const u = e.type === "usage" || e.type === "branch_summary" || e.type === "compaction" ? e.usage
				: e.type === "message" && (e.message.role === "assistant" || e.message.role === "toolResult") ? e.message.usage
				: undefined;
			cost += u?.cost?.total ?? 0;
		}
		board.cost = cost;
	};

	const closeAll = () => {
		const now = Date.now();
		for (const e of board.entries) if (e.status === "run") Object.assign(e, { status: "ok", end: now });
	};

	pi.on("session_shutdown", () => {
		// Hand the file on: a reload or a new session claims it again.
		if (queued) write(); // nothing waiting is lost
		if (global[OWNER] === me) delete global[OWNER];
		own = false;
	});

	pi.on("session_start", (_e, ctx) => {
		own = claim();
		if (!own) return;
		prune(dir, file);
		setUpPanel();
		board = fresh(ctx.model?.id);
		stepId = compactId = undefined;
		countCost(ctx);
		save();
	});

	pi.on("input", (e) => {
		if (e.source === "extension") return;
		const text = prose(e.text);
		const said = text ? { text } : undefined;
		// A message sent while pi works joins the turn under way; it starts no turn of its own.
		if (e.streamingBehavior) return void begin("you", "message while working", "ok", said);
		board.faults = {};
		step = 0;
		begin("you", "new message", "ok", said);
	});

	pi.on("model_select", (e) => {
		const before = shortModel(e.previousModel?.id);
		board.model = e.model.id;
		if (before && before !== shortModel(e.model.id)) {
			board.switchedAt = Date.now();
			begin("model", `${before} → ${shortModel(e.model.id)}`, "ok");
		}
	});

	pi.on("message_start", (e) => {
		if (e.message.role !== "assistant") return;
		finish(stepId, "ok"); // a step that never reported its end
		stepId = begin("model", `${shortModel(board.model)} · step ${++step}`);
	});

	pi.on("message_end", (e, ctx) => {
		// The cost grows by each reply and tool result as it comes; the full sum is taken again when a turn ends.
		const message = e.message as any;
		if (message.role === "assistant" || message.role === "toolResult") board.cost = (board.cost ?? 0) + (message.usage?.cost?.total ?? 0);
		if (message.role !== "assistant") return;
		const percent = ctx.getContextUsage()?.percent;
		if (typeof percent === "number") board.context = Math.round(percent);
		// The agent's thinking, not its reply: the reply is already in the chat beside the panel.
		const content = (e.message as any).content;
		const thought = prose(Array.isArray(content)
			? content.filter((c: any) => c?.type === "thinking" && !c.redacted).map((c: any) => c.thinking).join("\n")
			: "");
		finish(stepId, (e.message as any).stopReason === "error" ? "err" : "ok", thought ? { text: thought } : undefined);
		stepId = undefined;
	});

	pi.on("tool_execution_start", (e) => {
		const { station, label } = classify(e.toolName, e.args);
		begin(station, label, "run", { id: e.toolCallId });
	});

	pi.on("tool_execution_end", (e) => {
		// shortcut: a refusal from another extension is spotted by its wording; good enough until pi reports blocks as such.
		// Only a failed call is read, and only its first words: a result can be a whole file.
		const content = e.isError ? e.result?.content : undefined;
		const text = Array.isArray(content) ? String(content[0]?.text ?? "").slice(0, 200) : String(content ?? "").slice(0, 200);
		const blocked = e.isError && /\bblock(ed)?\b|not approved|denied/i.test(text);
		finish(e.toolCallId, blocked ? "block" : e.isError ? "err" : "ok");
		if (blocked) begin("hooks", `stopped ${e.toolName}`, "block");
	});

	pi.on("session_before_compact", () => {
		compactId = begin("model", "compacting");
	});
	pi.on("session_compact", (_e, ctx) => {
		countCost(ctx);
		finish(compactId, "ok");
		compactId = undefined;
	});

	pi.on("agent_end", (e, ctx) => {
		closeAll();
		countCost(ctx); // the exact sum, as pi's footer has it
		const last = e.messages.at(-1) as any;
		const aborted = last?.stopReason === "aborted";
		board.doneAt = aborted ? undefined : Date.now();
		begin("you", aborted ? "turn stopped" : "answer ready", aborted ? "err" : "ok");
		write(); // at once: in print mode pi may exit right after this
	});
}
