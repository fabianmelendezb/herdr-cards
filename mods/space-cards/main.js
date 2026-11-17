// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";
import { organize, createGroup, renameGroup, deleteGroup, setGroupHidden, moveToGroup, setSpaceHidden } from "./organize.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const COLOR_CHOICES = ["ansi6", "ansi4", "ansi5", "ansi1", "ansi3", "#d9b23f", "ansi2", "#8a919c"];

function spaceFill(t, spaceId) {
  const color = (shared("space.colors") ?? {})[spaceId] ?? "ansi6";
  return color.startsWith("#") ? color : (MARK[color] ?? t[color]);
}

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const EYE = "mods/space-cards/eye.svg";
const EYE_OFF = "mods/space-cards/eye-off.svg";

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// The most urgent of some statuses that ask for the person: blocked, then done.
const urgentOf = (statuses) => (statuses.includes("blocked") ? "blocked" : statuses.includes("done") ? "done" : null);

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.menu || props()?.ask) return this.initOverlay(cx);
    this.groupOf = {}; // space id -> its group id (own or its repo space's), null: none
    this.groupFolded = new Set(JSON.parse(localStorage.getItem("groups.folded") ?? "[]"));
    this.showHidden = JSON.parse(localStorage.getItem("hidden.open") ?? "false");
    this.overGroup = null; // the group header a dragged space is over
    this.hoveredSpace = null;
    this.hoveredGroup = null;
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "space-cards", kind: "popup", width: 270, height: 460, props: { menu: { kind: "space", id: w.id } } });
  }

  groupMenu(group) {
    openOverlay({ mod: "space-cards", kind: "popup", width: 220, height: 200, props: { menu: { kind: "group", id: group.id } } });
  }

  // ---- Overlays: the space and group menu, and the group name prompt ----

  initOverlay(cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    const overlayProps = props();
    if (overlayProps.ask) {
      this.text = overlayProps.ask.value ?? "";
      this.input = InputState.new({ value: this.text });
      if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
      this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
      this.input.on("submit", () => this.submitAsk());
      this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
      this.inputFocused = true;
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
      return;
    }
    this.handle.focus();
    const space = overlayProps.menu.kind === "space" && spaces().find((s) => s.id === overlayProps.menu.id);
    const folder = space && place(space, panes());
    if (folder) cx.spawn(async (cx) => {
      this.git = await checkout(folder, space.machine).catch(() => null);
      cx.notify();
    });
  }

  ask(title, value, request) {
    openOverlay({ mod: "space-cards", kind: "dialog", width: 380, height: 200, props: { ask: { title, value, ...request } } });
  }

  submitAsk() {
    const request = props().ask;
    closeOverlay(props().overlay);
    if (request.action === "newGroup") createGroup(this.text, request.spaceId ?? null);
    else if (request.action === "renameGroup") renameGroup(request.id, this.text);
  }

  menuItems() {
    const target = props().menu;
    const state = organize();
    if (target.kind === "group") {
      const group = state.groups.find((g) => g.id === target.id);
      if (!group) return [];
      return [
        { label: "Rename group", icon: ICON("square-pen"), act: () => this.ask("Rename group", group.name, { action: "renameGroup", id: group.id }) },
        { label: group.hidden ? "Show group" : "Hide group", icon: group.hidden ? EYE : EYE_OFF, act: () => setGroupHidden(group.id, !group.hidden) },
        { label: "New group", icon: ICON("folder-plus"), act: () => this.ask("New group", "", { action: "newGroup" }) },
        { label: "Delete group", hint: "spaces stay", icon: ICON("x"), separator: true, act: () => deleteGroup(group.id) },
      ];
    }
    const id = target.id;
    const current = state.groups.find((g) => g.id === state.member[id]);
    const hidden = state.hidden.includes(id);
    const worktree = (label, action, size) => ({
      label, icon: ICON("git-branch"),
      act: () => openOverlay({ mod: "worktree", kind: "dialog", ...size, props: { space: id, action } }),
    });
    const groupItems = [
      ...state.groups.filter((g) => g.id !== current?.id).map((g) => ({ label: `Move to ${g.name}`, icon: ICON("layers"), act: () => moveToGroup(id, g.id) })),
      { label: "New group with this space", icon: ICON("folder-plus"), act: () => this.ask("New group", "", { action: "newGroup", spaceId: id }) },
      ...(current ? [{ label: `Remove from ${current.name}`, icon: ICON("minus"), act: () => moveToGroup(id, null) }] : []),
    ];
    groupItems[0].separator = true;
    return [
      { label: "Rename", icon: ICON("square-pen"), act: () => run("space.rename", { id }) },
      ...(this.git ? [worktree("New worktree", "new", { width: 440, height: 260 }), worktree("Open worktree", "open", { width: 560, height: 480 })] : []),
      ...(this.git === "linked" ? [worktree("Remove worktree", "remove", { width: 440, height: 260 })] : []),
      ...groupItems,
      { label: hidden ? "Show space" : "Hide space", icon: hidden ? EYE : EYE_OFF, separator: true, act: () => setSpaceHidden(id, !hidden) },
      { label: "Close", icon: ICON("x"), separator: true, act: () => run("space.close", { id }) },
    ];
  }

  choose(index) {
    const item = this.menuItems()[index];
    if (!item) return;
    closeOverlay(props().overlay);
    item.act();
  }

  // A row of color dots at the top of the space menu. The six palette colors
  // are names the theme also knows; the extra two are plain hex colors.
  colorRow(t, spaceId) {
    const colors = shared("space.colors") ?? {};
    const current = colors[spaceId] ?? "ansi6";
    const pick = (choice) => {
      closeOverlay(props().overlay);
      setShared("space.colors", { ...(shared("space.colors") ?? {}), [spaceId]: choice });
    };
    return h_flex().h(34).px(8).gap(5).items_center()
      .child(div().flex_1().text_size(12).text_color(t.muted).child("Color"))
      .children(COLOR_CHOICES.map((choice) => {
        const fill = choice.startsWith("#") ? choice : (MARK[choice] ?? t[choice]);
        const chosen = choice === current;
        return div().id(`color-${choice}`).size(20).flex_none().rounded_full().p(2)
          .border_2().border_color(chosen ? fill : t.popover)
          .hover((s) => s.border_color(fill))
          .on_click(() => pick(choice))
          .child(div().size_full().rounded_full().bg(fill));
      }));
  }

  menuView(t) {
    const list = this.menuItems();
    return v_flex()
      .id("space-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (!list.length) return;
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .when(props().menu.kind === "space", (el) => el.child(this.colorRow(t, props().menu.id)))
      .children(list.map((item, index) => v_flex()
        .when(index > 0 && Boolean(item.separator), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex()
          .id(`smi-${index}`)
          .h(31)
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .text_color(t.foreground)
          .when(index === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.choose(index))
          .child(svg(item.icon).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().child(item.label))
          .when(Boolean(item.hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(item.hint))))));
  }

  askView(t) {
    const request = props().ask;
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("space-ask").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(request.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("ask-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("ask-save", "Save", true, () => this.submitAsk())));
  }

  // ---- The list: groups, hidden spaces ----

  iconButton(id, icon, tip, action, t) {
    return div().id(id).flex_none().p(3).rounded(5).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.pressed = null;
        this.over = null;
        this.overGroup = null;
        action();
        cx.notify();
      })
      .child(svg(icon).size(13));
  }

  // Rows split into: ungrouped, each shown group (header, then its spaces),
  // and a folded Hidden section. A hidden space that is the current one stays
  // in its place, dimmed, so where you are never disappears.
  sections(rows, t, collapsed, machine) {
    const state = organize();
    const groupsById = new Map(state.groups.map((g) => [g.id, g]));
    const hiddenIds = new Set(state.hidden);
    const facts = new Map();
    let repoFacts = null;
    for (const r of rows) {
      const own = groupsById.has(state.member[r.w.id]) ? state.member[r.w.id] : null;
      const group = own ?? (r.tree ? repoFacts?.group ?? null : null);
      const hidden = hiddenIds.has(r.w.id) || Boolean(r.tree && repoFacts?.hidden) || Boolean(group && groupsById.get(group).hidden);
      const fact = { group, hidden };
      facts.set(r.w.id, fact);
      this.groupOf[r.w.id] = group;
      if (hidden) this.hiddenNow?.add(r.w.id);
      if (!r.tree) repoFacts = fact;
    }
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row({ ...r, dim: facts.get(r.w.id).hidden }, t));
    const visible = rows.filter((r) => !facts.get(r.w.id).hidden || r.w.active);
    if (collapsed) return visible.map(draw);

    const out = visible.filter((r) => !facts.get(r.w.id).group).map(draw);
    for (const group of state.groups) {
      if (group.hidden) continue;
      const members = visible.filter((r) => facts.get(r.w.id).group === group.id);
      // Empty groups show on this computer only, so there's somewhere to drag into.
      if (!members.length && machine !== null) continue;
      out.push(this.groupHeader(group, members, t, machine));
      if (this.groupFolded.has(group.id)) continue;
      if (members.length) out.push(...members.map(draw));
      else out.push(div().flex_none().px(12).py(4).text_size(11.5).text_color(t.dim).child("Drag spaces here, or right-click one."));
    }

    const hiddenGroups = state.groups.filter((g) => g.hidden && (machine === null || rows.some((r) => facts.get(r.w.id).group === g.id)));
    const inHiddenGroup = (r) => Boolean(facts.get(r.w.id).group && groupsById.get(facts.get(r.w.id).group).hidden);
    const hiddenRows = rows.filter((r) => facts.get(r.w.id).hidden && !r.w.active && !inHiddenGroup(r));
    if (!hiddenGroups.length && !hiddenRows.length) return out;
    const allHidden = rows.filter((r) => facts.get(r.w.id).hidden);
    out.push(this.hiddenHeader(hiddenGroups.length + hiddenRows.length, urgentOf(allHidden.map((r) => r.w.status)), t, machine));
    if (!this.showHidden) return out;
    for (const group of hiddenGroups) {
      const members = rows.filter((r) => facts.get(r.w.id).group === group.id);
      out.push(this.hiddenGroupRow(group, members, t, machine));
    }
    out.push(...hiddenRows.map(draw));
    return out;
  }

  groupHeader(group, members, t, machine) {
    const key = `${machine ?? "local"}-${group.id}`;
    const folded = this.groupFolded.has(group.id);
    const dropping = this.pressed !== null && this.overGroup === group.id;
    const urgent = urgentOf(members.map((r) => r.w.status));
    return h_flex()
      .id(`group-${key}`)
      .h(28)
      .mt(6)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .border(1)
      .border_color(dropping ? t.accent : t.chrome)
      .when(dropping, (el) => el.bg(t.accent + "1a"))
      .text_size(11.5)
      .font_medium()
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_hover((on, cx) => {
        if (on) this.hoveredGroup = key;
        else if (this.hoveredGroup === key) this.hoveredGroup = null;
        cx.notify();
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressed !== null && this.overGroup !== group.id) {
          this.overGroup = group.id;
          this.over = null;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressed !== null) {
          if (this.overGroup === group.id) moveToGroup(this.pressed, group.id);
        } else {
          folded ? this.groupFolded.delete(group.id) : this.groupFolded.add(group.id);
          localStorage.setItem("groups.folded", JSON.stringify([...this.groupFolded]));
        }
        this.pressed = null;
        this.over = null;
        this.overGroup = null;
        cx.notify();
      })
      .on_mouse_down("right", () => this.groupMenu(group))
      .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11).flex_none().text_color(t.dim))
      .child(svg(ICON("layers")).size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(group.name))
      .when(folded && Boolean(urgent), (el) => el.child(div().flex_none().text_color(tone(t, urgent)).child("\u25cf")))
      .when(this.hoveredGroup === key, (el) => el.child(this.iconButton(`group-hide-${key}`, EYE_OFF, "Hide group", () => setGroupHidden(group.id, true), t)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(members.length)));
  }

  hiddenHeader(count, urgent, t, machine) {
    return h_flex()
      .id(`hidden-${machine ?? "local"}`)
      .h(28)
      .mt(8)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .text_size(11.5)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        this.showHidden = !this.showHidden;
        localStorage.setItem("hidden.open", JSON.stringify(this.showHidden));
        cx.notify();
      })
      .child(svg(ICON(this.showHidden ? "chevron-down" : "chevron-right")).size(11).flex_none())
      .child(svg(EYE_OFF).size(13).flex_none())
      .child(div().flex_1().child("Hidden"))
      .when(Boolean(urgent), (el) => el.child(div().flex_none().text_color(tone(t, urgent)).child("\u25cf")))
      .child(div().flex_none().text_size(11).child(String(count)));
  }

  hiddenGroupRow(group, members, t, machine) {
    const key = `${machine ?? "local"}-${group.id}`;
    const urgent = urgentOf(members.map((r) => r.w.status));
    return h_flex()
      .id(`hidden-group-${key}`)
      .h(32)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(8)
      .border(1)
      .border_color(t.border)
      .opacity(0.6)
      .text_size(12)
      .text_color(t.muted)
      .on_mouse_down("right", () => this.groupMenu(group))
      .child(svg(ICON("layers")).size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(group.name))
      .when(Boolean(urgent), (el) => el.child(div().flex_none().text_color(tone(t, urgent)).child("\u25cf")))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${members.length} space${members.length === 1 ? "" : "s"}`))
      .child(this.iconButton(`group-show-${key}`, EYE, "Show group", () => setGroupHidden(group.id, false), t));
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : this.sections(rows, t, collapsed, null);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      return [cell(head), ...(folded ? [] : mine.length ? this.sections(mine, t, collapsed, m) : [loading(m) ? loadingRow(m) : cell(empty)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, dim }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const needsYou = w.status === "blocked" || w.status === "done";
    return h_flex()
      .relative()
      .id(`space-${w.id}`)
      .h(rowHeight({ tree }) + 8)
      .flex_none()
      .items_stretch()
      .rounded(9)
      .overflow_hidden()
      .border(1)
      .border_color(on ? fill : t.border)
      .bg(on ? fill + "26" : t.background)
      .when(Boolean(tree), (el) => el.ml(14))
      .when(!on, (el) => el.hover((s) => s.bg(fill + "14").border_color(fill + "99")))
      .when(Boolean(dim) && this.pressed !== w.id, (el) => el.opacity(0.55))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .on_hover((hovered, cx) => {
        if (hovered) this.hoveredSpace = w.id;
        else if (this.hoveredSpace === w.id) this.hoveredSpace = null;
        cx.notify();
      })
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && (this.over !== over || this.overGroup !== null)) {
          this.over = over;
          this.overGroup = null;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
          // Dropped among another group's spaces: it joins that group.
          const targetGroup = this.groupOf[w.id] ?? null;
          if ((this.groupOf[from] ?? null) !== targetGroup) moveToGroup(from, targetGroup);
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(div().w(4).flex_none().bg(fill))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .px(9)
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(fill)))
          .when(!tree, el => el.child(h_flex().size(20).flex_none().rounded(6).bg(fill).items_center().justify_center().text_size(11).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().font_medium().text_color(on ? fill : t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(this.hoveredSpace === w.id, el => {
            const selfHidden = organize().hidden.includes(w.id);
            return el.child(this.iconButton(`space-eye-${w.id}`, selfHidden ? EYE : EYE_OFF, selfHidden ? "Show space" : "Hide space", () => setSpaceHidden(w.id, !selfHidden), t));
          })
          .when(this.hoveredSpace !== w.id && needsYou, el => el.child(div().flex_none().text_color(tone(t, w.status)).child(glyph(w.status)))),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().absolute().left(3).w(3).h(14).rounded(2).bg(spaceFill(t, w.id)))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    if (props()?.menu) return this.menuView(t);
    if (props()?.ask) return this.askView(t);
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .when(!collapsed, el => el.child(h_flex().flex_1().justify_end().child(div().id("group-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).tooltip("New group").hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.ask("New group", "", { action: "newGroup" })).child(svg(ICON("folder-plus")).size(14)))))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).when(!collapsed, el => el.gap(5)).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.overGroup = null; cx.notify(); })
        .children(this.listRows(t, collapsed)));
  }

  // The list, and which spaces it hides, published for the agents list
  // (shared "space.hiddenNow": space ids, worktrees following their repo's).
  listRows(t, collapsed) {
    this.hiddenNow = new Set();
    const rows = this.grouped(t, collapsed);
    const next = [...this.hiddenNow].sort();
    if (JSON.stringify(next) !== JSON.stringify(shared("space.hiddenNow") ?? [])) setShared("space.hiddenNow", next);
    return rows;
  }
}
