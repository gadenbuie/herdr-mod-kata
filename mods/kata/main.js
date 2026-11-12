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
// which, and every field the list carries. Status and branch are filters, and a
// search narrows the same list by id, title or body; a row opens the issue's own
// details, out of the same read — nothing here posts, claims, closes or
// comments. One list per refresh, plus a `kata show` for each parent that list
// did not carry, so a task never loses its place in the tree.
//
// The branch filter follows the checkout. A space on the repo's own branch
// (`main`, or whatever origin/HEAD says) is not about one branch, so every task
// shows; a space on any other branch — a worktree, a topic checkout — shows the
// tasks recorded on that branch, since that is the work being done there. A
// person's pick in the branch filter wins over that default for that checkout,
// and `data/kata/settings.json` can turn the default off or make it strict.
//
// Which project is "the space's" is decided in this order, and the panel says
// which one it landed on:
//   1. the `.kata.toml` binding at or above the folder the space's focused pane
//      is in — kata's own answer, so `kata tui` there shows the same issues;
//   2. a project named after the folder's git repo (its `origin` remote), which
//      is the name a kata binding usually gets;
//   3. nothing: a space with no kata project says so, and says what to run.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, TextView } from "gpui-base";
import { spaces, focused, panes, exec, theme, readTextFile, appHome, shared, setShared, props, openOverlay, closeOverlay } from "herdr";

const ICONS = "mods/kata";
// The status filter's buttons, in the order they draw: what is left to do first.
const STATUSES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
// How many issues one read asks for. The whole list travels as one JSON
// document through `exec` (8 MiB of stdout), and a big project's closed issues
// are the part that could fill it: the newest 1000 of a status is plenty to look
// at, and a read that stops there says so and offers the next ceiling — `bigger`,
// one click away, until there is no ceiling at all.
const LIMIT = 1000;
// How many parents one read may go and ask for, one `kata show` each. A task
// whose parent the list did not carry is drawn under it, so the tree reads
// whole; past this many the task stands alone, which is where the panel was.
const PARENTS = 24;

// The next ceiling a capped read offers: twice this one, and past sixteen
// thousand none at all — `--limit 0` is kata's own way of asking for every row.
function bigger(n) {
  return n >= 16000 ? 0 : n * 2;
}
// The metadata key kata's own examples use for the branch a task belongs to
// (`kata create … --meta work.branch=audit-tokens`).
const BRANCH = "work.branch";
// How far up the folder is searched for a `.kata.toml`. Twelve levels is deeper
// than any checkout and shallow enough to stay four cheap reads.
const UP = 12;
// The names a repo's own branch has when `origin/HEAD` cannot be asked.
const TRUNK = ["main", "master", "trunk"];
// This panel's settings, on this machine (see branchMode).
const SETTINGS = () => `${appHome()}/data/kata/settings.json`;

// The shared key this panel keeps the space's state in — mod.json's `tab.state`.
// tab-host holds one value of it per space: the space being left has what the
// key held saved under it, and the space arrived at gets its own back, null
// when it never had any — so the state sticks to the workspace and comes back
// when the person does. This copy never names a space; it writes the key on
// the panel's own doings and takes the key back in when it shows something it
// did not write itself (see sync).
const STATE = "kata.state";

// ---- the place ----

// Where this space is now: its focused pane's folder, else where the window's
// focus is, else where the space was made. A space in a subfolder of its repo
// still resolves to the repo's binding (the search walks up), which is why the
// pane's own folder is the right thing to ask about and not something shared.
// The branch comes from the same place, and from Herdr rather than `git`: it is
// live, so a checkout is noticed without running anything.
function placeOf(space) {
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  // A layout terminal block focused: the pane that owns that terminal, if any.
  const shown = !pane && f?.terminal ? panes().find((p) => p.terminal === f.terminal) : null;
  return {
    folder: pane?.cwd || f?.cwd || space?.folder || null,
    on: space?.machine ?? null,
    branch: pane ? pane.branch : shown ? shown.branch : (space?.branch ?? null),
  };
}

const activeSpace = () => spaces().find((s) => s.active) ?? null;

// The project a `.kata.toml` names, walking up from `folder`. The file is a few
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

// The repo's own branch: the one the clone was made from, recorded once as
// `origin/HEAD`. Without that ref there is no answer here, and TRUNK decides.
async function trunkBranch(folder, on) {
  try {
    const r = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: folder, on });
    if (r.code === 0) {
      const name = String(r.stdout ?? "").trim().replace(/^origin\//, "");
      if (name) return name;
    }
  } catch { /* no origin, or no git: the usual names decide */ }
  return null;
}

// This machine's settings for the panel — one file, one key, no UI:
//
//   { "branchFilter": "auto" | "all" | "branch" }
//
// "auto" (the default) follows the space's branch off the trunk, "all" never
// filters, "branch" filters even on the trunk. A missing or broken file is
// "auto": the panel never fails to draw over a preference.
async function branchMode() {
  const text = await readTextFile(SETTINGS()).catch(() => null);
  if (!text) return "auto";
  try {
    const mode = JSON.parse(text)?.branchFilter;
    return mode === "all" || mode === "branch" ? mode : "auto";
  } catch {
    return "auto";
  }
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
    meta: i.metadata && typeof i.metadata === "object" ? i.metadata : {},
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

// `kata show` is the one read that names a single issue, so the parent a task
// points at and the list did not carry costs one exec. Its refs arrive as a
// list of `links` around the issue rather than on it, hence the reshaping: a
// "parent" link runs from the child to its parent, a block from the blocker to
// what it blocks, and "related" either way.
function relink(data, uid) {
  const short = (x) => ({ uid: x?.uid, short_id: x?.short_id ?? "", status: x?.status ?? null });
  const links = Array.isArray(data?.links) ? data.links : [];
  return {
    parent: links.find((l) => l?.type === "parent" && l.from?.uid === uid)?.to ?? null,
    blocks: links.filter((l) => l?.type === "blocks" && l.from?.uid === uid).map((l) => short(l.to)),
    blocked_by: links.filter((l) => l?.type === "blocks" && l.to?.uid === uid).map((l) => short(l.from)),
    related: links.filter((l) => l?.type === "related")
      .map((l) => (l.from?.uid === uid ? l.to : l.from)).map(short),
  };
}

// One issue, asked for by the uid a parent reference carried. A refusal is not a
// failure the panel shows: a parent that cannot be read is a parent the tree
// does without, and the task is drawn on its own the way it was before.
async function showIssue(folder, on, uid, project) {
  const args = ["show", uid, "--json"];
  if (project) args.push("--project", project);
  let r;
  try {
    r = await exec("kata", args, { cwd: folder, on });
  } catch {
    return null;
  }
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    if (!data?.issue?.uid) return null;
    return normalize({ ...data.issue, ...relink(data, data.issue.uid), qualified_id: null });
  } catch {
    return null;
  }
}

// One read of the list: the status filter as kata's own `--status`, so the
// ceiling is spent on the rows being shown.
async function listIssues(folder, on, status, project, limit) {
  const args = ["list", "--status", status, "--limit", String(limit), "--include-total", "--json"];
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
  const issues = (data?.issues ?? []).map(normalize);
  return {
    issues,
    // How many issues the status filter matched, and whether the ceiling cut the
    // list short: both are kata's own words (`--include-total` counts the match,
    // `truncated` says the limit was reached), so the panel can say what it is
    // not showing instead of leaving a missing task unexplained.
    total: typeof data?.total === "number" ? data.total : issues.length,
    truncated: data?.truncated === true || (data?.truncated == null && limit > 0 && issues.length >= limit),
  };
}

// What is left to do first, then what is most urgent, then what moved last.
function order(a, b) {
  return Number(a.closed) - Number(b.closed)
    || (a.priority ?? 9) - (b.priority ?? 9)
    || b.updated - a.updated;
}

// Siblings in drawing order: the base work order cut into three bands — open
// and unblocked, open and blocked, closed — because work that can start should
// read before work that cannot, and closed work is history. The base order
// holds inside every band, with one exception in the blocked band: a task
// draws below an open sibling that blocks it, whatever the priorities or
// recency say, because the work that frees work goes first. Picked the way a
// schedule is: repeatedly take the highest-placed task nothing still waiting
// blocks. Only sibling edges count there — a task's blocker under another
// parent already sits in that parent's place, and the marker says the rest —
// and a cycle (two tasks each naming the other a blocker, which no list should
// carry) has no task free to take, so the next in the base order goes rather
// than the list sticking.
function ordered(list) {
  const base = [...list].sort((a, b) => order(a.issue, b.issue));
  if (base.length < 2) return base;
  const blocked = (n) => n.issue.blockedBy.some((b) => b.status === "open");
  const ready = base.filter((n) => !n.issue.closed && !blocked(n));
  const closed = base.filter((n) => n.issue.closed);
  const waiting = base.filter((n) => !n.issue.closed && blocked(n));
  const pending = new Set(waiting.map((n) => n.issue.uid));
  const out = [];
  while (waiting.length) {
    let at = waiting.findIndex((n) =>
      !n.issue.blockedBy.some((b) => b.uid !== n.issue.uid && pending.has(b.uid)));
    if (at < 0) at = 0; // a blocking cycle among what is left: take the first
    const [node] = waiting.splice(at, 1);
    pending.delete(node.issue.uid);
    out.push(node);
  }
  return [...ready, ...out, ...closed];
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
// Where an open issue stands. Kata itself has two statuses, open and closed, so
// this is read from what the workflow leaves behind. Started: `kata claim` sets
// the owner and the agent contract then sets `work.attention` (ok, needs-human
// or stuck); either means the work is in flight. Backlog: the `backlog` label
// or `someday` metadata, which is also what `kata ready` leaves out. Blocked: an
// open issue blocks it. What is left is ready. In flight wins over everything,
// then backlog, since a deliberate "not now" is the more useful thing to know
// than an incidental blocker.
function workState(t, i, blocked = false) {
  if (i.closed) return { key: "done", label: i.reason ?? "closed", color: t.done };
  const attention = String(i.meta?.["work.attention"] ?? "").replace(/^["']+|["']+$/g, "");
  if (attention === "stuck") return { key: "stuck", label: "in progress — stuck", color: t.ansi1 };
  if (attention === "needs-human") return { key: "needs", label: "in progress — needs a person", color: t.ansi5 };
  if (i.owner || attention) return { key: "started", label: `in progress${i.owner ? ` — ${i.owner}` : ""}`, color: t.ansi4 };
  const someday = i.meta?.someday;
  if (i.labels?.includes("backlog") || (someday != null && someday !== false && someday !== "false")) {
    return { key: "backlog", label: "backlog", color: t.dim };
  }
  if (blocked) return { key: "blocked", label: "blocked", color: t.dim };
  return { key: "ready", label: "ready", color: t.dim };
}

// The marker that says it. Gray is quiet on purpose — most work is not ready —
// so the shapes carry it: an outline circle is backlog, a filled gray circle is
// ready, an outline square is blocked. In flight is the one with colour.
function stateDot(t, st, size = 7) {
  if (st.key === "blocked") return div().size(size).rounded(size * 0.2).border_1().border_color(st.color);
  const dot = div().size(size).rounded(99);
  return st.key === "backlog" ? dot.border_1().border_color(st.color) : dot.bg(st.color);
}

function priorityColor(t, p) {
  if (p <= 1) return t.ansi1;
  if (p === 2) return t.ansi3;
  return t.dim;
}

// ---- the search ----

// The strings a search reads, lowercased once per issue and kept on it: a
// keystroke must not lower a thousand descriptions again. An issue is as
// long-lived as the read it arrived in, which is as long as this cache is good.
function searchText(i) {
  return (i.searchText ??= {
    ref: i.ref.toLowerCase(),
    qualified: `${i.project ? `${i.project}#` : ""}${i.ref}`.toLowerCase(),
    title: i.title.toLowerCase(),
    body: i.body.toLowerCase(),
  });
}

// Where a query is in an issue, when it is anywhere: "name" for the id or the
// title — what an issue is called, so the issue the person means — and "body"
// for the description, which names the work rather than the task and ranks
// below it. Substring, case-insensitive, and nothing cleverer: `q` arrives
// trimmed and lowercased. A query may spell the id either way — `nfe7`, `#nfe7`
// — and one with a `#` in it may name the qualified id (`paparazzi#nfe7`).
function hitOf(i, q) {
  const text = searchText(i);
  const ref = q.replace(/^#/, "");
  if ((ref && text.ref.includes(ref)) || (q.includes("#") && text.qualified.includes(q))
    || text.title.includes(q)) return "name";
  return text.body.includes(q) ? "body" : null;
}

// The words around a match, for a row that is in the list because of its
// description: a page of markdown answers "why is this here?" with a paragraph,
// and one line around the match answers it with the words that matched.
function snippet(body, q, width = 84) {
  const text = String(body).replace(/\s+/g, " ").trim();
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return "";
  const from = Math.max(0, at - 24);
  const cut = text.slice(from, from + width).trim();
  return `${from > 0 ? "…" : ""}${cut}${from + width < text.length ? "…" : ""}`;
}

// ---- comments and metadata ----

// One issue's comments, asked for with `kata show` when the detail view opens
// it: the list carries the issue and its links but never the thread. A refusal
// is a thread the panel cannot show, and says so in place of the comments.
async function readComments(folder, on, uid, project) {
  const args = ["show", uid, "--json"];
  if (project) args.push("--project", project);
  let r;
  try {
    r = await exec("kata", args, { cwd: folder, on });
  } catch {
    return { error: "kata is not installed here, or it cannot start" };
  }
  if (r.code !== 0) return { error: refusal(r) };
  try {
    const data = JSON.parse(r.stdout);
    const comments = (data?.comments ?? []).map((c) => ({
      id: String(c.uid ?? c.id ?? ""),
      author: c.author ?? "",
      teammate: c.teammate ?? null,
      body: String(c.body ?? ""),
      at: Date.parse(c.created_at) || 0,
    }));
    return { comments, truncated: data?.comments_truncated === true };
  } catch {
    return { error: "kata answered in a shape this panel cannot read" };
  }
}

// Metadata is a bag of keys anyone can write. The panel already draws the one it
// understands (`work.branch`, as Branch), so the rest is what this lists: every
// other key, in name order, its value as written — text as text, anything
// structured as one line of JSON.
function metaRows(meta) {
  return Object.keys(meta ?? {})
    .filter((k) => k !== BRANCH)
    .sort()
    .map((k) => {
      const v = meta[k];
      return { key: k, value: typeof v === "string" ? v : JSON.stringify(v) };
    });
}

// ---- the graph ----

const NODE_W = 196;
const NODE_H = 42;
const GAP_X = 72;
const GAP_Y = 14;
const PAD = 28;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
// The most issues the whole-project graph draws: past this the canvas is a hairball.
const ALL_NODES = 300;

// What the graph shows of an issue's neighbourhood: every issue within `depth`
// hops of `focus` along parent, blocks and related links, in either direction,
// read out of the one list the overlay asked for. An issue a link names that
// the list did not carry is a stub — its ref and status are all there is.
function neighbourhood(issues, focus, depth, hideDone) {
  const byUid = new Map(issues.map((i) => [i.uid, i]));
  const stubs = new Map();
  const edges = [];
  const seen = new Set();
  const add = (from, to, kind) => {
    if (!from || !to || from === to) return;
    const key = kind === "related" ? `r:${[from, to].sort().join(":")}` : `${kind}:${from}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };
  const stub = (r) => {
    if (r?.uid && !byUid.has(r.uid) && !stubs.has(r.uid)) {
      stubs.set(r.uid, { uid: r.uid, ref: r.ref ?? "", title: "", status: r.status ?? "open", closed: r.status === "closed", stub: true });
    }
  };
  for (const i of issues) {
    if (i.parent) add(i.parent, i.uid, "parent");
    for (const r of i.blocks) { add(i.uid, r.uid, "blocks"); stub(r); }
    for (const r of i.blockedBy) { add(r.uid, i.uid, "blocks"); stub(r); }
    for (const r of i.related) { add(i.uid, r.uid, "related"); stub(r); }
  }
  const node = (uid) => byUid.get(uid) ?? stubs.get(uid) ?? (uid === focus ? null : { uid, ref: "", title: "", status: "open", closed: false, stub: true });
  const adj = new Map();
  for (const e of edges) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    }
  }
  if (!focus) {
    // No focus is the whole project: every issue with a link to another, newest
    // read first, up to a ceiling a canvas can still draw.
    let nodes = [...adj.keys()].map(node).filter((n) => n && !(hideDone && n.closed));
    const over = Math.max(0, nodes.length - ALL_NODES);
    nodes = nodes.slice(0, ALL_NODES);
    const kept = new Set(nodes.map((n) => n.uid));
    return { nodes, edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)), over };
  }
  // Breadth first from the focus, so the order the nodes are found in is the
  // order they start out in, and `hops` is how far each one is.
  const hops = new Map([[focus, 0]]);
  const order = [focus];
  for (let n = 0; n < order.length; n++) {
    const uid = order[n];
    if (hops.get(uid) >= depth) continue;
    for (const other of adj.get(uid) ?? []) {
      if (hops.has(other)) continue;
      const o = node(other);
      // A closed issue hides, and so does everything only reachable through it.
      if (hideDone && o?.closed) continue;
      hops.set(other, hops.get(uid) + 1);
      order.push(other);
    }
  }
  const nodes = order.map(node).filter(Boolean);
  const kept = new Set(nodes.map((n) => n.uid));
  return { nodes, edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)), hops, over: 0 };
}

// Columns left to right: what must come first is on the left. A parent sits
// before its children and a blocker before what it blocks; `related` carries no
// direction, so an issue with only those is set one column after the one that
// led to it. Within a column the order is swept toward the neighbours' average
// height a few times, which is enough to untangle the small graphs this draws.
function layout(graph, focus) {
  const { nodes, edges } = graph;
  const rank = new Map(nodes.map((n) => [n.uid, 0]));
  const directed = edges.filter((e) => e.kind !== "related");
  // Bounded rather than to a fixed point: a cycle never settles.
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of directed) {
      if (rank.get(e.to) < rank.get(e.from) + 1 && rank.get(e.from) < nodes.length) {
        rank.set(e.to, rank.get(e.from) + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const touched = new Set(directed.flatMap((e) => [e.from, e.to]));
  const settled = new Set(focus ? [...touched, focus] : touched);
  const loose = edges.filter((e) => e.kind === "related");
  for (let pass = 0; pass < nodes.length * 2; pass++) {
    let moved = false;
    for (const e of loose) {
      for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
        if (settled.has(a) && !settled.has(b)) {
          rank.set(b, rank.get(a) + 1);
          settled.add(b);
          moved = true;
        }
      }
    }
    if (moved) continue;
    // A group joined only by `related` has no start: its first issue is one.
    const first = nodes.find((n) => !settled.has(n.uid));
    if (!first) break;
    settled.add(first.uid);
  }
  const low = Math.min(...rank.values());
  const columns = [];
  for (const n of nodes) {
    const r = rank.get(n.uid) - low;
    (columns[r] ??= []).push(n);
  }
  for (let c = 0; c < columns.length; c++) columns[c] ??= [];
  const row = new Map();
  columns.forEach((col) => col.forEach((n, k) => row.set(n.uid, k)));
  const nbrs = new Map(nodes.map((n) => [n.uid, []]));
  for (const e of edges) { nbrs.get(e.from).push(e.to); nbrs.get(e.to).push(e.from); }
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const col of sweep % 2 ? [...columns].reverse() : columns) {
      const mean = (n) => {
        const ns = nbrs.get(n.uid);
        return ns.length ? ns.reduce((s, u) => s + row.get(u), 0) / ns.length : row.get(n.uid);
      };
      col.sort((a, b) => mean(a) - mean(b));
      col.forEach((n, k) => row.set(n.uid, k));
    }
  }
  const tall = Math.max(1, ...columns.map((c) => c.length));
  const pos = new Map();
  columns.forEach((col, c) => {
    // Columns are centred on the tallest one, so a short column reads as the
    // middle of the thing it hangs from rather than the top of it.
    const lift = ((tall - col.length) * (NODE_H + GAP_Y)) / 2;
    col.forEach((n, k) => pos.set(n.uid, { x: PAD + c * (NODE_W + GAP_X), y: PAD + lift + k * (NODE_H + GAP_Y) }));
  });
  return {
    pos,
    width: PAD * 2 + columns.length * NODE_W + (columns.length - 1) * GAP_X,
    height: PAD * 2 + tall * NODE_H + (tall - 1) * GAP_Y,
  };
}

// The line an edge is drawn with, as a path in the viewport's pixels: `a` and
// `b` are the cards' top-left corners already moved and scaled, `w` and `h` a
// card's size at this zoom. A curve from the right edge of one card to the left
// edge of the next, or a straight run down the side when both share a column.
function edgePath(e, a, b, w, h, z) {
  const dash = e.kind === "related";
  let from;
  let to;
  let curve;
  if (Math.abs(a.x - b.x) < 1) {
    const down = b.y > a.y;
    from = { x: a.x + w / 2, y: a.y + (down ? h : 0) };
    to = { x: b.x + w / 2, y: b.y + (down ? 0 : h) };
  } else {
    const right = b.x > a.x;
    from = { x: a.x + (right ? w : 0), y: a.y + h / 2 };
    to = { x: b.x + (right ? 0 : w), y: b.y + h / 2 };
    const bend = Math.abs(to.x - from.x) / 2;
    curve = { ax: from.x + (right ? bend : -bend), bx: to.x - (right ? bend : -bend) };
  }
  let line = PathBuilder.stroke(Math.max(1, 1.4 * z));
  if (dash) line = line.dash_array([4 * z, 3 * z]);
  line = line.move_to(from.x, from.y);
  line = curve ? line.cubic_bezier_to(to.x, to.y, curve.ax, from.y, curve.bx, to.y) : line.line_to(to.x, to.y);
  // The head points the way the edge was running when it arrived.
  const dx = curve ? Math.sign(to.x - from.x) : 0;
  const dy = curve ? 0 : Math.sign(to.y - from.y);
  const l = 8 * z;
  const head = dash ? null : PathBuilder.fill().add_polygon([
    [to.x, to.y],
    [to.x - dx * l - dy * l / 2, to.y - dy * l + dx * l / 2],
    [to.x - dx * l + dy * l / 2, to.y - dy * l - dx * l / 2],
  ], true).build();
  return { line: line.build(), head };
}

export default class Kata extends View {
  init(_props, cx) {
    // The same mod is also the graph window: `openGraph` opens it as an overlay
    // and hands it the issue to centre on, which is what tells the two apart.
    if (props()?.graph) return this.initGraph(props().graph, cx);
    // The threads and fields `kata show` adds to the list's rows, by uid:
    // { comments, truncated } | { error }, kept while a new ask is in flight.
    this.details = new Map();
    this.asking = new Set();
    // What the shared state key held as this copy last saw it — the string it
    // wrote, or the one it took in — so a render can tell a space's own value
    // arriving from the value this copy put there. Nothing yet: the first
    // render takes in whatever this space had saved.
    this.saved = undefined;
    this.origin = null;      // { folder, on }: the place this panel reads
    this.resolved = null;    // { name, bound } | { missing, repo }: once per place
    this.issues = [];        // the last good read, kept while a new one runs
    // The parents the read did not carry, by uid: a small cache asked for with
    // `kata show` (`gather`), dropped again when nothing points at it (`prune`),
    // so the tree shows a task under its parent whatever the filters did.
    this.ancestors = new Map();
    this.total = null;       // how many issues the status filter matched
    this.truncated = false;  // whether the read stopped at its ceiling
    this.ceiling = LIMIT;    // how many rows the read asked for
    this.status = "open";
    // The branch filter. `picked` holds what the person chose, per checkout —
    // keyed "folder|branch", so a checkout of another branch is offered the
    // default again — with `undefined` for every branch, `null` for the tasks
    // with none, and a branch name otherwise. `mode` is settings.json's
    // branchFilter, `trunk` the repo's own branch (asked of git once per place).
    this.picked = new Map();
    this.mode = "auto";
    this.trunk = null;
    this.branchOpen = false;
    // The search: a query over the rows this read carries, drawn in place of the
    // tree (`searching`) under a field of its own (`searchBar`). An open field
    // with nothing typed is the tree, unchanged, so closing the search and
    // emptying it are the same picture. The field is the one thing in this panel
    // that ever holds the keyboard, and only when a click opens it.
    this.searchOpen = false;
    this.query = "";
    this.searchTyping = false;
    this.searchInput = InputState.new({ placeholder: "Search ids, titles, bodies…" });
    this.searchInput.on("change", (_e, cx) => {
      const q = this.searchInput.value();
      if (q === this.query) return;
      this.query = q;
      cx.notify();
    });
    this.searchInput.on("focus", (_e, cx) => { this.searchTyping = true; cx.notify(); });
    this.searchInput.on("blur", (_e, cx) => { this.searchTyping = false; cx.notify(); });
    this.collapsed = new Set();
    this.selected = null;    // the uid the detail view shows
    // The issues the detail view came through, oldest first, the one before
    // the shown issue last: the trail `back` walks. Opening from the tree
    // starts a new one, so the tree is always where an empty trail ends.
    this.trail = [];
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
    // The other timer reads no data: it only notices that the place moved — a
    // space, a folder, a checkout — and asks again then. Nothing is redrawn
    // unless it did.
    cx.timer.every(1000, (cx) => {
      this.ensureDetail(cx);
      if (this.reread) { this.reread = false; this.read(cx); }
      const at = this.place();
      if (at.folder !== this.origin?.folder || at.on !== this.origin?.on
        || at.branch !== this.origin?.branch) this.refresh(cx);
    });
  }

  place() {
    return placeOf(activeSpace());
  }

  // ---- the state that sticks to the space ----

  // The state the space keeps, as the shared key holds it: which status is
  // showing, the branch picks (the person's own per checkout — `undefined` for
  // every branch and `null` for none, spelled out because JSON has no
  // undefined), the issue the detail view shows, the trail behind it, and the
  // folded rows. The search and the open branch chooser stay out: a field
  // mid-word and a menu mid-look are this minute's doings, not the space's.
  snapshot() {
    return JSON.stringify({
      status: this.status,
      picked: [...this.picked].map(([key, pick]) => ({
        key,
        pick: pick === undefined ? { all: true } : pick === null ? { none: true } : { branch: pick },
      })),
      selected: this.selected,
      trail: this.trail,
      collapsed: [...this.collapsed],
    });
  }

  // Write the state — from the panel's own doings only: a click, a pick, a
  // refresh button. Never from the timers or a read coming back: a copy asleep
  // in one space would otherwise write its stale view into whatever space the
  // person is in, and it would be saved as that space's.
  save() {
    this.saved = this.snapshot();
    setShared(STATE, this.saved);
  }

  // What a space that never had any state starts with: the same picture the
  // panel opens on anywhere.
  freshState() {
    this.status = "open";
    this.picked = new Map();
    this.selected = null;
    this.trail = [];
    this.collapsed = new Set();
  }

  // Read the key, and when it holds something this copy did not write or take
  // in already, take it in: the state of the space arrived at, handed back by
  // tab-host under the copy — asleep or awake — so waking into a space finds
  // the view it was left in. null, or nothing, or something unreadable, is a
  // space that starts fresh. What the key names is the whole of the carried
  // state: nothing of it lives anywhere else once this has run.
  sync() {
    let raw = shared(STATE);
    // `shared` reads back what was set, but what it reads back as — string or
    // already-parsed — is its own business: compare in one shape.
    const text = raw == null ? null : typeof raw === "string" ? raw : JSON.stringify(raw);
    if (text === this.saved) return;
    this.saved = text;
    if (text == null) return this.freshState();
    try {
      const s = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!s || typeof s !== "object") return this.freshState();
      if (STATUSES.some((x) => x.value === s.status) && s.status !== this.status) {
        // Another status is another list: a window that wrote it (the graph)
        // asked for an issue this list does not hold, and the timer reads again.
        this.status = s.status;
        this.reread = true;
      }
      if (typeof s.selected === "string" || s.selected === null) this.selected = s.selected;
      if (Array.isArray(s.trail)) this.trail = s.trail.filter((u) => typeof u === "string");
      if (Array.isArray(s.collapsed))
        this.collapsed = new Set(s.collapsed.filter((u) => typeof u === "string"));
      if (Array.isArray(s.picked)) {
        const picked = new Map();
        for (const e of s.picked) {
          if (!e || typeof e.key !== "string" || !e.pick || typeof e.pick !== "object") continue;
          if (e.pick.all === true) picked.set(e.key, undefined);
          else if (e.pick.none === true) picked.set(e.key, null);
          else if (typeof e.pick.branch === "string" && e.pick.branch) picked.set(e.key, e.pick.branch);
        }
        this.picked = picked;
      }
    } catch {
      this.freshState();
    }
  }

  // Another space, another checkout or another folder is another place: the
  // rows, the folds and the open issue belong to the old one and go with it —
  // though the folds, the open issue, the trail and the filters come back out
  // of the shared key (see sync), which tab-host keeps per space, so what the
  // arriving space was left showing is what it shows again. The branch
  // *default* is not state of the mod's — it follows the checkout (see
  // automatic) — so a checkout is a filter change, not a read: nothing asked
  // of kata would come back different. `fresh` also forgets which project the
  // place is, which is what the button does and the timer does not: a project
  // appears when someone runs `kata init`, and that is worth re-asking for on a
  // click rather than on every read.
  refresh(cx, fresh = false) {
    const at = this.place();
    const moved = at.folder !== this.origin?.folder || at.on !== this.origin?.on;
    const branched = at.branch !== this.origin?.branch;
    this.origin = at;
    if (moved || fresh) {
      this.resolved = null;
      this.trunk = null;
      this.folder = at.folder;
      this.issues = [];
      this.branchOpen = false;
      // Another project's list is another search: the field closes and the query
      // goes with it. A re-read of the same place (↻, the 15 s timer) keeps
      // them, because the person is still looking for the same thing.
      if (moved) this.clearSearch();
      this.ancestors.clear();
      this.total = null;
      this.truncated = false;
      this.ceiling = LIMIT;
      this.failure = null;
      this.missing = false;
      // The carried state is the arriving space's now, whatever the key holds
      // — or a fresh start where it holds nothing. The timer can run this, so
      // nothing is written here: the write is the panel's own doing, a click.
      this.sync();
      // A re-read of the same place (↻) drops the folds and the open issue the
      // way it always did — the person asked for the list again, not for their
      // view of it back — and the click that pressed it saves that.
      if (!moved) {
        this.selected = null;
        this.trail = [];
        this.collapsed = new Set();
      }
    } else if (branched) {
      // Another branch is another set of tasks, and another set of parents above
      // them: the list is the same read, but what it needs over it is not.
      cx.notify();
      this.needParents(cx);
      return;
    }
    this.read(cx);
  }

  // The parents for a filter the panel changed without a read: the rows on
  // screen are a different slice of the same list, and the chain above them may
  // be parents this panel has not asked for yet.
  needParents(cx) {
    if (!this.resolved || this.resolved.missing) return;
    cx.spawn((cx) => this.gather(cx, this.gen, this.origin, this.resolved));
  }

  // The links of the issue just opened: the same gather that fetches parents
  // also asks after the issue's blockers, blocks and kin when the list did not
  // carry them, so the chips in its detail view can name what they point at.
  needRefs(cx) {
    this.needParents(cx);
  }

  read(cx, limit = this.ceiling) {
    const origin = this.origin;
    const gen = ++this.gen;
    this.ceiling = limit;
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
      // The settings file is this machine's and tiny: read it on every pass, so
      // editing it lands within one refresh and needs no button.
      const mode = await branchMode();
      if (gen !== this.gen) return;
      this.mode = mode;
      let project = this.resolved;
      if (!project) {
        const [r, trunk] = await Promise.all([
          resolveProject(origin.folder, origin.on),
          trunkBranch(origin.folder, origin.on),
        ]);
        if (gen !== this.gen) return;
        this.trunk = trunk;
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
      const out = await listIssues(origin.folder, origin.on, this.status, project.bound ? null : project.name, limit);
      if (gen !== this.gen) return;
      if (out.error) {
        // The rows that are already there stay: a read that failed says so
        // above them rather than emptying the panel.
        this.failure = { title: "Kata did not answer", message: out.error };
        return settle(cx);
      }
      this.failure = null;
      this.missing = false;
      this.issues = out.issues;
      this.total = out.total;
      this.truncated = out.truncated;
      this.prune();
      // A step the new read no longer has is a step that cannot be taken: the
      // trail keeps only what the tree above it can still show.
      const known = this.known();
      this.trail = this.trail.filter((uid) => known.has(uid));
      if (this.selected && !known.has(this.selected)) this.selected = null;
      settle(cx);
      // A new read is a new look at the open issue's thread too.
      if (this.selected) this.ensureDetail(cx, true);
      // The rows land first, and then their parents are asked for: a task whose
      // parent the read did not carry stands alone for a moment, then moves
      // under it. Nothing waits on the fetch, so a slow daemon shows the list.
      await this.gather(cx, gen, origin, project);
    });
  }

  // ---- what is shown ----

  // An issue the panel can draw a row for: one of the read, or a parent it went
  // and asked after.
  by(uid) {
    return this.issues.find((i) => i.uid === uid) ?? this.ancestors.get(uid) ?? null;
  }

  // Every uid with an issue behind it, the read's and the fetched parents'.
  known() {
    return new Set([...this.issues.map((i) => i.uid), ...this.ancestors.keys()]);
  }

  // The parents the tree needs and does not have: the parents of the tasks the
  // filters show, and of the parents already fetched — a parent of a parent is
  // drawn too, so the chain to the top is whole however deep it goes.
  missingParents() {
    const have = this.known();
    const want = new Set();
    const ask = (i) => { if (i.parent && !have.has(i.parent)) want.add(i.parent); };
    for (const i of this.filtered()) ask(i);
    for (const i of this.ancestors.values()) ask(i);
    // The open issue's own links: its blockers, blocks and kin are drawn in the
    // detail view, and a chip with a title behind it reads like the parent row
    // does — kata's links carry no titles, so the targets are asked for whole.
    const open = this.selected ? this.by(this.selected) : null;
    if (open) for (const r of [...open.blockedBy, ...open.blocks, ...open.related]) {
      if (!have.has(r.uid)) want.add(r.uid);
    }
    return [...want];
  }

  // Ask kata for the parents the list did not carry, one `kata show` each, and
  // repeat while a fetched parent turns out to have a parent of its own. PARENTS
  // caps what one read may spend on this; past it a task is drawn as a root,
  // which is where the panel started.
  async gather(cx, gen, origin, project) {
    const scope = project.bound ? null : project.name;
    let left = PARENTS;
    while (left > 0) {
      const want = this.missingParents().slice(0, left);
      if (!want.length) return;
      left -= want.length;
      const found = await Promise.all(want.map((uid) => showIssue(origin.folder, origin.on, uid, scope)));
      if (gen !== this.gen) return;
      let added = 0;
      for (const i of found) {
        if (!i || this.by(i.uid)) continue;
        this.ancestors.set(i.uid, i);
        added++;
      }
      // Nothing new came back: the rest would be asked for to no purpose.
      if (!added) return;
      cx.notify();
    }
  }

  // A fetched parent is a cache of the read that asked for it: one that no task
  // in the new read still points at, directly or through another parent, is
  // forgotten — and so is one the new read carries itself, which is a row of its
  // own now. A status or branch change then does not carry old rows into it.
  // The open issue's ref targets stay too, for the chips in its detail view.
  prune() {
    const have = new Set(this.issues.map((i) => i.uid));
    const keep = new Set();
    const need = this.issues.map((i) => i.parent).filter(Boolean);
    const open = this.selected ? this.by(this.selected) : null;
    if (open) for (const r of [...open.blockedBy, ...open.blocks, ...open.related]) need.push(r.uid);
    while (need.length) {
      const uid = need.pop();
      if (keep.has(uid)) continue;
      keep.add(uid);
      const up = this.ancestors.get(uid)?.parent;
      if (up) need.push(up);
    }
    for (const uid of [...this.ancestors.keys()]) {
      if (!keep.has(uid) || have.has(uid)) this.ancestors.delete(uid);
    }
  }

  // The filter the space asks for by itself. On the repo's own branch every task
  // is in play — a checkout of `main` is not about one branch. On any other
  // branch it is: a worktree, a topic checkout, and the tasks recorded on that
  // branch are the ones being worked on there. `mode` can say "all" (never
  // filter) or "branch" (filter even on the trunk) instead.
  automatic() {
    const branch = this.origin?.branch ?? null;
    if (this.mode === "all" || !branch) return undefined;
    if (this.mode === "auto" && this.isTrunk(branch)) return undefined;
    return branch;
  }

  // The repo's default branch decides what the trunk is; without origin/HEAD to
  // ask, the names it usually has do.
  isTrunk(branch) {
    return branch === this.trunk || TRUNK.includes(branch);
  }

  // A pick belongs to the checkout it was made in, so a checkout of another
  // branch is offered the default again rather than an old branch's filter.
  key() {
    return `${this.origin?.folder ?? ""}|${this.origin?.branch ?? ""}`;
  }

  // The filter in force: the person's pick for this checkout, else the default.
  chosen() {
    return this.picked.has(this.key()) ? this.picked.get(this.key()) : this.automatic();
  }

  // An automatic branch filter that matches nothing falls back to every branch —
  // a worktree whose tasks were recorded under another name should not open
  // empty — and the panel says so above the tree. A pick is the person's own,
  // so it is kept even when it is empty.
  fellBack() {
    const branch = this.chosen();
    return this.mode === "auto" && !this.picked.has(this.key()) && this.issues.length > 0
      && branch !== undefined && !this.issues.some((i) => i.branch === branch);
  }

  filtered() {
    const branch = this.fellBack() ? undefined : this.chosen();
    if (branch === undefined) return this.issues;
    return this.issues.filter((i) => i.branch === branch);
  }

  // ---- the search ----

  // Whether the query is narrowing the list: the field is open and has words in
  // it. An open field with nothing typed is the tree, unchanged.
  searching() {
    return this.searchOpen && this.query.trim().length > 0;
  }

  // What the query says, as a search reads it.
  queryQ() {
    return this.query.trim().toLowerCase();
  }

  // The field closes and its query goes with it — what a moved place and a
  // second click on the button both do. The value is set only when there is one
  // to empty, so the input's own `change` is not fired for nothing.
  clearSearch() {
    this.searchOpen = false;
    if (this.query) {
      this.query = "";
      this.searchInput.set_value("");
    }
  }

  // The field is a view of the list, not a read: opening it asks kata for
  // nothing, and closing it puts back the tree exactly as it was. Opening it
  // also moves the keyboard onto the field — the one place in this panel that
  // ever holds it — because a search box you have to click twice is one nobody
  // uses; clicking a row, or the terminal, takes the keyboard back.
  toggleSearch(cx) {
    this.branchOpen = false;
    const open = !this.searchOpen;
    if (!open) this.clearSearch();
    else this.searchOpen = true;
    cx.notify();
    if (open) this.searchInput.focus();
  }

  // The issues the query finds, in the order the panel ranks them: the ones it
  // names in their id or title first, then the ones whose description it is in.
  // Both groups keep the tree's own work order — open before closed, then
  // priority, then what moved last — because a search is still a list of work to
  // do rather than a list of scores.
  matches(q) {
    const names = [];
    const bodies = [];
    for (const i of this.filtered()) {
      const hit = hitOf(i, q);
      if (hit === "name") names.push(i);
      else if (hit === "body") bodies.push(i);
    }
    return { names: names.sort(order), bodies: bodies.sort(order) };
  }

  // What a search that found nothing looked at, which is this very list — the
  // status and the branch above it — so the answer to "is it gone?" is in the
  // panel rather than in the reader's head. The other statuses are named because
  // they are the one click `statusEscape` offers.
  missLine() {
    const branch = this.fellBack() ? undefined : this.chosen();
    const where = branch === undefined ? "" : branch === null ? " without a branch" : ` on ${branch}`;
    const scope = this.status === "all" ? "every issue" : `the ${this.status} issues`;
    const others = this.status === "all"
      ? []
      : STATUSES.filter((s) => s.value !== this.status).map((s) => s.label);
    return `Searched ${scope}${where}${others.length ? ` — ${others.join(" and ")} search the rest` : ""}.`;
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

  // Blocked: an open issue blocks it, or it is a parent whose open children are
  // all blocked themselves — nothing under it can move, so neither can it. A
  // parent with no open children is not blocked by them, and a child that is
  // in flight or backlog still counts as blocked only if something blocks it.
  isBlocked(i, seen = new Set()) {
    if (!i || i.closed || i.stub) return false;
    if (i.blockedBy.some((b) => b.status === "open")) return true;
    if (seen.has(i.uid)) return false;
    seen.add(i.uid);
    const open = this.kids(i.uid).filter((k) => !k.closed);
    return open.length > 0 && open.every((k) => this.isBlocked(k, seen));
  }

  kids(uid) {
    return [...this.issues, ...this.ancestors.values()].filter((i) => i.parent === uid);
  }

  // The tree as the panel draws it: siblings in work order, each parent's
  // children under it, and a folded row taking its subtree with it. A task's
  // parent is part of the tree even when a filter kept it out of the read or out
  // of the branch: it comes back as a context row (`context: true`) rather than
  // the task becoming a root, because the hierarchy is what the tree is for. A
  // parent that cannot be had at all — refused by `kata show`, or past the
  // PARENTS cap — is the one case where a task stands alone.
  rows() {
    const shown = this.filtered();
    const nodes = new Map();    // uid -> { issue, context }
    for (const i of shown) nodes.set(i.uid, { issue: i, context: false });
    // The chain above each shown task, up to the first parent that is a row of
    // its own: every one it passes on the way is a context row (anything that is
    // not is already in `nodes`), and none of them repeats, so the chain costs
    // one walk per task, not one per parent.
    for (const i of shown) {
      let up = i.parent ? this.by(i.parent) : null;
      const seen = new Set([i.uid]);
      while (up && !nodes.has(up.uid) && !seen.has(up.uid)) {
        seen.add(up.uid);
        nodes.set(up.uid, { issue: up, context: true });
        up = up.parent ? this.by(up.parent) : null;
      }
    }
    const kids = new Map();
    const roots = [];
    for (const node of nodes.values()) {
      const at = node.issue.parent;
      if (at && at !== node.issue.uid && nodes.has(at)) {
        const into = kids.get(at) ?? [];
        into.push(node);
        kids.set(at, into);
      } else {
        roots.push(node);
      }
    }
    const below = (uid, seen = new Set()) => {
      if (seen.has(uid)) return 0;
      seen.add(uid);
      return (kids.get(uid) ?? []).reduce((n, kid) => n + 1 + below(kid.issue.uid, seen), 0);
    };
    const drawn = new Set();
    const out = [];
    // A folded row takes its subtree with it: those rows are hidden, not moved,
    // so they are marked drawn and nothing below draws them as a root.
    const hide = (list) => {
      for (const node of list) {
        if (drawn.has(node.issue.uid)) continue;
        drawn.add(node.issue.uid);
        hide(kids.get(node.issue.uid) ?? []);
      }
    };
    const walk = (list, depth) => {
      for (const node of ordered(list)) {
        const uid = node.issue.uid;
        if (drawn.has(uid)) continue;
        drawn.add(uid);
        const children = kids.get(uid) ?? [];
        out.push({
          issue: node.issue, depth, context: node.context,
          kids: children.length, under: below(uid),
        });
        if (!children.length) continue;
        if (this.collapsed.has(uid)) hide(children);
        else walk(children, depth + 1);
      }
    };
    walk(roots, 0);
    // Two tasks each claiming the other as parent — which no list should carry,
    // and a bad edit could — leaves rows no root reaches. They are drawn as
    // roots: a row nobody can see is worse than one drawn a level too high.
    for (const node of nodes.values()) if (!drawn.has(node.issue.uid)) walk([node], 0);
    return out;
  }

  // One button for both directions: with anything folded, it unfolds (what a
  // person wants after folding); with everything open, it folds. The parents it
  // folds are the rows as drawn, so a context parent folds like any other.
  toggleAll(cx) {
    this.collapsed = this.collapsed.size > 0
      ? new Set()
      : new Set(this.rows().filter((e) => e.kids > 0).map((e) => e.issue.uid));
    this.save();
    cx.notify();
  }

  toggle(uid, cx) {
    if (this.collapsed.has(uid)) this.collapsed.delete(uid);
    else this.collapsed.add(uid);
    this.save();
    cx.notify();
  }

  // ---- the trail ----

  // Every way into a detail view comes through here, so the trail is the same
  // whichever link was followed — a row in the tree, a ref chip, the parent.
  // From the tree the trail starts over (there is nothing behind it); from
  // another issue it is one step longer.
  open(uid, cx) {
    if (!uid || uid === this.selected) return;
    if (this.selected) this.trail.push(this.selected);
    else this.trail = [];
    this.selected = uid;
    this.save();
    this.ensureDetail(cx);
    this.needRefs(cx);
    cx.notify();
  }

  // One step back along the trail, which ends at the tree.
  back(cx) {
    this.selected = this.trail.pop() ?? null;
    this.save();
    this.ensureDetail(cx);
    this.needRefs(cx);
    cx.notify();
  }

  // The way out: the trail goes and the tree is back, whatever depth it was at.
  dismiss(cx) {
    this.trail = [];
    this.selected = null;
    this.save();
    cx.notify();
  }

  // Where `back` goes, or null when it goes to the tree. The issue it names is
  // the one the last step came from.
  cameFrom() {
    return this.trail.length > 0 ? this.by(this.trail[this.trail.length - 1]) : null;
  }

  // ---- the open issue's thread ----

  // The comments of the issue the detail view shows. Asked for when one opens
  // (`open`, `back`, a restored space) and again with each full read, so a
  // comment an agent just wrote shows up within a refresh; the old thread stays
  // on screen while the new one is on its way.
  ensureDetail(cx, force = false) {
    const uid = this.selected;
    const folder = this.origin?.folder;
    if (!uid || !folder || !this.resolved || this.resolved.missing) return;
    if (this.asking.has(uid) || (!force && this.details.has(uid))) return;
    const origin = this.origin;
    const scope = this.resolved.bound ? null : this.resolved.name;
    this.asking.add(uid);
    cx.spawn(async (cx) => {
      const out = await readComments(origin.folder, origin.on, uid, scope);
      this.asking.delete(uid);
      // Another place is another project's threads.
      if (origin.folder !== this.origin?.folder || origin.on !== this.origin?.on) return;
      this.details.set(uid, out);
      cx.notify();
    });
  }

  // The thread as the detail view draws it: a header with the count, then each
  // comment as its author, its age and its markdown.
  thread(i) {
    const t = theme();
    const d = this.details.get(i.uid);
    const head = (text) => div().text_size(11).text_color(t.dim).child(text);
    if (!d) return v_flex().gap(4).pt(6).child(head("Comments")).child(div().text_size(11).text_color(t.dim).child("Reading…"));
    if (d.error) {
      return v_flex().gap(4).pt(6).child(head("Comments"))
        .child(div().text_size(11).text_color(t.blocked).child(d.error));
    }
    return v_flex().gap(6).pt(6)
      .child(head(d.comments.length ? `Comments (${d.comments.length})` : "Comments"))
      .when(d.comments.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("No comments.")))
      .children(d.comments.map((c, n) => v_flex().gap(3).p(8).rounded(6).bg(t.raised)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(11).font_semibold().text_color(t.muted)
            .child(c.teammate ? `${c.author}/${c.teammate}` : c.author || "unknown"))
          .child(div().text_size(10.5).text_color(t.dim).child(ago(c.at) || ""))
          .child(div().flex_1()))
        .child(TextView.markdown(`kata-comment-${i.uid}-${c.id || n}`, c.body || "_Empty comment._"))))
      .when(d.truncated, (el) => el.child(div().text_size(10.5).text_color(t.dim)
        .child("kata cut the thread short; `kata show` has the rest.")));
  }

  // The metadata the panel has no row of its own for: the fields' own layout,
  // under a heavier `Metadata` heading with a little air above it — the space
  // and the heading are the whole signal that what follows is beyond what
  // kata provides, written by whoever made the issue.
  metadata(i) {
    const rows = metaRows(i.meta);
    if (!rows.length) return null;
    return v_flex().pt(6).gap(3)
      .child(div().text_size(11).font_semibold().text_color(theme().muted).child("Metadata"))
      .children(rows.map((r) => this.field(r.key, r.value)));
  }

  // ---- the graph window ----

  // The graph is a window of its own because a graph wants the room a 368 px
  // panel does not have, and because a node is something to click: it opens
  // that issue in the panel and puts the window away.
  openGraph(uid) {
    // No uid is the whole project's graph.
    if (!this.origin?.folder || !this.resolved || this.resolved.missing) return;
    openOverlay({
      mod: "kata",
      kind: "dialog",
      width: 0.9,
      height: 0.85,
      props: {
        graph: {
          uid: uid ?? null,
          folder: this.origin.folder,
          on: this.origin.on ?? null,
          project: this.resolved.bound ? null : this.resolved.name,
        },
      },
    });
  }

  initGraph(spec, cx) {
    this.graph = spec;
    // The whole project is too many issues for one-hop reading; one issue's
    // neighbourhood starts at one hop, and the person opens it up.
    this.depth = 1;
    this.hideDone = !spec.uid;
    this.gIssues = null;
    this.gError = null;
    // The graph window is the panel's class opened with a different prop, and
    // `init` returns here before the panel's fields are made — but the state
    // helpers the cards share (`isBlocked`, through `kids`) still read them.
    // The graph carries its own read, so the fields point at it once it lands;
    // before that no card is drawn and nothing asks. Empty until then.
    this.issues = [];
    this.ancestors = new Map();
    // The viewport: where the canvas's top-left sits in it and how big a pixel
    // of the canvas is. `placing` says what the next render should frame —
    // the focused issue, or the whole graph — once the viewport's size is known.
    this.vx = 0;
    this.vy = 0;
    this.vz = 1;
    this.vsize = null;
    this.placing = spec.uid ? "focus" : "fit";
    this.dragFrom = null;
    this.dragged = false;
    cx.spawn(async (cx) => {
      // Every status: the closed issues are part of the picture, and `hideDone`
      // is a view of the read rather than another one.
      const out = await listIssues(spec.folder, spec.on, "all", spec.project, 0);
      if (out.error) this.gError = out.error;
      else {
        this.gIssues = out.issues;
        // A whole-project read at "all": the same list `isBlocked` wants, so
        // a card's dot and tooltip say what the panel's row would.
        this.issues = out.issues;
      }
      cx.notify();
    });
  }

  // A node was clicked: the panel is told by the one channel it has, the key
  // that carries a space's view, and the window goes. The status goes to "all"
  // when the issue is closed, because a panel on "open" would not know the
  // issue and would drop it on its next read.
  pickNode(n) {
    if (this.dragged) return;
    let state = {};
    try {
      const raw = shared(STATE);
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === "object") state = parsed;
    } catch { /* an unreadable key is a state to start over from */ }
    state.selected = n.uid;
    state.trail = [];
    if (n.closed && state.status === "open") state.status = "all";
    setShared(STATE, JSON.stringify(state));
    closeOverlay(props().overlay);
  }

  // Frame the canvas in the viewport: on the focused card at full size, or the
  // whole graph shrunk to fit. Runs from render, once the viewport has a size.
  frame(L, focusPos) {
    const v = this.vsize;
    if (!v || !this.placing) return;
    if (this.placing === "focus" && focusPos) {
      this.vz = 1;
      this.vx = v.width / 2 - (focusPos.x + NODE_W / 2);
      this.vy = v.height / 2 - (focusPos.y + NODE_H / 2);
    } else {
      this.vz = Math.min(1, Math.max(MIN_ZOOM, Math.min((v.width - 32) / L.width, (v.height - 32) / L.height)));
      this.vx = (v.width - L.width * this.vz) / 2;
      this.vy = (v.height - L.height * this.vz) / 2;
    }
    this.placing = null;
  }

  // Zoom keeping the canvas point under (px, py) — the pointer, or the middle of
  // the viewport — where it is.
  zoomAt(factor, px, py, cx) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.vz * factor));
    const k = z / this.vz;
    this.vx = px - (px - this.vx) * k;
    this.vy = py - (py - this.vy) * k;
    this.vz = z;
    cx.notify();
  }

  zoomMid(factor, cx) {
    const v = this.vsize ?? { width: 0, height: 0 };
    this.zoomAt(factor, v.width / 2, v.height / 2, cx);
  }

  graphCard(n, at, z, focus) {
    const t = theme();
    const w = NODE_W * z;
    const h = NODE_H * z;
    return div().id(`kata-node-${n.uid}`).absolute().left(at.x).top(at.y).w(w).h(h)
      .px(8 * z).py(4 * z).rounded(7 * z).border_1()
      .border_color(n.uid === focus ? t.foreground : t.border)
      .bg(t.raised).cursor_pointer().hover((st) => st.bg(t.selected))
      .flex().flex_col().justify_center().gap(1).overflow_hidden()
      .on_click((_e, cx) => this.pickNode(n))
      .child(h_flex().gap(5 * z).items_center()
        .when(!n.closed && !n.stub, (el) => el.child(stateDot(t, workState(t, n,
          this.isBlocked(n)), 7 * z).tooltip(workState(t, n, this.isBlocked(n)).label)))
        .child(div().flex_none().text_size(10.5 * z).text_color(n.closed ? t.dim : t.muted).child(`#${n.ref}`))
        .when(n.priority != null, (el) => el.child(div().flex_none().text_size(9.5 * z)
          .text_color(priorityColor(t, n.priority)).child(`P${n.priority}`)))
        .child(div().flex_1())
        .when(n.closed, (el) => el.child(svg(`${ICONS}/check-circle.svg`).size(10 * z).flex_none().text_color(t.done))))
      .child(div().min_w(0).truncate().text_size(11.5 * z)
        .text_color(n.closed ? t.dim : t.foreground).child(n.stub ? "(not in this read)" : n.title));
  }

  graphBar(cx, focusIssue) {
    const t = theme();
    const pill = (id, label, on, action, tip) => div().id(id).h(22).flex_none().px(9).rounded(99).flex().items_center()
      .text_size(11.5).cursor_pointer()
      .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click(action).child(label);
    const key = (color, label) => h_flex().gap(4).items_center()
      .child(div().w(14).h(0).border_t(2).border_color(color))
      .child(div().text_size(10.5).text_color(t.dim).child(label));
    const spot = this.graph.uid;
    return h_flex().id("kata-graph-bar").h(42).flex_none().px(14).gap(6).items_center()
      .border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Graph"))
      .when(Boolean(focusIssue), (el) => el.child(div().min_w(0).max_w(300).truncate().text_size(11.5).text_color(t.muted)
        .child(`#${focusIssue.ref} ${focusIssue.title}`)))
      .when(!spot, (el) => el.child(div().text_size(11.5).text_color(t.muted).child("whole project")))
      .child(div().flex_1())
      .child(key(t.dim, "parent"))
      .child(key(t.blocked, "blocks"))
      .child(key(t.dim, "related"))
      .child(div().w(6))
      .when(Boolean(spot), (el) => el.children([1, 2, 3].map((d) => pill(`kata-depth-${d}`, `${d} hop${d > 1 ? "s" : ""}`,
        this.depth === d, (_e, cx) => { this.depth = d; this.placing = "focus"; cx.notify(); }))))
      .child(pill("kata-hide-done", this.hideDone ? "Show done" : "Hide done", false,
        (_e, cx) => { this.hideDone = !this.hideDone; this.placing = spot ? "focus" : "fit"; cx.notify(); }))
      .child(div().w(6))
      .child(pill("kata-zoom-out", "−", false, (_e, cx) => this.zoomMid(1 / 1.25, cx), "Zoom out"))
      .child(div().w(38).text_size(11).text_color(t.dim).flex().justify_center().child(`${Math.round(this.vz * 100)}%`))
      .child(pill("kata-zoom-in", "+", false, (_e, cx) => this.zoomMid(1.25, cx), "Zoom in"))
      .child(pill("kata-fit", "Fit", false, (_e, cx) => { this.placing = "fit"; cx.notify(); }, "Fit the whole graph in view"))
      .when(Boolean(spot), (el) => el.child(pill("kata-focus", "Center", false,
        (_e, cx) => { this.placing = "focus"; cx.notify(); }, "Back to the issue, at full size")))
      .child(this.iconButton("kata-graph-close", "close", "Close the graph",
        () => closeOverlay(props().overlay)));
  }

  renderGraph(cx) {
    const t = theme();
    const root = v_flex().id("root").size_full().min_h(0).overflow_hidden()
      .text_size(13).text_color(t.foreground).bg(t.background);
    const say = (text, color) => root.child(this.graphBar(cx, null))
      .child(div().flex_1().flex().items_center().justify_center().text_size(12).text_color(color ?? t.dim).child(text));
    if (this.gError) return say(this.gError, t.blocked);
    if (!this.gIssues) return say("Reading kata…");
    const spot = this.graph.uid;
    const focusIssue = spot ? this.gIssues.find((i) => i.uid === spot) : null;
    if (spot && !focusIssue) return say("That issue is not in this project's read.");
    const g = neighbourhood(this.gIssues, spot, this.depth, this.hideDone);
    if (!g.nodes.length) return say("No linked issues here.");
    const L = layout(g, spot);
    this.frame(L, spot ? L.pos.get(spot) : null);
    const z = this.vz;
    const w = NODE_W * z;
    const h = NODE_H * z;
    const v = this.vsize;
    // What is on screen: a card or a line wholly outside the viewport is not
    // built, so a big graph costs what is in view.
    const seen = (x0, y0, x1, y1) => !v || (x1 > -20 && y1 > -20 && x0 < v.width + 20 && y0 < v.height + 20);
    const at = (uid) => {
      const p = L.pos.get(uid);
      return { x: this.vx + p.x * z, y: this.vy + p.y * z };
    };
    const layer = (path, color, id) => window.paint_path(path, color).id(id).absolute().top(0).left(0).size_full();
    const lines = [];
    g.edges.forEach((e, k) => {
      const a = at(e.from);
      const b = at(e.to);
      if (!seen(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x) + w, Math.max(a.y, b.y) + h)) return;
      const { line, head } = edgePath(e, a, b, w, h, z);
      const color = e.kind === "blocks" ? t.blocked : t.dim;
      lines.push(layer(line, color, `kata-edge-${k}`));
      if (head) lines.push(layer(head, color, `kata-head-${k}`));
    });
    const cards = g.nodes.map((n) => [n, at(n.uid)])
      .filter(([, p]) => seen(p.x, p.y, p.x + w, p.y + h))
      .map(([n, p]) => this.graphCard(n, p, z, spot));
    const view = div().id("kata-graph-view").flex_1().min_h(0).relative().overflow_hidden()
      .on_size_change((size, cx) => {
        const first = !this.vsize;
        this.vsize = size;
        if (first) cx.notify();
      })
      .on_mouse_down("left", (e) => { this.dragFrom = e.position; this.dragged = false; })
      .on_mouse_up("left", () => { this.dragFrom = null; })
      .on_mouse_move((e, cx) => {
        if (!this.dragFrom) return;
        const dx = e.position.x - this.dragFrom.x;
        const dy = e.position.y - this.dragFrom.y;
        // A press that moved this far was a pan, so the card under its end is
        // not clicked.
        if (this.dragged || Math.hypot(dx, dy) > 4) this.dragged = true;
        else return;
        this.vx += dx;
        this.vy += dy;
        this.dragFrom = e.position;
        cx.notify();
      })
      // A trackpad's two-finger scroll pans; ctrl or cmd with the wheel (and a
      // pinch, which arrives as ctrl) zooms about the pointer.
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform) {
          const p = e.local_position ?? { x: (v?.width ?? 0) / 2, y: (v?.height ?? 0) / 2 };
          this.zoomAt(Math.exp(-e.delta.y / 200), p.x, p.y, cx);
        } else {
          this.vx -= e.delta.x;
          this.vy -= e.delta.y;
          cx.notify();
        }
      })
      .children(lines)
      .children(cards);
    const shown = g.nodes.length;
    return root.child(this.graphBar(cx, focusIssue))
      .child(view)
      .child(h_flex().h(26).flex_none().px(14).items_center().border_t(1).border_color(t.border)
        .child(div().text_size(10.5).text_color(t.dim).child(
          `${shown} issue${shown === 1 ? "" : "s"}${spot ? ` within ${this.depth} hop${this.depth > 1 ? "s" : ""}` : ""}`
          + `${g.over ? ` (${g.over} more not drawn)` : ""} — drag to pan, ctrl-scroll or pinch to zoom, click an issue to open it in the panel`)));
  }

  // ---- pieces ----

  iconButton(id, icon, tip, action, spin = false, on = false) {
    const t = theme();
    const glyph = svg(`${ICONS}/${icon}.svg`).size(14);
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
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

  // A project with no issues has no graph to open.
  nothingToShow() {
    return this.issues.length === 0 && !this.selected;
  }

  head(cx) {
    const t = theme();
    const name = this.resolved?.name ?? null;
    const guessed = this.resolved && this.resolved.bound === false;
    // Search and folding are the list's, so they are drawn where there is a list
    // to draw: not over a note, not behind an open issue (which takes the panel),
    // and no folding while a search has flattened the tree into results.
    const list = this.ready && !this.missing && this.issues.length > 0 && !this.selected;
    const foldable = list && !this.searching();
    return h_flex().id("kata-head").h(42).flex_none().px(14).gap(8).items_center()
      .border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Kata"))
      .when(Boolean(name), (el) => el
        .child(div().px(6).rounded(99).bg(t.raised).text_color(guessed ? t.dim : t.muted)
          .text_size(10.5).max_w(170).truncate().tooltip(guessed ? `No kata binding here: the git repo's name, ${name}` : "The bound kata project")
          .child(name)))
      .child(div().flex_1())
      .when(this.ready && !this.missing && !this.nothingToShow(), (el) => el
        .child(this.iconButton("kata-graph", "graph",
          this.selected ? "Show this issue's graph: what it hangs from, blocks and relates to"
            : "Show the graph of every linked issue in this project",
          () => this.openGraph(this.selected))))
      .when(list, (el) => el
        .child(this.iconButton("kata-search", "search",
          this.searchOpen ? "Close the search" : "Search the ids, titles and bodies in this list",
          (_e, cx) => this.toggleSearch(cx), false, this.searchOpen)))
      .when(foldable && this.collapsed.size > 0, (el) => el
        .child(this.iconButton("kata-fold", "unfold", "Expand all", (_e, cx) => this.toggleAll(cx))))
      .when(foldable && this.collapsed.size === 0, (el) => el
        .child(this.iconButton("kata-fold", "fold", "Collapse all", (_e, cx) => this.toggleAll(cx))))
      .child(this.iconButton("kata-refresh", "refresh", "Read the list again",
        (_e, cx) => { this.refresh(cx, true); this.save(); }, this.loading));
  }

  // Another status is another read. The pill above and the row an empty search
  // offers both come through here, so they cannot drift apart: another list is
  // another tree, and the trail behind the detail view was walked through rows
  // this read will not show.
  setStatus(value, cx) {
    if (this.status === value) return;
    this.status = value;
    this.trail = [];
    this.selected = null;
    this.branchOpen = false;
    this.save();
    this.read(cx);
  }

  // The filter row, under the header. Status is three pills; the branch filter is
  // one button that shows the branch it means, because a chip per branch does not
  // fit in a 368 px panel and a project can have a dozen.
  filters(cx) {
    const t = theme();
    const segment = ({ value, label }) => {
      const on = this.status === value;
      return div().id(`kata-status-${value}`).h(22).flex_none().px(9).rounded(99).flex().items_center()
        .text_size(11.5).cursor_pointer()
        .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.setStatus(value, cx))
        .child(label);
    };
    const chosen = this.chosen();
    const label = chosen === undefined ? "All branches" : chosen === null ? "No branch" : chosen;
    // The button says where its answer came from: the space's own branch, or a
    // pick of the person's, which is what they need to know to undo it.
    const picked = this.picked.has(this.key());
    const tip = picked
      ? "Your pick for this checkout — every branch is one click away"
      : chosen === undefined
        ? `Every branch: this space is on ${this.origin?.branch ?? "no checkout"}`
        : `This space's branch, ${chosen} — pick another branch here`;
    return h_flex().id("kata-filters").h(34).flex_none().px(12).gap(4).items_center()
      .border_b(1).border_color(t.border)
      .children(STATUSES.map(segment))
      .child(div().flex_1())
      .child(h_flex().id("kata-branch").h(22).flex_none().pl(7).pr(6).gap(5).rounded(6).max_w(190)
        .items_center().cursor_pointer()
        .when(this.branchOpen, (el) => el.bg(t.selected))
        .when(!this.branchOpen, (el) => el.hover((s) => s.bg(t.hover)))
        .tooltip(tip)
        .on_click((_e, cx) => { this.branchOpen = !this.branchOpen; cx.notify(); })
        .child(svg(`${ICONS}/branch.svg`).size(11).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11)
          .text_color(chosen === undefined ? t.dim : t.muted).child(label))
        .child(svg(`${ICONS}/chevron-down.svg`).size(10).flex_none().text_color(t.dim)));
  }

  // The branch filter, open: every branch the current status carries, with how
  // many tasks are on it. It stands in place of the tree rather than floating
  // over it — the panel is a tab, and nothing here needs a popup.
  chooser(cx) {
    const t = theme();
    const pick = (value, cx) => {
      // Kept for this checkout only: another branch's checkout is another answer.
      this.picked.set(this.key(), value);
      this.branchOpen = false;
      this.save();
      cx.notify();
      this.needParents(cx);
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
    const chosen = this.chosen();
    return v_flex().id("kata-branches").flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .child(row("kata-b-all", undefined, "All branches", this.issues.length, chosen === undefined))
      .children(branches.map(([name, count], i) =>
        row(`kata-b-${i}`, name, name, count, chosen === name)))
      .when(loose > 0, (el) => el.child(row("kata-b-none", null, "No branch", loose, chosen === null)));
  }

  // The field, under the filters: a magnifier that answers to the keyboard, the
  // input, and the × that empties it. The × is the one way to clear without the
  // keyboard — this panel registers no key handlers, so there is no Escape here
  // — and emptying the field puts the tree back.
  searchBar(cx) {
    const t = theme();
    return h_flex().id("kata-search").h(34).flex_none().px(12).gap(6).items_center()
      .border_b(1).border_color(t.border)
      .child(svg(`${ICONS}/search.svg`).size(12).flex_none()
        .text_color(this.searchTyping ? t.accent : t.dim))
      .child(div().flex_1().min_w(0).h_full().flex().items_center()
        .child(Input.new(this.searchInput).h_full().text_size(11.5).text_color(t.foreground)))
      .when(this.query.length > 0, (el) => el
        .child(div().id("kata-search-clear").size(18).flex_none().flex().items_center().justify_center()
          .rounded(4).text_size(13).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Empty the search")
          .on_click((_e, cx) => {
            this.query = "";
            this.searchInput.set_value("");
            this.searchInput.focus();
            cx.notify();
          })
          .child("×")));
  }

  // A row of the results: the same marker, ref, title and priority as a tree
  // row, and under a description hit the line of the description that matched —
  // without it a result that matched no visible word asks why it is here. No
  // chevron and no indent: results are a list, not a tree, and where an issue
  // sits is not what the person searched for.
  hitRow(i, hit, cx) {
    const t = theme();
    const blocked = this.isBlocked(i);
    const st = workState(t, i, blocked);
    const hint = hit === "body" ? snippet(i.body, this.queryQ()) : "";
    return h_flex().id(`kata-hit-${i.uid}`).flex_none().mx(6).px(8).py(4).gap(6).rounded(6)
      .items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(i.uid, cx))
      .child(i.closed
        ? svg(`${ICONS}/check-circle.svg`).size(11).flex_none().text_color(t.done)
        : div().w(11).flex_none().flex().items_center().justify_center()
          .tooltip(st.label).child(stateDot(t, st)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${i.ref}`))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12).text_color(i.closed ? t.muted : t.foreground)
          .child(i.title))
        .when(Boolean(hint), (el) => el
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(hint))))
      .when(i.priority != null, (el) => el
        .child(div().flex_none().text_size(10).text_color(priorityColor(t, i.priority)).child(`P${i.priority}`)));
  }

  // A search that found nothing, when another status could have had it: one
  // click reads every status and searches that instead — the same shortcut the
  // tree's empty state offers a branch. The unmatching pill above does the same
  // thing, but the person reading "nothing matches" is the one who should not
  // have to work out which pill would have found it.
  statusEscape(cx) {
    const t = theme();
    return h_flex().id("kata-search-all").h(24).flex_none().pr(8).gap(6).rounded(6).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip("Read every status — open and closed — and search that list")
      .on_click((_e, cx) => this.setStatus("all", cx))
      .child(svg(`${ICONS}/search.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
        .child("Search all statuses"));
  }

  // What the query found, in place of the tree: the matches that are the id or
  // the title, then the matches in the description, each group in work order. A
  // search narrows the same list the filters above it made, so the counts, the
  // empty state and the ceiling note are the same ones the tree would say — the
  // task the person is hunting is not declared gone, it is declared filtered.
  results(cx) {
    const t = theme();
    const q = this.queryQ();
    const found = this.matches(q);
    const total = found.names.length + found.bodies.length;
    const group = (label, count) => div().px(16).pt(6).pb(2).text_size(10).text_color(t.dim)
      .child(`${count} ${label}`);
    const note = this.footNote();
    return v_flex().id("kata-scroll").flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .when(total === 0, (el) => el.child(v_flex().px(16).py(14).gap(5)
        .child(div().text_size(12.5).text_color(t.muted).child(`Nothing matches "${this.query.trim()}"`))
        .child(div().text_size(11.5).text_color(t.dim).child(this.missLine()))
        .when(this.status !== "all", (el) => el.child(this.statusEscape(cx)))))
      .when(found.names.length > 0, (el) => el.child(group("in the id or title", found.names.length)))
      .children(found.names.map((i) => this.hitRow(i, "name", cx)))
      .when(found.bodies.length > 0, (el) => el.child(group("in the description", found.bodies.length)))
      .children(found.bodies.map((i) => this.hitRow(i, "body", cx)))
      .when(Boolean(note), (el) => el
        .child(div().px(16).pt(4).text_size(10.5).text_color(t.dim).child(note)))
      .when(this.truncated, (el) => el.child(this.moreButton(cx)));
  }

  row(entry, cx) {
    const t = theme();
    const i = entry.issue;
    const open = !this.collapsed.has(i.uid);
    const blocked = this.isBlocked(i);
    const st = workState(t, i, blocked);
    const step = Math.min(entry.depth, 8);
    // A context row is a parent the filters kept out of the list, drawn so the
    // task under it has something to hang from: quieter than a task of this
    // read, and saying why it is here when hovered.
    const quiet = entry.context || i.closed;
    return h_flex().id(`kata-row-${i.uid}`).h(26).flex_none().mx(6).pl(8 + step * 14).pr(8).gap(6)
      .rounded(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(i.uid, cx))
      .when(entry.context, (el) => el.tooltip(
        "The parent of a task in this list, kept so the tree reads whole"))
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
          .tooltip(st.label).child(stateDot(t, st)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${i.ref}`))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(quiet ? t.muted : t.foreground).child(i.title))
      .when(i.priority != null, (el) => el
        .child(div().flex_none().text_size(10).text_color(priorityColor(t, i.priority)).child(`P${i.priority}`)))
      .when(!open && entry.under > 0, (el) => el
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${entry.under}`)));
  }

  // What an empty tree says: which filter is hiding the work.
  emptyLine() {
    const scope = this.status === "all" ? "issues" : `${this.status} issues`;
    const chosen = this.chosen();
    if (chosen === undefined) return `No ${scope} in this project.`;
    if (chosen === null) return `No ${scope} without a branch.`;
    return `No ${scope} on ${chosen}.`;
  }

  tree(cx) {
    const t = theme();
    const rows = this.rows();
    const chosen = this.chosen();
    // An empty tree that a filter emptied offers the whole project in one click;
    // the default filter is a guess, and a guess must not look like an empty repo.
    const escape = chosen !== undefined && !this.picked.has(this.key())
      ? h_flex().id("kata-empty-escape").h(24).flex_none().pr(8).gap(6).rounded(6).items_center()
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.picked.set(this.key(), undefined); this.save(); cx.notify(); })
        .child(svg(`${ICONS}/branch.svg`).size(11).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
          .child("Every branch"))
      : null;
    const empty = v_flex().px(16).py(14).gap(5)
      .child(div().text_size(12.5).text_color(t.muted)
        .child(this.status === "closed" ? "Nothing closed yet" : "No issues here"))
      .child(div().text_size(11.5).text_color(t.dim).child(this.emptyLine()))
      .when(Boolean(escape), (el) => el.child(escape));
    // What the read is not showing, under it — and only that. A branch filter
    // hiding the other branches' tasks is hiding them on purpose, with every
    // task of the shown branch drawn, so a count of both populations only asks
    // where the rest went. A read that stopped at its ceiling is the one case
    // where a task of *this* branch may be missing, and that is what the line
    // and the button under it say.
    const note = this.footNote();
    return v_flex().id("kata-scroll").flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .when(rows.length === 0 && !this.loading, (el) => el.child(empty))
      .children(rows.map((e) => this.row(e, cx)))
      .when(Boolean(note), (el) => el
        .child(div().px(16).pt(4).text_size(10.5).text_color(t.dim).child(note)))
      .when(this.truncated, (el) => el.child(this.moreButton(cx)));
  }

  // Nothing is hidden, unless the read stopped at its ceiling: then the tasks
  // of the shown branch are drawn only as far as the ceiling reached, and the
  // line says so — about this branch, because that is the only thing the person
  // can do something about here.
  footNote() {
    if (!this.truncated) return "";
    const total = this.total;
    const read = total && total > this.issues.length
      ? `${this.issues.length} of ${total} in this project`
      : `More than the ${this.issues.length} rows read`;
    // A filter that fell back to every branch is not filtering, so it is not
    // something the unread rows could be hidden behind.
    const branch = this.fellBack() ? undefined : this.chosen();
    if (branch === undefined) return read;
    return `${read} — more may be ${branch === null ? "without a branch" : `on ${branch}`}`;
  }

  // The read stopped at its ceiling. One click reads the list again with a
  // bigger one; the rows on screen stay while it runs, so it is safe twice.
  moreButton(cx) {
    const t = theme();
    const next = bigger(this.ceiling);
    const tip = `The read stopped at ${this.ceiling} rows — ask for ${next === 0 ? "all of them" : `up to ${next}`}`;
    return h_flex().id("kata-more").h(24).flex_none().mx(6).mt(2).px(10).gap(6).rounded(6).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => this.loadMore(cx))
      .child(svg(`${ICONS}/chevron-down.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child("Load more"))
      .child(div().flex_1());
  }

  loadMore(cx) {
    this.read(cx, bigger(this.ceiling));
  }

  // One line of the detail: a label and its value, or the refs it points at.
  field(label, value, color) {
    const t = theme();
    return h_flex().gap(8).flex_none().items_center()
      .child(div().w(66).flex_none().text_size(11).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(color ?? t.muted).child(value));
  }

  // Refs to other issues, as chips: the ones in this read open, the rest are
  // text, because the panel only knows what one list told it. A ref the panel
  // knows by name reads like the parent chip — its ref and a title preview —
  // and opens; one it does not know is a bare ref until the fetch lands.
  refs(list, cx) {
    const t = theme();
    return h_flex().flex_wrap().gap(4)
      .children(list.map((r) => {
        const known = this.by(r.uid);
        const closed = r.status === "closed";
        const ink = closed ? t.dim : t.muted;
        return h_flex().id(`kata-ref-${r.uid}`).h(20).flex_none().max_w(220).px(6).gap(4).rounded(5).items_center()
          .bg(t.raised)
          .when(Boolean(known), (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
          .when(Boolean(known), (el) => el.on_click((_e, cx) => this.open(r.uid, cx)))
          .child(div().flex_none().text_size(10.5).text_color(ink).child(`#${r.ref}`))
          .when(Boolean(known), (el) => el.child(div().min_w(0).truncate()
            .text_size(10.5).text_color(ink).child(known.title)))
          .when(closed, (el) => el.child(svg(`${ICONS}/check-circle.svg`).size(9).flex_none().text_color(t.done)));
      }));
  }

  // Ref chips drawn as a field of the info block, the way Parent is: the label
  // in the column the other fields share, the chips beside it. The label tops
  // with the first chip and the row carries a little vertical padding, so a
  // group that wraps reads as one block and keeps its distance from the
  // groups above and below it.
  refField(label, list, cx) {
    const t = theme();
    return h_flex().gap(8).flex_none().items_start().py(2)
      // The label centers in the same 20 px the chip centers its own text in,
      // so the baselines meet without anyone counting pixels.
      .child(h_flex().w(66).flex_none().h(20).items_center()
        .child(div().text_size(11).text_color(t.dim).child(label)))
      .child(this.refs(list, cx));
  }

  // The way back, and the way out of the detail view. With a trail behind it,
  // the back button names the issue it returns to: a chain of refs is easy to
  // follow and hard to remember, so "back" has to say where it goes. The tree
  // keeps a button of its own beside it, which clears the trail however deep it
  // is. With nothing behind it, back *is* the tree, and one button says so
  // rather than offering the same step twice.
  nav(cx) {
    const t = theme();
    const came = this.cameFrom();
    const behind = this.trail.length > 1 ? ` (${this.trail.length - 1} more behind it)` : "";
    const back = h_flex().id("kata-back").h(28).flex_1().min_w(0).px(8).gap(4).rounded(6).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => (came ? this.back(cx) : this.dismiss(cx)))
      .child(svg(`${ICONS}/chevron-left.svg`).size(11).flex_none().text_color(t.dim))
      .when(Boolean(came), (el) => el
        .tooltip(`Back to #${came.ref} — ${came.title}${behind}`)
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`#${came.ref}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(came.title)))
      .when(!came, (el) => el
        .child(div().text_size(11.5).text_color(t.muted).child("All issues")));
    const home = h_flex().id("kata-all").h(28).flex_none().px(8).gap(4).rounded(6).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip("All issues: the whole tree, and the trail behind it cleared")
      .on_click((_e, cx) => this.dismiss(cx))
      .child(svg(`${ICONS}/icon.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child("All issues"));
    return h_flex().id("kata-nav").h(28).flex_none().mx(6).gap(2).items_center()
      .child(back)
      .when(Boolean(came), (el) => el.child(home));
  }

  detail(i, cx) {
    const t = theme();
    const parent = i.parent ? this.by(i.parent) : null;
    const kids = this.kids(i.uid);
    const back = h_flex().id("kata-back").h(28).flex_none().mx(6).px(8).gap(4).rounded(6).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.selected = null; this.save(); cx.notify(); })
      .child(svg(`${ICONS}/chevron-left.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(11.5).text_color(t.muted).child("All issues"));
    // The ref, what state it is in, and its priority: the three things that say
    // whether this is the issue the person meant.
    const st = workState(t, i, this.isBlocked(i));
    const state = h_flex().flex_none().px(5).gap(4).items_center().rounded(99).text_size(9.5)
      .bg(i.closed ? t.done : t.raised)
      .text_color(i.closed ? t.background : t.muted)
      .when(!i.closed, (el) => el.child(stateDot(t, st, 6)))
      .child(i.closed ? st.label : st.label.split(" — ")[0]);
    const top = h_flex().gap(6).items_center()
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${i.ref}`))
      .child(state)
      .when(i.priority != null, (el) => el.child(div().flex_none().text_size(10)
        .text_color(priorityColor(t, i.priority)).child(`P${i.priority}`)))
      .child(div().flex_1());
    const parentRow = parent
      ? h_flex().id("kata-parent").h(20).flex_none().px(6).rounded(5).bg(t.raised).items_center()
        .cursor_pointer().hover((s) => s.bg(t.selected))
        .on_click((_e, cx) => this.open(parent.uid, cx))
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
        .child(this.field("Children", kids.map((k) => `#${k.ref}`).join(", "))))
      .when(i.blockedBy.length > 0, (el) => el.child(this.refField("Blocked by", i.blockedBy, cx)))
      .when(i.blocks.length > 0, (el) => el.child(this.refField("Blocks", i.blocks, cx)))
      .when(i.related.length > 0, (el) => el.child(this.refField("Related", i.related, cx)))
      .children([this.metadata(i)].filter(Boolean));
    const body = v_flex().px(14).gap(5)
      .child(top)
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(i.title))
      .child(meta)
      // The description is kata's own markdown, drawn as markdown: it is where
      // the work, the plan and the requirements usually are.
      .child(div().pt(4).child(TextView.markdown(`kata-body-${i.uid}`, i.body || "_No description._")))
      .child(this.thread(i));
    return v_flex().id("kata-detail").w_full().flex_none().pb(16).child(this.nav(cx)).child(body);
  }

  render(cx) {
    if (this.graph) return this.renderGraph(cx);
    // The key may have changed hands since this copy last looked — a space
    // arrived at while this panel was showing — so every render takes in what
    // it does not recognize before drawing a thing.
    this.sync();
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
      .when(this.searchOpen, (el) => el.child(this.searchBar(cx)))
      // The default filter landed on a branch with nothing on it: say so, so an
      // unexpected list is not read as an empty project.
      .when(this.fellBack(), (el) => el
        .child(div().px(14).pt(6).text_size(11).text_color(t.dim).truncate()
          .child(`Nothing on ${this.chosen()} — showing every branch`)))
      // A read that failed while rows are on screen says so over them, rather
      // than taking the panel away from what the person is reading.
      .when(Boolean(this.failure), (el) => el
        .child(div().px(14).pt(6).text_size(11).text_color(t.blocked).truncate()
          .tooltip(this.failure.message).child(this.failure.message)))
      .when(!this.ready, (el) => el.child(this.note("Reading kata…", `Asking for ${this.status} issues.`, null)))
      .when(this.ready, (el) => el.child(this.branchOpen
        ? this.chooser(cx)
        : this.searching() ? this.results(cx) : this.tree(cx)));
  }
}
