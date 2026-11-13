// Turns a tool call into a station on the map and a short label.
// Labels hold names only (a command name, the end of a path, a host), never content.

export type Station =
	| "you" | "model" | "memory" | "files" | "shell"
	| "web" | "browser" | "agents" | "skills" | "hooks";

const FILE_CMDS = new Set([
	"cat", "head", "tail", "less", "more", "grep", "rg", "ag", "find", "fd", "ls", "tree", "wc", "stat", "file",
	"mv", "cp", "rm", "mkdir", "rmdir", "touch", "ln", "chmod", "chown", "sed", "awk", "tee", "diff", "sort", "uniq", "cut", "du",
]);
const NET_CMDS = new Set(["curl", "wget", "gh", "ssh", "scp", "rsync", "sftp", "ftp", "nc", "http", "https", "ping", "dig", "nslookup"]);
const NET_SUBS: Record<string, Set<string>> = {
	git: new Set(["push", "pull", "fetch", "clone", "ls-remote"]),
	npm: new Set(["install", "i", "ci", "publish", "view", "update"]),
	pnpm: new Set(["install", "i", "add", "publish", "update"]),
	yarn: new Set(["install", "add", "publish"]),
	bun: new Set(["install", "add"]),
	pip: new Set(["install", "download"]),
	cargo: new Set(["install", "publish", "fetch"]),
	docker: new Set(["pull", "push", "login"]),
	podman: new Set(["pull", "push", "login"]),
	brew: new Set(["install", "update", "upgrade"]),
};
// Words that run the next word as the real command.
const WRAPPERS = new Set(["sudo", "env", "timeout", "nohup", "nice", "time", "xargs", "exec", "command", "doas"]);

const tail2 = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
const isMemoryPath = (p: string) => /(^|\/)(memory|memories)(\/|$)|MEMORY\.md$/i.test(p);
const isSkillPath = (p: string) => /(^|\/)SKILL\.md$/.test(p);

function host(url: unknown): string {
	try {
		return new URL(String(url)).host || "web";
	} catch {
		return "web";
	}
}

/**
 * The readable part of a message, for scanning: no code blocks, tables or markdown symbols,
 * whitespace folded, at most `max` characters.
 */
export function prose(text: string, max = 600): string {
	const out = text
		.replace(/```[\s\S]*?(```|$)/g, " ") // code blocks, closed or still open
		.split("\n")
		.filter((l) => !/^\s*\|/.test(l) && !/^\s{4,}\S/.test(l)) // table rows, indented code
		.map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, ""))
		.join(" ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images: keep the words
		.replace(/(\*\*|__|\*|_|`)(\S[^]*?)\1/g, "$2")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** The command a shell line runs first, read past `cd x &&`, env assignments and wrappers. */
export function commandOf(line: string): { name: string; sub?: string } {
	const first = line.split(/&&|\|\||;|\|/).map((s) => s.trim()).find((s) => s && !/^cd\s/.test(s)) ?? "";
	const words = first.split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
	while (words.length > 1 && WRAPPERS.has(words[0]!)) {
		words.shift();
		while (words.length > 1 && (words[0]!.startsWith("-") || /^\d+[smh]?$/.test(words[0]!))) words.shift();
	}
	const name = (words[0] ?? "").replace(/^["']|["']$/g, "").split("/").pop() ?? "";
	const sub = words.slice(1).find((w) => !w.startsWith("-"));
	return { name: name.toLowerCase(), sub };
}

export function classify(tool: string, args: any): { station: Station; label: string } {
	const a = args ?? {};
	const t = tool.toLowerCase();
	const path = String(a.path ?? a.file_path ?? a.file ?? "");

	if (["read", "write", "edit", "grep", "find", "ls", "glob"].includes(t)) {
		if (path && isSkillPath(path)) return { station: "skills", label: path.split("/").slice(-2, -1)[0] ?? "skill" };
		if (path && isMemoryPath(path)) return { station: "memory", label: tail2(path) };
		return { station: "files", label: path ? `${t} ${tail2(path)}` : t };
	}
	if (t === "bash" || t === "powershell") {
		const { name, sub } = commandOf(String(a.command ?? ""));
		const label = sub && NET_SUBS[name] ? `${name} ${sub}` : name || t;
		if (NET_CMDS.has(name) || (sub && NET_SUBS[name]?.has(sub)) || (name === "npx" && /\s-y\b/.test(String(a.command))))
			return { station: "web", label };
		if (FILE_CMDS.has(name)) return { station: "files", label };
		return { station: "shell", label };
	}
	if (t.includes("memory") || t.includes("recall")) return { station: "memory", label: tool };
	if (["agent", "subagentworkflow", "get_subagent_result", "steer_subagent", "subagent", "task"].includes(t))
		return { station: "agents", label: String(a.description ?? a.name ?? tool).slice(0, 48) };
	if (t.includes("skill") || t === "tool_search") return { station: "skills", label: String(a.skill ?? a.name ?? tool) };
	if (/browser|playwright|puppeteer|chrome|screenshot/.test(t)) return { station: "browser", label: tool };
	if (/fetch|search|web|http/.test(t)) return { station: "web", label: a.url ? host(a.url) : tool };
	if (t.startsWith("mcp__") || t.includes("__")) return { station: "web", label: tool.split("__").slice(1).join(" ") || tool };
	if (t === "ask_user_question" || t === "question") return { station: "you", label: "question" };
	return { station: "shell", label: tool };
}
