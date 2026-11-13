// Shepherd's Pi: a live dashboard of what the pi agent in the focused terminal is doing.
// The pi extension (extension/ in this package) writes ~/.cache/shepherds-pi/<terminal>.json; this panel draws it.
// Calls send packets between the centre and their station; the activity shows the agent's thinking and calls by turn.
import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, appHome, exec, focused, home, panes, readTextFile, watchFolder, theme } from "herdr";

// Station, its name, and the theme colour it wears.
// Quiet lines use faint muted text, not the border colour: some themes have a light border on a dark ground.
const STATIONS = [
  ["you", "You", "ansi4"], ["model", "Model", "accent"], ["memory", "Memory", "ansi5"], ["files", "Files", "ansi6"],
  ["shell", "Shell", "ansi2"], ["web", "Network", "ansi3"], ["browser", "Browser", "ansi12"], ["agents", "Agents", "ansi13"],
  ["skills", "Skills", "ansi11"], ["hooks", "Hooks", "ansi9"],
];
const NAME = Object.fromEntries(STATIONS.map(([id, name]) => [id, name]));
const TONE = Object.fromEntries(STATIONS.map(([id, , tone]) => [id, tone]));
const ROUTE_MS = 60000; // a route leg stays 40 s, then fades over 20 s
const FLASH_MS = 2000;
const PULSE_PERIOD = 1200; // everything at work pulses on this one beat: nodes, the running icons, the Working dot (ms)
const PULSE_MS = 700; // a dot's flight along a spoke
const RIPPLE_MS = 650; // the ring that spreads where it lands
const LEG_MS = 600, LEG_STEPS = 6; // a dot along a curve of the route, in straight steps
const FLIGHTS = 14; // at most this many trains in the air
const PACKETS = 3, PACKET_GAP = 70; // a start or an end sends a short train of packets, this far apart (ms)
const LEG_GAP = 30; // packets on a curve sit closer, so each catches up within one straight step
const KEEP_TURNS = 6;

const dir = () => `${home()}/.cache/shepherds-pi`;
const fileOf = (term) => `${dir()}/${term.replace(/[^\w.-]/g, "_")}.json`;
const icon = (id) => `mods/shepherds-pi/icons/${id}.svg`;
const alpha = (c, a) => `${String(c).slice(0, 7)}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0")}`;
const secs = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s`
  : ms < 3600000 ? `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`
  : `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`);
const line = (x1, y1, x2, y2, w) => PathBuilder.stroke(w).move_to(x1, y1).line_to(x2, y2).build();
const clock = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
/**
 * The person's picture: their own `avatar.png` in this mod's folder, else the system's (~/.face, else the one
 * GNOME's account settings keep). A system picture is copied next to the mod, since pictures load from the app's
 * folder: hidden, so Herdr does not reload for it, and named after the picture's size and date, because Herdr keeps
 * a picture by its name and would show an old one under the same name.
 */
async function findAvatar() {
  try {
    const folder = `${appHome()}/mods/shepherds-pi`;
    if ((await exec("test", ["-r", `${folder}/avatar.png`])).code === 0) return "mods/shepherds-pi/avatar.png";
    const user = (await exec("id", ["-un"])).stdout.trim();
    for (const src of [`${home()}/.face`, `${home()}/.face.icon`, `/var/lib/AccountsService/icons/${user}`]) {
      if ((await exec("test", ["-r", src])).code !== 0) continue;
      const name = `.avatar-${(await exec("stat", ["-c", "%s-%Y", src])).stdout.trim()}.png`;
      // Drop copies of older pictures, then copy this one.
      await exec("sh", ["-c", 'for f in "$1"/.avatar*.png; do [ "$f" = "$1/$2" ] || rm -f "$f"; done', "_", folder, name]);
      if ((await exec("cp", [src, `${folder}/${name}`])).code === 0) return `mods/shepherds-pi/${name}`;
    }
  } catch {}
  return null; // no picture: the plain icon stays
}

/** How long the current turn has run, or the last one took. */
function turnTime(b, now) {
  const start = b.entries.findLast((e) => e.station === "you" && e.label === "new message")?.start;
  if (start == null) return null;
  const end = b.entries.findLast((e) => e.station === "you" && e.label !== "new message" && e.start >= start)?.end;
  return { value: secs((end ?? now) - start), live: !end };
}
const layer = (el) => el.absolute().top(0).left(0).size_full();

/** Splits the rows into turns: from your message to the answer. Model steps are counted, not listed. */
function turns(entries) {
  const list = [];
  let cur = null;
  const open = (e) => (cur = { id: e.id, start: e.start, end: null, stopped: false, steps: 0, rows: [], ask: e.text }, list.push(cur));
  for (const e of entries) {
    if (e.station === "you" && e.label === "new message") {
      // A turn with no recorded end stops where the next one starts, so its clock never runs on.
      if (cur && !cur.end) cur.end = e.start;
      open(e); continue;
    }
    if (!cur) open(e); // the start of the session's first kept turn was trimmed away
    if (e.station === "you" && (e.label === "answer ready" || e.label === "turn stopped")) {
      cur.end = e.end; cur.stopped = e.label === "turn stopped"; continue;
    }
    if (e.station === "model") {
      cur.steps++;
      if (e.status === "run") cur.thinking = e;
      if (e.text) cur.rows.push({ e, more: 0, start: e.start, say: true }); // the agent's thinking, between its calls
      continue;
    }
    if (e.station === "you" && e.label === "message while working") continue; // your words stay out of the timeline
    // Finished calls in a row at one station fold into one row.
    const last = cur.rows.at(-1);
    if (last && !last.say && e.status === "ok" && last.e.status === "ok" && last.e.station === e.station) { last.more++; last.e = e; last.start ??= last.e.start; }
    else cur.rows.push({ e, more: 0, start: e.start });
  }
  return list.slice(-KEEP_TURNS).reverse();
}

export default class ShepherdsPi extends View {
  init(_props, cx) {
    this.term = null;
    this.board = null;
    this.text = null;
    this.width = 380;
    this.height = 900;
    this.open = new Set(); // earlier turns the person expanded
    this.flights = new Map(); // dots in the air: from the centre, back to it, or along the route
    this.ripples = new Map();
    this.seq = 0;
    this.expanded = new Set(); // long messages the person opened in full
    this.avatar = null;
    cx.spawn(async (cx) => { this.avatar = await findAvatar(); if (this.avatar) cx.notify(); });
    this.reload(cx);
    cx.spawn(async (cx) => {
      try {
        // Any pi session writing wakes this; redraw only when the shown map changed.
        for (;;) { await watchFolder(dir()); if (await this.load(cx)) cx.notify(); }
      } catch {
        // No folder yet, or the watch failed: look once a second instead.
        cx.timer.every(1000, (cx) => this.reload(cx));
      }
    });
    // Clocks, flashes and the fading route change with time alone.
    cx.timer.every(1000, (cx) => { if (this.moving()) cx.notify(); });
  }

  reload(cx) { cx.spawn(async (cx) => { if (await this.load(cx)) cx.notify(); }); }

  /** Reads the focused terminal's map, or keeps the last one when it has none. Answers whether anything changed. */
  async load(cx) {
    const f = focused(), want = f?.terminal;
    // The focused terminal first, then the one shown last, then any terminal in this tab, then the pi that changed last.
    const tab = panes().filter((p) => p.tab === f?.tab && p.terminal).map((p) => p.terminal);
    const pis = agents().filter((a) => a.app === "pi").sort((x, y) => y.seq - x.seq).map((a) => a.address);
    for (const term of [want, this.term, ...tab, ...pis]) {
      if (!term || term.includes("/")) continue; // shortcut: this computer only; another machine's files are not read
      const text = await readTextFile(fileOf(term)).catch(() => null);
      if (text == null) continue;
      if (term === this.term && text === this.text) return false;
      const before = term === this.term ? this.board : null;
      try { this.board = JSON.parse(text); } catch { return false; } // half-written: the next change brings a whole one
      this.term = term; this.text = text;
      if (before) this.motion(cx, before, this.board); // a first look draws the map as it is, without replaying it
      return true;
    }
    if (this.term && this.board && want === this.term) { this.board = null; this.text = null; return true; }
    return false;
  }

  /** What changed since the last look, as movement: a dot out for each call that started, back for each that ended. */
  motion(cx, a, b) {
    const old = new Map(a.entries.map((e) => [e.id, e]));
    for (const e of b.entries) {
      if (e.station === "you") continue;
      const o = old.get(e.id), bad = e.status === "err" || e.status === "block";
      if (!o) {
        this.fly(cx, "out", e.station, false);
        if (e.status !== "run") this.fly(cx, "back", e.station, bad, PULSE_MS); // started and ended between two looks
      } else if (o.status === "run" && e.status !== "run") this.fly(cx, "back", e.station, bad);
    }
    // The agent moved on to another station: a train travels the new leg of the route.
    const was = a.route.at(-1), is = b.route.at(-1), prev = b.route.at(-2);
    if (is && prev && (!was || was.at !== is.at) && is.station !== was?.station) this.fly(cx, "leg", prev.station, false, 0, is.station);
  }

  /**
   * Sends a train of packets: "out" from the centre to a station, "back" from it, or "leg" from one station to another.
   * The whole train is one flight: its packets share each step and lag by a delay, so a train costs one redraw a step.
   */
  fly(cx, kind, station, bad, delay = 0, to = null) {
    const go = (cx) => {
      if (this.flights.size >= FLIGHTS) return;
      const leg = kind === "leg";
      const key = `f${++this.seq}`, steps = leg ? LEG_STEPS : 1, ms = leg ? LEG_MS / LEG_STEPS : PULSE_MS;
      const flight = { key, kind, station, to, bad, step: 0, steps, ms, gap: leg ? LEG_GAP : PACKET_GAP };
      this.flights.set(key, flight);
      cx.notify();
      // Drawn at its start first, then moved: the move is what animates.
      const next = (cx) => {
        flight.step++;
        cx.notify();
        if (flight.step < steps) cx.timer.after(ms, next);
        // Lands when its last packet does; the same redraw takes the train away and starts the ripple.
        else cx.timer.after(ms + flight.gap * (PACKETS - 1), (cx) => {
          this.flights.delete(key);
          this.ripple(cx, kind === "back" ? "core" : to ?? station, kind === "back" ? station : to ?? station, bad);
        });
      };
      cx.timer.after(40, next);
    };
    delay ? cx.timer.after(delay, go) : go(cx);
  }

  /** A ring that spreads from where a train lands. */
  ripple(cx, at, tone, bad) {
    const key = `r${++this.seq}`;
    const ring = { key, at, tone, bad, step: 0 };
    this.ripples.set(key, ring);
    cx.notify();
    cx.timer.after(40, (cx) => { ring.step = 1; cx.notify(); });
    // Faded by then: dropped quietly, the next redraw for any reason leaves it out.
    cx.timer.after(RIPPLE_MS + 80, () => this.ripples.delete(key));
  }

  moving() {
    const b = this.board, now = Date.now();
    if (!b) return false;
    return b.entries.some((e) => e.status === "run" || now - (e.end ?? 0) < FLASH_MS)
      // A route leg is still for 40 s and only changes while it fades, so there is nothing to redraw before that.
      || b.route.some((r) => now - r.at > 39000 && now - r.at < ROUTE_MS + 1000)
      || now - (b.doneAt ?? 0) < 3000 || now - (b.switchedAt ?? 0) < 4000;
  }

  render(cx) {
    const f = focused()?.terminal;
    if (f && f !== this.term && f !== this.asked) { this.asked = f; this.reload(cx); }
    const t = theme(), b = this.board, now = Date.now();
    const W = Math.max(240, this.width - 24); // card width inside the panel's padding
    // The map gives way so the activity keeps at least 220px: header, padding, now and gaps take about 150.
    const S = Math.max(180, Math.min(W, 400, this.height - 150 - 220));

    return v_flex().id("root").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1 || Math.abs(size.height - this.height) > 1) {
          this.width = size.width; this.height = size.height; cx.notify();
        }
      })
      .child(h_flex().h(42).flex_none().px(14).items_center().gap(8).border_b(1).border_color(t.border).text_size(13)
        .child(svg("mods/shepherds-pi/map.svg").size(15).text_color(t.accent))
        .child(div().font_semibold().child("Shepherd's Pi"))
        .when(!!this.term, (el) => el.child(div().text_size(11).text_color(t.dim).truncate()
          .child([this.term, b?.model?.replace(/^claude-/, "")].filter(Boolean).join(" · ")))))
      .child(!b
        ? v_flex().flex_1().items_center().justify_center().gap(10).p(24).text_color(t.dim)
          .child(svg("mods/shepherds-pi/map.svg").size(36).text_color(t.dim))
          .child(div().text_center().child("Nothing yet. Start pi in a Herdr terminal and focus it; its work shows here."))
        : v_flex().id("body").flex_1().min_h(0).p(12).gap(10)
          .child(this.now(t, b, now))
          .child(div().flex_none().py(4).child(this.map(t, b, S, now)))
          .child(this.activity(t, b, now)));
  }

  map(t, b, S, now) {
    const C = S / 2, R = S * 0.36, core = S * 0.1, node = 32;
    // Shapes are native and immutable: build each once per map size, colour it on every draw.
    if (this.shapesFor !== S) { this.shapesFor = S; this.shapes = new Map(); }
    const shape = (key, build) => {
      let path = this.shapes.get(key);
      if (!path) this.shapes.set(key, (path = build()));
      return path;
    };
    const circle = (x, y, r, w) => shape(`circle:${x}:${y}:${r}:${w}`, () =>
      PathBuilder.stroke(w).move_to(x, y - r).arc_to(r, r, 0, true, true, x, y + r).arc_to(r, r, 0, true, true, x, y - r).build());
    const pos = Object.fromEntries(STATIONS.map(([id], i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / STATIONS.length;
      return [id, [C + R * Math.cos(a), C + R * Math.sin(a)]];
    }));
    const tone = (id) => t[TONE[id]] ?? t.accent;
    const running = b.entries.filter((e) => e.status === "run");
    const top = Math.max(1, ...Object.values(b.counts));
    const total = Math.max(1, Object.values(b.counts).reduce((n, c) => n + c, 0));
    const err = t.ansi1;
    const kids = [];

    // Faint guide ring through the stations.
    kids.push(layer(window.paint_path(shape("guide", () => PathBuilder.stroke(1).dash_array([2, 5]).move_to(C, C - R)
      .arc_to(R, R, 0, true, true, C, C + R).arc_to(R, R, 0, true, true, C, C - R).build()), alpha(t.muted, 0.3))));

    // A spoke runs from just outside the context ring to the station's usage arc: never inside the PI circle or a node.
    const along = (id, from) => { const [x, y] = pos[id], d = Math.hypot(x - C, y - C) || 1, k = from(d) / d; return [C + (x - C) * k, C + (y - C) * k]; };
    const rim = (id) => along(id, () => core + 12);
    const spokeEnd = (id) => along(id, (d) => d - node / 2 - 4);

    // Spokes: a hairline for every station, and a coloured line as thick as the station is used.
    for (const [id] of STATIONS) {
      const share = (b.counts[id] ?? 0) / top, [ax, ay] = rim(id), [bx, by] = spokeEnd(id);
      kids.push(layer(window.paint_path(shape(`hair:${id}`, () => line(ax, ay, bx, by, 1)), alpha(t.muted, 0.22))));
      const w = Math.round((1 + share * 3) * 4) / 4; // quarter-pixel steps, so few widths are ever built
      if (share) kids.push(layer(window.paint_path(shape(`spoke:${id}:${w}`, () => line(ax, ay, bx, by, w)), alpha(tone(id), 0.2 + share * 0.45))));
    }

    // Paths between stations: curves inside the ring.
    const bend = (p, q) => {
      // The bend sits on the angle halfway between the two stations, so even opposite stations curve round the core.
      // The further apart they are, the further in it sits: close stations stay near the ring, clear of the labels.
      const a1 = Math.atan2(p[1] - C, p[0] - C), a2 = Math.atan2(q[1] - C, q[0] - C);
      let d = a2 - a1;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      const m = a1 + d / 2, far = Math.abs(d) / Math.PI; // 0 for neighbours, 1 for opposite stations
      // The curve comes closest to the centre at its middle, at (R·cos(d/2) + r) / 2. Keep that outside the core,
      // its context ring and a margin, whatever the map's size: r is at least 2·clear − R·cos(d/2).
      const clear = core + 20;
      const r = Math.max(R * (0.95 - 0.2 * far), 2 * clear - R * Math.cos(d / 2));
      return [C + r * Math.cos(m), C + r * Math.sin(m)];
    };
    const onLeg = (p, q, u) => { // a point on the curve, u from 0 to 1
      const [cx_, cy_] = bend(p, q), v = 1 - u;
      return [v * v * p[0] + 2 * v * u * cx_ + u * u * q[0], v * v * p[1] + 2 * v * u * cy_ + u * u * q[1]];
    };
    // Every path the agent used stays, faint; a fresh one shows bright and settles back to faint over a minute.
    const pair = (s1, s2) => [s1, s2].sort().join(">");
    const links = { ...b.links };
    for (let i = 1; i < b.route.length; i++) links[pair(b.route[i - 1].station, b.route[i].station)] ??= { n: 1, at: b.route[i].at }; // older maps
    const headKey = b.route.length > 1 ? pair(b.route.at(-2).station, b.route.at(-1).station) : null;
    for (const [key, { at }] of Object.entries(links)) {
      const [s1, s2] = key.split(">"), p = pos[s1], q = pos[s2];
      if (!p || !q) continue;
      const age = now - at, fresh = age < 40000 ? 1 : age < ROUTE_MS ? 1 - (age - 40000) / 20000 : 0;
      const head = key === headKey && fresh > 0, [qx, qy] = bend(p, q);
      const w = head ? 1.6 : 1.1;
      kids.push(layer(window.paint_path(shape(`link:${key}:${w}`, () => PathBuilder.stroke(w).move_to(p[0], p[1]).curve_to(q[0], q[1], qx, qy).build()),
        alpha(t.foreground, 0.1 + (head ? 0.4 : 0.2) * fresh))));
    }

    // Context window: a track and a filled arc around the centre.
    const r = core + 7, pct = Math.max(0, Math.min(99.9, b.context ?? 0));
    kids.push(layer(window.paint_path(circle(C, C, r, 4), t.raised)));
    if (pct > 0) {
      const a = -Math.PI / 2 + (pct / 100) * 2 * Math.PI;
      const ring = pct >= 90 ? err : pct >= 70 ? t.blocked : t.accent;
      kids.push(layer(window.paint_path(PathBuilder.stroke(4).move_to(C, C - r)
        .arc_to(r, r, 0, pct > 50, true, C + r * Math.cos(a), C + r * Math.sin(a)).build(), ring)));
    }


    // Flights: a dot with a short tail, out from the centre when a call starts, back when it ends.
    for (const f of this.flights.values()) {
      const c = f.bad ? err : tone(f.kind === "leg" ? f.to : f.station);
      let pts;
      if (f.kind === "leg") pts = Array.from({ length: f.steps + 1 }, (_, i) => onLeg(pos[f.station], pos[f.to], i / f.steps));
      else pts = f.kind === "out" ? [rim(f.station), spokeEnd(f.station)] : [spokeEnd(f.station), rim(f.station)];
      const [px, py] = pts[Math.min(f.step, pts.length - 1)];
      const easing = f.kind === "leg" ? "linear" : "ease-in-out";
      // The spoke glows while a dot flies along it.
      if (f.kind !== "leg") {
        const [ax, ay] = rim(f.station), [bx, by] = spokeEnd(f.station);
        kids.push(layer(window.paint_path(shape(`beam:${f.station}`, () => line(ax, ay, bx, by, 1.5)), alpha(c, 0.18))).id(`beam-${f.key}`)
          .opacity(f.step === 0 ? 1 : 0).transition("opacity", { duration: f.ms + 200, easing: "ease-in" }));
      }
      // The train: small packets, each a moment behind the one before.
      for (let j = 0; j < PACKETS; j++) {
        const h = 1.75, delay = j * f.gap;
        kids.push(div().id(`fly-${f.key}-${j}`).absolute().size(3.5).rounded_full().bg(alpha(c, 0.8 - j * 0.15))
          .left(px - h).top(py - h)
          .transition("left", { duration: f.ms, delay, easing })
          .transition("top", { duration: f.ms, delay, easing }));
      }
    }

    // Ripples: a ring spreads from where a dot landed and fades.
    for (const ring of this.ripples.values()) {
      const [x, y] = ring.at === "core" ? [C, C] : pos[ring.at];
      const c = ring.bad ? err : tone(ring.tone);
      const from = ring.at === "core" ? core * 2 + 8 : node + 2, to = from + 14, d = ring.step ? to : from; // a short, faint spread
      kids.push(div().id(`ripple-${ring.key}`).absolute().rounded_full().border_1().border_color(alpha(c, 0.6))
        .size(d).left(x - d / 2).top(y - d / 2).opacity(ring.step ? 0 : 0.5)
        .transition("width", RIPPLE_MS).transition("height", RIPPLE_MS)
        .transition("left", RIPPLE_MS).transition("top", RIPPLE_MS)
        .transition("opacity", { duration: RIPPLE_MS, easing: "ease-out" }));
    }

    // The answer is ready: one ring around the centre for a moment.
    if (now - (b.doneAt ?? 0) < 2500) {
      const d = core * 2 + 34;
      kids.push(div().id(`done-${b.doneAt}`).absolute().left(C - d / 2).top(C - d / 2).size(d).rounded_full()
        .border_2().border_color(t.done ?? t.accent).loop("opacity", { from: 0, to: 0.9, period: 1200 }));
    }

    // The centre.
    const switched = now - (b.switchedAt ?? 0) < 4000;
    kids.push(v_flex().absolute().left(C - core).top(C - core).size(core * 2).rounded_full().items_center().justify_center()
      .bg(t.raised).border_1().border_color(switched ? t.accent : t.border).shadow_md()
      .child(svg(icon("pi")).size(Math.round(core * 0.75)).text_color(t.foreground)) // pi's logo, in the theme's text colour
      .child(div().text_size(10).font_medium().text_color(pct >= 70 ? (pct >= 90 ? err : t.blocked) : t.dim)
        .child(b.context != null ? `${b.context}%` : "")));
    if (b.cost != null) kids.push(h_flex().absolute().w(120).left(C - 60).top(C + r + 8).justify_center()
      .child(div().px(7).py(2).rounded_full().bg(t.surface).border_1().border_color(t.border)
        .text_size(11.5).font_semibold().child(`$${b.cost.toFixed(2)}`)));
    const turn = turnTime(b, now);
    if (turn) kids.push(v_flex().absolute().top(0).right(0).items_end().gap(1)
      .child(div().text_size(13).font_semibold().text_color(turn.live ? t.foreground : t.muted).child(turn.value)));

    // The stations. Everything a station shows is always drawn and only its strength changes,
    // so every part of it fades in when it starts and out when it ends: nothing switches on or off.
    const shown = (el, visible, inMs = 400, outMs = 900) =>
      el.opacity(visible ? 1 : 0).transition("opacity", { duration: visible ? inMs : outMs, easing: "ease-out" });
    this.badges ??= {}; // the last ×N and error count, so a badge fading out keeps its number
    for (const [id, name] of STATIONS) {
      const [x, y] = pos[id], c = tone(id);
      const busy = running.filter((e) => e.station === id).length;
      const last = b.entries.findLast((e) => e.station === id);
      const since = last?.end ? now - last.end : Infinity; // how long ago its last call ended
      const on = busy > 0, fading = !on && since < 1000; // still fading out: keep moving and pulsing until gone
      const bad = since < FLASH_MS && (last.status === "err" || last.status === "block");
      const used = (b.counts[id] ?? 0) > 0;
      const faults = b.faults[id] ?? 0;
      const kept = (this.badges[id] ??= { busy: 2, faults: 1 });
      if (busy > 1) kept.busy = busy;
      if (faults) kept.faults = faults;
      const box = (el, size) => el.absolute().size(size).left(x - size / 2).top(y - size / 2);

      // Share of all the work: an arc round the node, from the top, clockwise, on a faint track.
      const share = Math.max(0.001, Math.min(0.999, (b.counts[id] ?? 0) / total));
      const ar = node / 2 + 4, a = -Math.PI / 2 + share * 2 * Math.PI;
      kids.push(shown(layer(window.paint_path(circle(x, y, ar, 1.5), alpha(c, 0.12))).id(`track-${id}`), used, 600));
      kids.push(shown(layer(window.paint_path(PathBuilder.stroke(2).move_to(x, y - ar)
        .arc_to(ar, ar, 0, share > 0.5, true, x + ar * Math.cos(a), y + ar * Math.sin(a)).build(), alpha(c, 0.9))).id(`arc-${id}`), used, 600));

      // Packets to and fro along its spoke while it works, each at its own pace.
      const [ax, ay] = rim(id), [bx, by] = spokeEnd(id);
      kids.push(shown(layer(div().id(`traffic-${id}`)), on).children(on || fading
        ? [[3, 0.55, 1150], [2.5, 0.4, 1550], [3, 0.3, 2050]].map(([size, op, period], j) => {
          const h = size / 2;
          return div().id(`traffic-${id}-${j}`).absolute().size(size).rounded_full().bg(alpha(c, op))
            .left(ax - h).top(ay - h)
            .loop("left", { from: ax - h, to: bx - h, period, easing: "linear" })
            .loop("top", { from: ay - h, to: by - h, period, easing: "linear" });
        })
        : []));

      // A soft glow round the node that brightens and dims while it works; nothing changes size.
      const g = node + 8;
      kids.push(shown(box(div().id(`glow-${id}`), g), on)
        .child(div().size(g).rounded_full().bg(alpha(c, 0.3))
          .when(on || fading, (d) => d.loop("opacity", { from: 0.15, to: 1, period: PULSE_PERIOD }))));

      // The node: a quiet grey one, with its own colours fading in over it once it has been used.
      const icon = (color) => this.glyph(id, id === "you" && this.avatar ? node - 4 : 15, color);
      kids.push(box(div().id(`node-${id}`), node).rounded_full().flex().items_center().justify_center()
        .bg(alpha(t.muted, 0.06)).border_1().border_color(alpha(t.muted, 0.3)).child(icon(t.dim)));
      kids.push(shown(box(div().id(`used-${id}`), node), used, 600).rounded_full().flex().items_center().justify_center()
        .bg(alpha(c, 0.12)).border_1().border_color(alpha(c, 0.45)).child(icon(alpha(c, 0.85))));
      // A bright ring while it works, and a red one for a moment after a call failed.
      kids.push(shown(box(div().id(`ring-${id}`), node), on).rounded_full().border_1().border_color(c));
      kids.push(shown(box(div().id(`err-${id}`), node), bad, 200, 900).rounded_full().border_1().border_color(err));

      // Badges: how many calls run at once, and how many failed since your last message.
      kids.push(shown(div().id(`count-${id}`).absolute().left(x + node / 2 - 6).top(y + node / 2 - 10), busy > 1)
        .px(4).rounded_full().bg(c).text_size(9).font_semibold().text_color(t.background).child(`×${kept.busy}`));
      kids.push(shown(div().id(`fault-${id}`).absolute().left(x + node / 2 - 8).top(y - node / 2 - 4), faults > 0)
        .min_w(15).h(15).px(3).rounded_full().flex().items_center().justify_center()
        .bg(err).text_size(9).font_semibold().text_color("#ffffff").child(String(kept.faults)));

      // The name, with a brighter copy fading in over it while it works; the count fades in once used.
      const label = (color, extra) => h_flex().absolute().w(110).left(x - 55)
        .top(y >= C - 1 ? y + node / 2 + 4 : y - node / 2 - 19).justify_center().gap(4)
        .child(div().text_size(11).font_medium().text_color(color).child(name))
        .child(extra(div().text_size(10).text_color(t.dim).child(String(b.counts[id] ?? 0))));
      kids.push(label(t.muted, (count) => shown(count.id(`n-${id}`), used, 600)).id(`label-${id}`));
      kids.push(shown(label(t.foreground, (count) => count.opacity(0)).id(`lit-${id}`), on || since < FLASH_MS));
    }

    return div().relative().flex_none().mx_auto().w(S).h(S).children(kids);
  }

  /** A station's icon; the person's own picture for You when the system has one. */
  glyph(id, size, color) {
    return id === "you" && this.avatar ? image(this.avatar).size(size).rounded_full() : svg(icon(id)).size(size).text_color(color);
  }

  /** The first thing to read: what the agent is doing this moment, or that it is waiting for you. */
  now(t, b, now) {
    const running = b.entries.filter((e) => e.status === "run");
    const calls = running.filter((e) => e.station !== "model");
    const focus = calls.at(-1) ?? running.at(-1);
    // The turn is over only once pi said so; a gap between steps is still work.
    const lastYou = b.entries.findLast((e) => e.station === "you" && e.label !== "question")?.label;
    const over = lastYou === "answer ready" || lastYou === "turn stopped";
    const stopped = !focus && lastYou === "turn stopped";
    const waiting = !focus && over && !stopped;
    const idle = !focus && lastYou === undefined; // a fresh session: no message yet
    const between = !focus && !over && !idle; // working, between one step and the next
    // Waiting for you is the moment to look: a bright colour that pulses until you answer.
    const tone = focus ? t[TONE[focus.station]] ?? t.accent : between ? t.accent : stopped ? t.ansi1 : idle ? t.muted : t.ansi11;
    const title = focus ? (focus.station === "model" ? "Thinking" : focus.label)
      : between ? "Working" : stopped ? "Stopped" : idle ? "Idle" : "Waiting for you";
    const sub = focus
      ? [NAME[focus.station], focus.station === "model" ? focus.label.split(" · ").pop() : "", calls.length > 1 ? `+${calls.length - 1} running` : ""]
        .filter(Boolean).join(" · ")
      : between ? "Between steps" : idle ? "Send pi a message to start" : b.doneAt ? `Answered at ${clock(b.doneAt)}` : "";
    return h_flex().id("now").relative().flex_none().gap(10).items_center().px(12).py(9).rounded(10).overflow_hidden()
      .bg(alpha(tone, focus ? 0.12 : waiting ? 0.1 : 0.07)).border_1().border_color(alpha(tone, focus ? 0.45 : waiting ? 0.9 : 0.4))
      .when(waiting, (el) => el.child(div().id("now-glow").absolute().top(0).left(0).size_full().bg(alpha(tone, 0.22))
        .loop("opacity", { from: 0, to: 1, period: 1400 })))
      .child(div().size(28).flex_none().rounded_full().flex().items_center().justify_center().bg(alpha(tone, waiting ? 0.3 : 0.2))
        .when(!stopped && !idle, (d) => d.loop("opacity", { from: 0.55, to: 1, period: waiting ? 1400 : PULSE_PERIOD }))
        .child(this.glyph(focus ? focus.station : between ? "model" : "you", focus || between ? 14 : 26, tone)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).font_semibold().text_color(waiting ? tone : t.foreground).child(title))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(sub)))
      .when(!!focus, (el) => el.child(div().flex_none().text_size(11).font_semibold().text_color(tone).child(secs(now - focus.start))));
  }


  activity(t, b, now) {
    const [latest, ...earlier] = turns(b.entries);
    if (!latest) return div().text_color(t.dim).child("No activity yet.");
    // Two parts, each scrolling on its own: the latest turn, and the turns before it.
    return v_flex().id("activity").flex_1().min_h(0).gap(8)
      .child(this.latest(t, latest, now))
      .when(earlier.length > 0, (el) => el.child(this.earlier(t, earlier, now)));
  }

  /** One line about a turn: its title, start time, failures, calls, steps and length. */
  head(t, turn, title, dot, now) {
    const calls = turn.rows.filter((r) => !r.say).reduce((n, r) => n + 1 + r.more, 0);
    const failed = turn.rows.filter((r) => r.e.status === "err" || r.e.status === "block").length;
    const summary = [`${calls} ${calls === 1 ? "call" : "calls"}`, `${turn.steps} ${turn.steps === 1 ? "step" : "steps"}`,
      secs((turn.end ?? now) - turn.start)].join(" · ");
    return h_flex().flex_none().items_center().gap(8).px(12).h(36)
      .child(dot)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(title))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(clock(turn.start)))
      .when(failed > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`${failed} failed`)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(summary));
  }

  rows(t, turn, live, now) {
    const rows = [...turn.rows].reverse();
    if (live && turn.thinking && !rows.some((r) => r.e.status === "run"))
      rows.unshift({ e: { ...turn.thinking, label: "Thinking" }, more: 0, start: turn.thinking.start });
    if (!rows.length) return [div().text_size(11.5).text_color(t.dim).child(live ? "Thinking…" : "Answered without tools.")];
    return rows.map((r, i) => this.row(t, r, i === rows.length - 1, now));
  }

  latest(t, turn, now) {
    const live = !turn.end;
    const dot = live ? div().size(7).rounded_full().bg(t.working).loop("opacity", { from: 0.3, to: 1, period: PULSE_PERIOD })
      : div().size(7).rounded_full().bg(turn.stopped ? t.ansi1 : t.done ?? t.accent);
    // Takes the space the earlier turns leave, and scrolls its rows inside it.
    return v_flex().flex_1().min_h(90).rounded(10).bg(t.surface).border_1()
      .border_color(live ? alpha(t.working, 0.5) : t.border)
      .child(this.head(t, turn, live ? "Working" : turn.stopped ? "Stopped" : "Last answer", dot, now))
      .child(v_flex().id("latest-rows").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(10)
        .children(this.rows(t, turn, live, now)));
  }

  earlier(t, list, now) {
    // A scroll area has no height of its own here, so count it from the rows: 36px a turn, 42px an open row.
    const open = list.filter((turn) => this.open.has(turn.id));
    const height = 32 + list.length * 36 + open.reduce((h, turn) => h + 8 + Math.max(1, turn.rows.length) * 42, 0);
    return v_flex().flex_none().h(Math.min(height, 260)).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().flex_none().px(12).h(30).items_center().border_b(1).border_color(t.border).text_size(11)
        .child(div().font_semibold().text_color(t.muted).child("Earlier"))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(`${list.length} ${list.length === 1 ? "turn" : "turns"}`)))
      .child(v_flex().id("earlier-rows").flex_1().min_h(0).overflow_y_scrollbar()
        .children(list.map((turn) => {
          const open = this.open.has(turn.id);
          const dot = div().size(7).rounded_full().bg(turn.stopped ? t.ansi1 : t.dim);
          return v_flex().flex_none()
            .child(div().id(`turn-${turn.id}`).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { open ? this.open.delete(turn.id) : this.open.add(turn.id); cx.notify(); })
              .child(this.head(t, turn, `${open ? "▾" : "▸"} ${turn.ask ?? (turn.stopped ? "Stopped" : "Answer")}`, dot, now)))
            .when(open, (el) => el.child(v_flex().px(12).pb(8).children(this.rows(t, turn, false, now))));
        })));
  }

  /** What the agent thought before a step: the words only, short until clicked. */
  say(t, e, last) {
    const long = e.text.length > 160;
    const full = this.expanded.has(e.id);
    const tone = t.accent;
    // Sized by its words; the rail line is drawn inside the row so the row never stretches to fill the card.
    return h_flex().id(`say-${e.id}`).relative().flex_none().gap(10).items_start().pb(12)
      .when(!last, (el) => el.child(div().absolute().left(10.5).top(22).bottom(0).w(1).bg(alpha(t.muted, 0.35))))
      .when(long, (el) => el.cursor_pointer().on_click((_e, cx) => {
        full ? this.expanded.delete(e.id) : this.expanded.add(e.id); cx.notify();
      }))
      .child(div().size(22).flex_none().rounded_full().flex().items_center().justify_center()
        .bg(alpha(tone, 0.12)).border_1().border_color(alpha(tone, 0.3))
        .child(svg(icon("model")).size(12).text_color(tone)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().h(22).items_center().gap(6).text_size(10.5).text_color(t.dim)
          .child(div().font_medium().text_color(t.muted).child("Thinking"))
          .child(clock(e.start)))
        .child(div().text_size(12).line_height("17px").italic().text_color(t.muted)
          .child(long && !full ? `${e.text.slice(0, 160).trimEnd()}…` : e.text))
        .when(long, (el) => el.child(div().pt(2).text_size(10.5).text_color(t.accent).child(full ? "Show less" : "Show more"))));
  }

  row(t, r, last, now) {
    if (r.say) return this.say(t, r.e, last);
    const { e, more, start } = r;
    const c = t[TONE[e.station]] ?? t.accent;
    const run = e.status === "run";
    const bad = e.status === "err" || e.status === "block";
    const tint = bad ? t.ansi1 : c;
    const took = run ? secs(now - start) : e.end - start >= 1000 ? secs(e.end - start) : "";
    const sub = [NAME[e.station], more ? `+${more} more` : "", e.status === "block" ? "blocked" : e.status === "err" ? "failed" : ""]
      .filter(Boolean).join(" · ");
    // A rail runs down the left, through each row's icon.
    const rail = v_flex().w(22).h(42).flex_none().items_center()
      .child(div().size(22).flex_none().rounded_full().flex().items_center().justify_center()
        .bg(alpha(tint, run ? 0.24 : 0.12)).border_1().border_color(alpha(tint, run ? 0.9 : 0.3))
        .when(run, (d) => d.loop("opacity", { from: 0.5, to: 1, period: PULSE_PERIOD }))
        .child(this.glyph(e.station, e.station === "you" ? 20 : 12, tint)))
      .when(!last, (el) => el.child(div().w(1).flex_1().bg(alpha(t.muted, 0.35))));
    return h_flex().h(42).gap(10).items_start()
      .child(rail)
      .child(v_flex().flex_1().min_w(0).pt(1).gap(1)
        .child(div().truncate().text_size(12).text_color(bad ? t.ansi1 : run ? t.foreground : t.muted)
          .when(run, (d) => d.font_medium()).child(e.label))
        .child(div().truncate().text_size(10.5).text_color(bad ? alpha(t.ansi1, 0.8) : t.dim).child(sub)))
      .child(div().pt(3).flex_none().text_size(10.5).text_color(run ? c : t.dim).child(took));
  }
}
