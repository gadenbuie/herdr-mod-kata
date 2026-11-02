// Kata in the tab bar: the space's kata issues, as a tree, read-only.
//
// The panel has one home: the side panel's Kata tab. `mod.json` declares a
// `tab`, which is a manifest the `tab-host` mod reads — it draws a Kata button
// in the tab bar beside Files and Changes and adds this mod's block to the side
// panel's stack. That copy (no props) is the panel. Without `tab-host` the
// declaration is inert and `place: "none"` keeps the mod out of the window, so
// the second door is a pane of its own: `pane.split {mod: "kata"}` draws the
// same panel beside the terminals.
//
// It reads `kata list --json` for the project the space is in and shows what a
// terminal would show with `kata tui`: the open work, which task belongs under
// which, and every field the list carries. Status and branch are filters; a row
// opens the issue's own details, out of the same read — nothing here posts,
// claims, closes or comments, and nothing asks kata for more than one list.
//
// Which project is "the space's" is decided in this order, and the panel says
// which one it landed on:
//   1. the `kata.toml` binding at or above the folder the space's focused pane
//      is in — kata's own answer, so `kata tui` there shows the same issues;
//   2. a project named after the folder's git repo (its `origin` remote), which
//      is the name a kata binding usually gets;
//   3. nothing: a space with no kata project says so, and says what to run.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, focused, panes, exec, theme, readTextFile } from "herdr";

const ICONS = "mods/kata";
// The status filter's buttons, in the order they draw: what is left to do first.
const STATUSES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
// How many issues one read asks for. The whole list travels as one JSON
// document through `exec` (8 MiB of stdout), and a big project's closed issues
// are the part that could fill it: the newest 400 of each is plenty to look at,
// and the status filter is how the rest is reached.
const LIMIT = 400;
// The metadata key kata's own examples use for the branch a task belongs to
// (`kata create … --meta work.branch=audit-tokens`).
const BRANCH = "work.branch";
// How far up the folder is searched for a `kata.toml`. Twelve levels is deeper
// than any checkout and shallow enough to stay four cheap reads.
const UP = 12;

// ---- the place ----

// Where this space is now: its focused pane's folder, else where the window's
// focus is, else where the space was made. A space in a subfolder of its repo
// still resolves to the repo's binding (the search walks up), which is why the
// pane's own folder is the right thing to ask about and not something shared.
function folderOf(space) {
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || space?.folder || null;
}

const activeSpace = () => spaces().find((s) => s.active) ?? null;

// The project a `kata.toml` names, walking up from `folder`. The file is a few
// lines of TOML (`[project]` with `name = "…"`), so it is read as text rather
// than parsed: the one key this panel needs is the one it looks for.
async function tomlProject(folder, on) {
  let at = String(folder).replace(/\/+$/, "");
  for (let i = 0; i < UP && at; i++) {
    const text = await readTextFile(`${at}/.kata.toml`, { on }).catch(() => null);
    if (text != null) {
      const name = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (name) return name[1];
    }
    const up = at.replace(/\/[^/]*$/, "") || "/";
    if (up === at) break;
    at = up;
  }
  return null;
}

// The name a kata project for this folder would have: the git repo's, taken
// from its `origin` remote whether that is an ssh address or a URL, else the
// folder's own name.
async function repoName(folder, on) {
  try {
    const r = await exec("git", ["config", "--get", "remote.origin.url"], { cwd: folder, on });
    if (r.code === 0) {
      const url = String(r.stdout ?? "").trim();
      const name = url.replace(/\/+$/, "").split(/[/:]/).pop().replace(/\.git$/, "");
      if (name) return name;
    }
  } catch { /* not a checkout, or no git: the folder's name is next */ }
  const at = String(folder).replace(/\/+$/, "");
  return at.split("/").pop() || null;
}

// Which project this folder is. `bound` says kata would find it by itself (so
// the read runs without `--project`, the way `kata tui` would); otherwise the
// name is passed and the panel says it guessed.
async function resolveProject(folder, on) {
  const bound = await tomlProject(folder, on);
  if (bound) return { name: bound, bound: true };
  const repo = await repoName(folder, on);
  if (!repo) return { missing: true, repo: null };
  // A project of that name has to exist: the daemon's own list is the only
  // place that knows, and it is small.
  let names;
  try {
    const r = await exec("kata", ["projects", "list", "--json"], { cwd: folder, on });
    if (r.code !== 0) return { error: refusal(r) };
    names = (JSON.parse(r.stdout)?.projects ?? []).filter((p) => p.active !== false).map((p) => p.name);
  } catch (e) {
    return { error: "kata is not installed here, or it cannot start" };
  }
  if (names.includes(repo)) return { name: repo, bound: false };
  return { missing: true, repo };
}

// kata prints its refusal as JSON on stderr: the message, and the hint that
// says what to run, are the two lines worth showing.
function refusal(r) {
  const text = String(r.stderr ?? "").trim() || String(r.stdout ?? "").trim();
  try {
    const e = JSON.parse(text).error;
    if (e) return [e.message, e.hint].filter(Boolean).join(" — ");
  } catch { /* not the JSON it usually prints */ }
  return text.split("\n")[0] || `kata exited ${r.code}`;
}

// ---- the issues ----

function refs(list) {
  return (list ?? []).filter((r) => r?.uid).map((r) => ({ uid: r.uid, ref: r.short_id ?? "", status: r.status ?? null }));
}

// A branch name as it is stored. Some are written quoted by hand, and a quoted
// one is the same branch as an unquoted one: the filter groups them together.
function branchOf(metadata) {
  const raw = metadata?.[BRANCH];
  if (raw == null) return null;
  const text = String(raw).trim().replace(/^["']+|["']+$/g, "");
  return text || null;
}

function normalize(i) {
  return {
    uid: i.uid,
    ref: i.short_id ?? "",
    title: String(i.title ?? "").trim() || "(untitled)",
    body: String(i.body ?? ""),
    status: i.status ?? "open",
    closed: i.status === "closed",
    reason: i.closed_reason ?? null,
    owner: i.owner ?? null,
    author: i.author ?? null,
    priority: typeof i.priority === "number" ? i.priority : null,
    labels: (i.labels ?? []).map(String),
    branch: branchOf(i.metadata),
    parent: i.parent?.uid ?? null,
    created: Date.parse(i.created_at) || 0,
    updated: Date.parse(i.updated_at) || 0,
    closedAt: i.closed_at ? Date.parse(i.closed_at) || 0 : null,
    project: typeof i.qualified_id === "string" ? i.qualified_id.split("#")[0] : null,
    blocks: refs(i.blocks),
    blockedBy: refs(i.blocked_by),
    related: refs(i.related),
  };
}

// One read of the list: the status filter as kata's own `--status`, so the
// limit is spent on the rows being shown.
async function listIssues(folder, on, status, project) {
  const args = ["list", "--status", status, "--limit", String(LIMIT), "--json"];
  if (project) args.push("--project", project);
  let r;
  try {
    r = await exec("kata", args, { cwd: folder, on });
  } catch {
    return { error: "kata is not installed here, or it cannot start" };
  }
  if (r.code !== 0) return { error: refusal(r) };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { error: "kata answered in a shape this panel cannot read" }; }
  if (data?.error) return { error: String(data.error.message ?? data.error.code ?? "kata refused the read") };
  return { issues: (data?.issues ?? []).map(normalize) };
}

// What is left to do first, then what is most urgent, then what moved last.
function order(a, b) {
  return Number(a.closed) - Number(b.closed)
    || (a.priority ?? 9) - (b.priority ?? 9)
    || b.updated - a.updated;
}

function ago(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  if (m < 10080) return `${Math.floor(m / 1440)}d ago`;
  return `${Math.floor(m / 10080)}w ago`;
}

// A priority's colour, the way a queue reads: the two that come first are the
// loud ones, and everything else is quiet.
function priorityColor(t, p) {
  if (p <= 1) return t.ansi1;
  if (p === 2) return t.ansi3;
  return t.dim;
}

export default class Kata extends View {
  init(_props, cx) {
    this.origin = null;      // { folder, on }: the place this panel reads
    this.resolved = null;    // { name, bound } | { missing, repo }: once per place
    this.issues = [];        // the last good read, kept while a new one runs
    this.status = "open";
    // `undefined` is every branch, `null` the tasks with none, a string one
    // branch: the three answers the branch filter offers.
    this.branch = undefined;
    this.branchOpen = false;
    this.collapsed = new Set();
    this.selected = null;    // the uid the detail view shows
    this.folder = null;      // the folder the shown project was read from
    this.loading = false;
    this.ready = false;
    this.missing = false;
    this.failure = null;     // { title, message }: a read that could not happen
    this.gen = 0;            // one read at a time; an older answer is dropped
    this.refresh(cx, true);
    // Kata has no file to watch — issues change from terminals, agents and the
    // `kata` CLI — so the panel asks again on a timer. Fifteen seconds is the
    // pace of `kata tui`'s own refresh and costs one `exec`.
    cx.timer.every(15000, (cx) => this.refresh(cx));
    // The other timer reads no data: it only notices that the space moved and
    // asks again then. Nothing is redrawn unless it did.
    cx.timer.every(1000, (cx) => {
      const at = this.place();
      if (at.folder !== this.origin?.folder || at.on !== this.origin?.on) this.refresh(cx);
    });
  }

  place() {
    const space = activeSpace();
    return { folder: folderOf(space), on: space?.machine ?? null };
  }

  // Another space (or another folder in this one) is another project: the rows,
  // the folded ones, the open branch and the open issue all belong to the old
  // place and go with it. `fresh` also forgets which project this place is,
  // which is what the button does and the timer does not: a project appears
  // when someone runs `kata init`, and that is a fact worth re-asking for on a
  // click rather than on every read.
  refresh(cx, fresh = false) {
    const at = this.place();
    const moved = at.folder !== this.origin?.folder || at.on !== this.origin?.on;
    if (moved || fresh) {
      this.origin = at;
      this.resolved = null;
      this.folder = at.folder;
      this.issues = [];
      this.branch = undefined;
      this.branchOpen = false;
      this.collapsed = new Set();
      this.selected = null;
      this.failure = null;
      this.missing = false;
    }
    this.read(cx);
  }

  read(cx) {
    const origin = this.origin;
    const gen = ++this.gen;
    const settle = (cx) => { this.loading = false; this.ready = true; cx.notify(); };
    if (!origin?.folder) {
      // A space with no terminal anywhere yet has no folder to look in.
      this.missing = true;
      this.loading = false;
      this.ready = true;
      return cx.notify();
    }
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let project = this.resolved;
      if (!project) {
        const r = await resolveProject(origin.folder, origin.on);
        if (gen !== this.gen) return;
        if (r.error) {
          // Not remembered: the next read tries again, so a daemon that comes
          // back or a `yarn global add kata` fixes the panel by itself.
          this.failure = { title: "Kata cannot be read here", message: r.error };
          return settle(cx);
        }
        this.resolved = project = r;
      }
      if (project.missing) {
        this.missing = true;
        this.failure = null;
        this.issues = [];
        return settle(cx);
      }
      const out = await listIssues(origin.folder, origin.on, this.status, project.bound ? null : project.name);
      if (gen !== this.gen) return;
      if (out.error) {
        // The rows that are already there stay: a read that failed says so
        // above them rather than emptying the panel.
        this.failure = { title: "Kata did not answer", message: out.error };
      } else {
        this.failure = null;
        this.missing = false;
        this.issues = out.issues;
        // A branch the new read no longer has falls back to every branch.
        if (this.branch !== undefined && this.branch !== null && !this.branches().some(([b]) => b === this.branch)) {
          this.branch = undefined;
        }
        if (this.selected && !this.issues.some((i) => i.uid === this.selected)) this.selected = null;
      }
      settle(cx);
    });
  }

  // ---- what is shown ----

  by(uid) {
    return this.issues.find((i) => i.uid === uid) ?? null;
  }

  filtered() {
    if (this.branch === undefined) return this.issues;
    return this.issues.filter((i) => i.branch === this.branch);
  }

  branches() {
    const counts = new Map();
    for (const i of this.issues) {
      if (!i.branch) continue;
      counts.set(i.branch, (counts.get(i.branch) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  loose() {
    return this.issues.filter((i) => !i.branch).length;
  }

  kids(uid) {
    return this.issues.filter((i) => i.parent === uid);
  }

  // The tree as the panel draws it: siblings in work order, each parent's
  // children under it, and a folded row taking its subtree with it. A child
  // whose parent the filter dropped is a root here — the alternative is a row
  // nobody can reach.
  rows() {
    const all = this.filtered();
    const have = new Set(all.map((i) => i.uid));
    const kids = new Map();
    const roots = [];
    for (const i of all) {
      if (i.parent && have.has(i.parent)) {
        const into = kids.get(i.parent) ?? [];
        into.push(i);
        kids.set(i.parent, into);
      } else {
        roots.push(i);
      }
    }
    const below = (i) => (kids.get(i.uid) ?? []).reduce((n, kid) => n + 1 + below(kid), 0);
    const out = [];
    const walk = (list, depth) => {
      for (const i of [...list].sort(order)) {
        const children = kids.get(i.uid) ?? [];
        out.push({ issue: i, depth, kids: children.length, under: below(i) });
        if (children.length && !this.collapsed.has(i.uid)) walk(children, depth + 1);
      }
    };
    walk(roots, 0);
    return out;
  }

  // One button for both directions: with anything folded, it unfolds (what a
  // person wants after folding); with everything open, it folds.
  toggleAll(cx) {
    this.collapsed = this.collapsed.size > 0
      ? new Set()
      : new Set(this.issues.filter((i) => this.kids(i.uid).length > 0).map((i) => i.uid));
    cx.notify();
  }

  toggle(uid, cx) {
    if (this.collapsed.has(uid)) this.collapsed.delete(uid);
    else this.collapsed.add(uid);
    cx.notify();
  }

  // ---- pieces ----

  iconButton(id, icon, tip, action, spin = false) {
    const t = theme();
    const glyph = svg(`${ICONS}/${icon}.svg`).size(14);
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).cursor_pointer().on_click(action)
      // A read in flight turns the icon: drawn by GPUI, so it costs no timer.
      .child(spin ? glyph.spin(900) : glyph);
  }

  // The one-place note: a title, what happened, and the line that fixes it. The
  // panel is empty for a reason, so it says the reason rather than nothing.
  note(title, body, hint) {
    const t = theme();
    return v_flex().flex_1().min_h(0).px(18).py(16).gap(6).justify_center()
      .child(div().text_size(12.5).text_color(t.foreground).child(title))
      .child(div().text_size(11.5).text_color(t.muted).child(body))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
  }

  head(cx) {
    const t = theme();
    const name = this.resolved?.name ?? null;
    const guessed = this.resolved && this.resolved.bound === false;
    return h_flex().id("kata-head").h(42).flex_none().px(14).gap(8).items_center()
      .border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Kata"))
      .when(Boolean(name), (el) => el
        .child(div().px(6).rounded(99).bg(t.raised).text_color(guessed ? t.dim : t.muted)
          .text_size(10.5).max_w(170).truncate().tooltip(guessed ? `No kata binding here: the git repo's name, ${name}` : "The bound kata project")
          .child(name)))
      .child(div().flex_1())
      .when(this.collapsed.size > 0, (el) => el
        .child(this.iconButton("kata-fold", "unfold", "Expand all", (_e, cx) => this.toggleAll(cx))))
      .when(this.collapsed.size === 0, (el) => el
        .child(this.iconButton("kata-fold", "fold", "Collapse all", (_e, cx) => this.toggleAll(cx))))
      .child(this.iconButton("kata-refresh", "refresh", "Read the list again",
        (_e, cx) => this.refresh(cx, true), this.loading));
  }

  // Status and branch, the two questions a list of work is asked: what state,
  // and whose branch. The status row is three buttons; the branch filter is one
  // that shows the branch it means, because a chip per branch does not fit in a
  // 368 px panel and a project can have a dozen.
  filters(cx) {
    const t = theme();
    const segment = ({ value, label }) => {
      const on = this.status === value;
      return div().id(`kata-status-${value}`).h(22).flex_none().px(9).rounded(99).flex().items_center()
        .text_size(11.5).cursor_pointer()
        .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          if (this.status === value) return;
          this.status = value;
          this.selected = null;
          this.branchOpen = false;
          this.read(cx);
        })
        .child(label);
    };
    const label = this.branch === undefined ? "All branches" : this.branch === null ? "No branch" : this.branch;
    return h_flex().id("kata-filters").h(34).flex_none().px(12).gap(4).items_center()
      .border_b(1).border_color(t.border)
      .children(STATUSES.map(segment))
      .child(div().flex_1())
      .child(h_flex().id("kata-branch").h(22).flex_none().pl(7).pr(6).gap(5).rounded(6).max_w(190)
        .items_center().cursor_pointer()
        .when(this.branchOpen, (el) => el.bg(t.selected))
        .when(!this.branchOpen, (el) => el.hover((s) => s.bg(t.hover)))
        .tooltip("Filter by the branch a task is on")
        .on_click((_e, cx) => { this.branchOpen = !this.branchOpen; cx.notify(); })
        .child(svg(`${ICONS}/branch.svg`).size(11).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11)
          .text_color(this.branch === undefined ? t.dim : t.muted).child(label))
        .child(svg(`${ICONS}/chevron-down.svg`).size(10).flex_none().text_color(t.dim)));
  }

  // The branch filter, open: every branch the current status carries, with how
  // many tasks are on it. It stands in place of the tree rather than floating
  // over it — the panel is a tab, and nothing here needs a popup.
  chooser(cx) {
    const t = theme();
    const pick = (value, cx) => {
      this.branch = value;
      this.branchOpen = false;
      cx.notify();
    };
    const row = (id, value, label, count, active) => h_flex().id(id).h(26).flex_none().mx(6).px(10).gap(8)
      .rounded(6).items_center().cursor_pointer()
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => pick(value, cx))
      .child(div().flex_1().min_w(0).truncate().text_size(12)
        .text_color(active ? t.foreground : t.muted).child(label))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(String(count)));
    const branches = this.branches();
    const loose = this.loose();
    return v_flex().id("kata-branches").flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .child(row("kata-b-all", undefined, "All branches", this.issues.length, this.branch === undefined))
      .children(branches.map(([name, count], i) =>
        row(`kata-b-${i}`, name, name, count, this.branch === name)))
      .when(loose > 0, (el) => el.child(row("kata-b-none", null, "No branch", loose, this.branch === null)));
  }

  row(entry, cx) {
    const t = theme();
    const i = entry.issue;
    const open = !this.collapsed.has(i.uid);
    const blocked = i.blockedBy.some((b) => b.status === "open");
    const step = Math.min(entry.depth, 8);
    return h_flex().id(`kata-row-${i.uid}`).h(26).flex_none().mx(6).pl(8 + step * 14).pr(8).gap(6)
      .rounded(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.selected = i.uid; cx.notify(); })
      // A folded row's chevron is a button of its own: the row behind it opens
      // the issue, and a click that meant "fold" must not also open it.
      .child(entry.kids > 0
        ? div().id(`kata-fold-${i.uid}`).size(14).flex_none().flex().items_center().justify_center()
          .rounded(4).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.selected).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.toggle(i.uid, cx))
          .child(svg(`${ICONS}/${open ? "chevron-down" : "chevron-right"}.svg`).size(11))
        : div().w(14).flex_none())
      .child(i.closed
        ? svg(`${ICONS}/check-circle.svg`).size(11).flex_none().text_color(t.done)
        : div().w(11).flex_none().flex().items_center().justify_center()
          .child(div().size(6).rounded(99).bg(blocked ? t.ansi3 : t.dim)
            .when(blocked, (el) => el.tooltip("Blocked by an open issue"))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${i.ref}`))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(i.closed ? t.muted : t.foreground).child(i.title))
      .when(i.priority != null, (el) => el
        .child(div().flex_none().text_size(10).text_color(priorityColor(t, i.priority)).child(`P${i.priority}`)))
      .when(!open && entry.under > 0, (el) => el
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${entry.under}`)));
  }

  tree(cx) {
    const t = theme();
    const rows = this.rows();
    const here = this.filtered().length;
    return v_flex().id("kata-scroll").flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .when(rows.length === 0 && !this.loading, (el) => el.child(v_flex().px(16).py(14).gap(4)
        .child(div().text_size(12.5).text_color(t.muted).child(this.status === "closed" ? "Nothing closed yet" : "No issues here"))
        .child(div().text_size(11.5).text_color(t.dim)
          .child(this.branch === undefined ? `No ${this.status === "all" ? "" : `${this.status} `}issues in this project.` : "No issues on this branch."))))
      .children(rows.map((e) => this.row(e, cx)))
      // How many of the read are shown, when a filter is hiding some. The count
      // says the tree is not the whole project, so nobody hunts for a missing task.
      .when(this.branch !== undefined && here !== this.issues.length, (el) => el
        .child(div().px(16).py(8).text_size(10.5).text_color(t.dim)
          .child(`${here} of ${this.issues.length} on this branch filter`)));
  }

  // One line of the detail: a label and its value, or the refs it points at.
  field(label, value, color) {
    const t = theme();
    return h_flex().gap(8).flex_none().items_center()
      .child(div().w(66).flex_none().text_size(11).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(color ?? t.muted).child(value));
  }

  // Refs to other issues, as chips: the ones in this read open, the rest are
  // text, because the panel only knows what one list told it.
  chips(title, list, cx) {
    const t = theme();
    if (!list.length) return null;
    return v_flex().gap(4).flex_none().pt(2)
      .child(div().text_size(11).text_color(t.dim).child(title))
      .child(h_flex().flex_wrap().gap(4)
        .children(list.map((r) => {
          const known = Boolean(this.by(r.uid));
          const closed = r.status === "closed";
          return h_flex().id(`kata-ref-${r.uid}`).h(20).flex_none().px(6).gap(4).rounded(5).items_center()
            .bg(t.raised)
            .when(known, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
            .when(known, (el) => el.on_click((_e, cx) => { this.selected = r.uid; cx.notify(); }))
            .child(div().text_size(10.5).text_color(closed ? t.dim : t.muted).child(`#${r.ref}`))
            .when(closed, (el) => el.child(svg(`${ICONS}/check-circle.svg`).size(9).flex_none().text_color(t.done)));
        })));
  }

  detail(i, cx) {
    const t = theme();
    const parent = i.parent ? this.by(i.parent) : null;
    const kids = this.kids(i.uid);
    const back = h_flex().id("kata-back").h(28).flex_none().mx(6).px(8).gap(4).rounded(6).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.selected = null; cx.notify(); })
      .child(svg(`${ICONS}/chevron-left.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(11.5).text_color(t.muted).child("All issues"));
    // The ref, what state it is in, and its priority: the three things that say
    // whether this is the issue the person meant.
    const state = div().flex_none().px(5).rounded(99).text_size(9.5)
      .bg(i.closed ? t.done : t.raised)
      .text_color(i.closed ? t.background : t.muted)
      .child(i.closed ? (i.reason ?? "closed") : i.status);
    const top = h_flex().gap(6).items_center()
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${i.ref}`))
      .child(state)
      .when(i.priority != null, (el) => el.child(div().flex_none().text_size(10)
        .text_color(priorityColor(t, i.priority)).child(`P${i.priority}`)))
      .child(div().flex_1());
    const parentRow = parent
      ? h_flex().id("kata-parent").h(20).flex_none().px(6).rounded(5).bg(t.raised).items_center()
        .cursor_pointer().hover((s) => s.bg(t.selected))
        .on_click((_e, cx) => { this.selected = parent.uid; cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted)
          .child(`#${parent.ref} ${parent.title}`))
      : null;
    const meta = v_flex().pt(4).gap(3)
      .when(Boolean(i.owner), (el) => el.child(this.field("Owner", i.owner)))
      .when(Boolean(i.author && i.author !== i.owner), (el) => el.child(this.field("Author", i.author)))
      .when(Boolean(i.branch), (el) => el.child(this.field("Branch", i.branch)))
      .when(i.labels.length > 0, (el) => el.child(this.field("Labels", i.labels.join(", "))))
      .child(this.field("Updated", ago(i.updated) || "—"))
      .when(Boolean(parentRow), (el) => el.child(h_flex().gap(8).flex_none().items_center()
        .child(div().w(66).flex_none().text_size(11).text_color(t.dim).child("Parent"))
        .child(parentRow)))
      .when(kids.length > 0, (el) => el
        .child(this.field("Children", kids.map((k) => `#${k.ref}`).join(", "))));
    const body = v_flex().px(14).gap(5)
      .child(top)
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(i.title))
      .child(meta)
      // The description is kata's own markdown, drawn as markdown: it is where
      // the work, the plan and the requirements usually are.
      .child(div().pt(4).child(TextView.markdown(`kata-body-${i.uid}`, i.body || "_No description._")))
      .when(i.blocks.length > 0, (el) => el.child(this.chips("Blocks", i.blocks, cx)))
      .when(i.blockedBy.length > 0, (el) => el.child(this.chips("Blocked by", i.blockedBy, cx)))
      .when(i.related.length > 0, (el) => el.child(this.chips("Related", i.related, cx)));
    return v_flex().id("kata-detail").w_full().flex_none().pb(16).child(back).child(body);
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("root").size_full().min_h(0).overflow_hidden()
      .rounded(10).bg(t.background).border_1().border_color(t.border)
      .text_size(13).text_color(t.foreground);
    const issue = this.selected ? this.by(this.selected) : null;
    if (issue) {
      return root.child(this.head(cx))
        .child(v_flex().id("kata-detail-scroll").flex_1().min_h(0).overflow_y_scrollbar().pt(4)
          .child(this.detail(issue, cx)));
    }
    // A place with no project, or a read that could not happen, has nothing to
    // filter and nothing to fold: the panel is one note under its header.
    const nothing = this.missing || (Boolean(this.failure) && this.issues.length === 0);
    if (nothing) {
      const note = this.missing
        ? this.note(
          "No kata project here",
          this.resolved?.repo
            ? `Nothing is bound to ${this.folder ?? "this space"}, and no kata project is named ${this.resolved.repo}.`
            : `${this.folder ?? "This space"} is not bound to a kata project.`,
          this.resolved?.repo ? `kata init --project ${this.resolved.repo}` : "kata init --project <name>")
        : this.note(this.failure.title, this.failure.message,
          "The panel asks again on its own; the button above tries now.");
      return root.child(this.head(cx)).child(note);
    }
    return root
      .child(this.head(cx))
      .child(this.filters(cx))
      // A read that failed while rows are on screen says so over them, rather
      // than taking the panel away from what the person is reading.
      .when(Boolean(this.failure), (el) => el
        .child(div().px(14).pt(6).text_size(11).text_color(t.blocked).truncate()
          .tooltip(this.failure.message).child(this.failure.message)))
      .when(!this.ready, (el) => el.child(this.note("Reading kata…", `Asking for ${this.status} issues.`, null)))
      .when(this.ready, (el) => el.child(this.branchOpen ? this.chooser(cx) : this.tree(cx)));
  }
}
