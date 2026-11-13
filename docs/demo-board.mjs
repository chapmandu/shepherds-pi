// A fictional, busy session (shepherd's pies for the county fair, mutton from the butcher, a herd of sheep) for taking preview.png.
// Usage: node docs/demo-board.mjs ~/.cache/shepherds-pi/<terminal>.json 1   then the same with 2 to set packets moving.
// Put docs/demo-avatar.svg, as a PNG, at ~/.config/herdr-app/mods/shepherds-pi/avatar.png to show the pie as You.
import fs from "node:fs";
const [file, phase] = process.argv.slice(2);
const n = Date.now(); let i = 0;
const E = (station, label, status, ago, took = 400, text) => ({ id: "d" + i++, station, label, status, start: n - ago, ...(status === "run" ? {} : { end: n - ago + took }), ...(text ? { text } : {}) });
const entries = [
  E("you", "new message", "ok", 900000, 0, "Add Dolly and Shaun to the herd list"), E("model", "opus-5-5 · step 1", "ok", 898000, 3000),
  E("memory", "herd/notes.md", "ok", 890000), E("files", "edit herd/sheep.yaml", "ok", 880000), E("model", "opus-5-5 · step 2", "ok", 875000, 2000), E("you", "answer ready", "ok", 870000, 0),
  E("you", "new message", "ok", 600000, 0, "Why did the mutton gravy go lumpy on Tuesday?"), E("model", "opus-5-5 · step 1", "ok", 598000, 4000),
  E("files", "read logs/fridge.log", "ok", 590000), E("web", "weather.example", "ok", 585000, 1800), E("model", "opus-5-5 · step 2", "ok", 580000, 3000), E("you", "answer ready", "ok", 575000, 0),
  E("you", "new message", "ok", 400000, 0, "Rename every recipe file to kebab-case"), E("model", "opus-5-5 · step 1", "ok", 398000, 2000),
  E("shell", "git mv", "ok", 390000), E("files", "find recipes", "ok", 385000), E("model", "opus-5-5 · step 2", "ok", 380000, 2000), E("you", "answer ready", "ok", 378000, 0),
  E("you", "new message", "ok", 140000, 0, "Bake 24 shepherd's pies for the county fair, and check we have enough mutton"),
  E("model", "opus-5-5 · step 1", "ok", 138000, 5000, "Twenty-four shepherd's pies need about six kilos of mutton mince. Before scaling the recipe I'll check the kitchen notes and the butcher's last order to see what's in the cold store."),
  E("memory", "kitchen/mutton-stock.md", "ok", 131000), E("skills", "baking", "ok", 128000), E("files", "read recipes/shepherds-pie.md", "ok", 124000), E("files", "read topping/mash.ts", "ok", 122000),
  E("model", "opus-5-5 · step 2", "ok", 118000, 4000, "The recipe is written for one pie. I'll make the mutton and mash quantities scale with the order size, then run the tests so the fair order doesn't burn."),
  E("files", "edit topping/mash.ts", "ok", 110000), E("files", "edit recipes/shepherds-pie.md", "ok", 104000), E("shell", "npm test", "err", 96000, 6200),
  E("model", "opus-5-5 · step 3", "ok", 88000, 3000, "One test failed: the oven timer rounds 42.5 minutes down to 42. Fixing the rounding, then asking a helper to count the sheep while I order potatoes."),
  E("files", "edit oven/timer.ts", "ok", 80000), E("browser", "screenshot butcher.example", "ok", 70000, 2400),
  E("agents", "Count the sheep in the herd", "run", 52000), E("shell", "npm test", "run", 9000), E("files", "read kitchen/mutton-stock.csv", "run", 4000),
  E("model", "opus-5-5 · step 4", "ok", 3000, 2500, "The cold store has mutton for eighteen pies, not twenty-four. Dolly and Shaun are staying in the herd, so I'll ask the butcher for two more kilos and open a pull request for the bigger batch."),
];
const route = [{ station: "skills", at: n - 128000 }, { station: "files", at: n - 80000 }, { station: "browser", at: n - 70000 }, { station: "agents", at: n - 52000 }, { station: "shell", at: n - 9000 }, { station: "files", at: n - 4000 }];
const ago = (s) => ({ n: 3, at: n - s * 1000 });
const links = { "files>you": ago(140), "files>memory": ago(131), "memory>skills": ago(128), "files>skills": ago(124), "files>shell": ago(9), "browser>files": ago(70),
  "agents>browser": ago(52), "agents>shell": ago(30), "files>web": ago(585), "shell>you": ago(390), "memory>you": ago(890), "web>you": ago(575), "hooks>shell": ago(700) };
if (phase === "2") {
  entries.push(E("web", "gh pr create", "run", 10), E("memory", "kitchen/mutton-stock.md", "run", 10));
  route.push({ station: "web", at: n - 600 }, { station: "memory", at: n - 10 });
  links["files>web"] = ago(0.6); links["memory>web"] = ago(0);
}
const board = { model: "claude-opus-5-5", context: 62, cost: 3.14, entries,
  counts: { you: 9, model: 46, files: 38, shell: 27, web: 9, agents: 3, skills: 4, memory: 6, browser: 2, hooks: 1 },
  faults: { shell: 1 }, route, links, updatedAt: n };
fs.writeFileSync(file, JSON.stringify(board));
