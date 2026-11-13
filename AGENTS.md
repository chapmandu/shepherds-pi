# AGENTS.md

Instructions for coding agents working on this repository. Read [README.md](README.md) first for what the project does.

## What this is

A pi package with two halves that talk through one file per terminal:

```
extension/        pi extension (TypeScript, loaded by pi through package.json "pi.extensions")
  index.ts          records the session, writes ~/.cache/shepherds-pi/<terminal>.json, adds /shepherds-pi
  classify.ts       sorts a tool call into a station and a short label; prose() cleans thinking text
  mod.ts            copies mods/shepherds-pi into the Herdr app, once per package version
mods/shepherds-pi/  Herdr app panel (plain JavaScript on gpui-kit, no build step)
  main.js           reads the file of the focused terminal and draws the map and the activity
  icons/            station icons: 16×16, stroke 1.5, round caps, currentColor
docs/             demo-board.mjs and demo-avatar.svg, for retaking preview.png
```

The file's shape is the `Board` type in `extension/index.ts`. Change both sides together, and keep the panel working with older files: a field may be missing.

## Commands

```sh
npm test                                                   # every test; run before you finish
herdr-app check ~/.config/herdr-app/mods/shepherds-pi        # Herdr's own check of the panel
./install.sh                                               # copy the panel into Herdr, link the extension into pi
```

- `npm test` runs the extension tests (sorting, clean-up, one writer, panel install) and `mods/shepherds-pi.test.mjs`, which draws the panel with a sample session. Keep that last one passing: `herdr-app check` draws once with no data and misses errors in loading and in later states.
- After editing the panel, run `./install.sh` and look at it in Herdr (`herdr-app shot <file.png>` saves the window). Herdr reloads the copied panel by itself.
- After editing the extension, restart pi. pi loads extensions only when it starts.
- Add a test with any new logic. When you fix a bug, check that the test fails without the fix.

## Rules that hold the design together

Privacy:
- Call labels hold names only: a command's name, the last two parts of a path, a host, a tool's name. Never arguments, output or file content.
- Text is only your message and the agent's thinking, through `prose()`: no code, at most 600 characters.
- The cache folder is `0700`, files `0600`. Recordings untouched for a day are deleted at pi's start (`prune`).
- Nothing leaves the machine.

The extension:
- Must never change, delay or break a call, a turn or a result. Wrap anything that can fail.
- Only the main session writes (`claim`). Subagents run as more sessions in the same pi process, with their own copy of the extension. A pi started by a command inherits `HC_TERMINAL_ID` and sees `SHEPHERDS_PI_PID`.
- Writes are merged per burst (`save`), and written at once at `agent_end` and `session_shutdown`. Print mode exits right after `agent_end`.
- Does nothing outside a Herdr terminal (`HC_TERMINAL_ID` unset).

The panel (see `~/.config/herdr-app/AGENTS.md` and the `.d.ts` files there for the full Herdr API):
- Animate with Herdr's native `.loop`, `.transition` and `.frames`, never with a timer that redraws. Each redraw redraws the whole window.
- Redraw only when something shown changed: `load()` answers whether it did.
- Fade, don't switch: keep an element drawn and change its opacity, so `.transition` has a start value. An element that first appears does not animate.
- One flight carries a whole train of packets; they lag by a transition delay.
- Build `PathBuilder` shapes once per map size (`shape()`), and colour them per draw.
- Never keep a `cx`; every callback gets its own. No `setTimeout`, no top-level `await`.

## Herdr quirks we hit

- A number passed to `line_height` is a multiple of the font size; pass `"17px"` for pixels.
- A scroll area has no height of its own in a column: give it `flex_1().min_h(0)` inside a sized parent, or set its height.
- Herdr does not reload a linked mod folder, and stops watching one that was deleted and made again. Copy files over the top.
- Herdr keeps a picture by its file name, so a new picture needs a new name (`.avatar-<size>-<date>.png`).
- Colours must be `#rrggbb` or `#rrggbbaa`; `alpha()` adds the last two.
- A route curve between opposite stations must bend round the centre; `bend()` keeps every curve 20px clear of the core.

## Station sorting

`classify()` in `extension/classify.ts` decides which station a call lights. When you add a rule, add a line to `classify.test.ts`, and update the station table in README.md.

## Releasing

- Raise `version` in `package.json` for every release: the extension re-copies the panel into Herdr when the version changes.
- `pi install git:github.com/chapmandu/shepherds-pi` installs from the default branch.
- To retake `preview.png`, follow the notes at the top of `docs/demo-board.mjs`. Never publish a screenshot of a real session: it shows your files, thinking and picture.

## Writing

Plain English for everything: replies, docs, comments, commit messages. Comments say why, in one line where possible. Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`…).
