# Kata

A Kata tab in the tab bar: a **Kata** button beside Files and Changes opens a
tab in the side panel that shows the space's kata issues as a tree — the work
that is open, which task belongs under which, and a detail view per issue — with
a status filter, a branch filter, and foldable parents.

Read-only by design. It reads `kata list --json` and nothing else: no claim, no
close, no comment, no `kata show`, and no writes anywhere. It is a window onto
the same list `kata tui` shows, sized the way a 368 px side panel can take it.

The branch filter follows the checkout. A space on the repo's own branch
(`main`, or whatever `origin/HEAD` says) is not about one branch, so every task
shows; a space on any other branch — a worktree, a topic checkout — shows the
tasks recorded on that branch, which is the work being done there. A pick in the
branch filter wins over that default for that checkout, and
`data/kata/settings.json` can turn the default off or make it strict.

![Kata in the tab bar](preview.png)

```
Kata  [paparazzi]                        ⤢ ↻
[Open] [Closed] [All]        [ All branches ▾ ]
────────────────────────────────────────────────
▾ #jfqz  Recording robustness defects          P3
   ● #wvb0  Overlay layer paints below the …   P3
   ● #ybxy  Callout placement clamps to the …  P3
▸ #54b1  Video-editor ideas: research backlog  P4 +5
```

## The contract

It is an ordinary tab-host contributor: the whole registration is one field in
`mod.json`, and tab-host draws the button, adds this mod's block to the side
panel's stack, and keeps its width fitted.

```json
{
  "place": "none",
  "title": "Kata",
  "tab": { "title": "Kata", "icon": "mods/kata/icon.svg" }
}
```

`place: "none"` keeps Herdr from docking a copy anywhere by itself; tab-host's
stack is the only place it shows. Nothing here imports from tab-host and
nothing breaks without it — but with `place: "none"` the mod shows nowhere on
its own, so the second door is a pane:

```sh
herdr-app do pane.split '{"direction":"right","mod":"kata"}'
```

The same panel draws beside the terminals then, resolving the project from that
pane's tab. A key can reach the tab without one:

```json
"cmd-alt-shift-k": "tab-host.toggle:kata"
```

That is tab-host's own command (`tab-host.toggle:<mod>`), which does what the
button does — show the panel on this tab, or hide it again. This mod binds
nothing: a hidden tab's copy is asleep, which is exactly when a key would be
pressed.

## Which project it shows

The space's, resolved in three steps, and the panel shows which one it landed
on:

1. **The `kata.toml` binding at or above the folder the space's focused pane is
   in.** This is kata's own answer, so `kata tui` in that terminal shows the
   same issues. The search walks up to twelve levels, which is what makes a
   space sitting in a subfolder of its repo work.
2. **A project named after the repo.** With no binding above the folder, the
   name comes from the folder's `origin` remote — `git@github.com:posit-dev/shinychat.git`
   and `https://github.com/posit-dev/shinychat` both give `shinychat` — else
   from the folder's own name. That project has to exist in `kata projects
   list`; when it does, the panel passes `--project <name>` and the chip is
   dimmed, because the name is a guess that happened to be right.
3. **Nothing.** A space with no kata project gets a placeholder and the command
   that would bind it: `kata init --project <repo>`. No filters, no tree, no
   empty box that looks broken.

A space on another machine (`remy`, `vps/…`) is resolved and read on that
machine (`exec(…, {on: space.machine})`), so a remote checkout's issues show the
same way — and a machine without `kata` installed says so instead of showing
another machine's work.

The folder is the *focused pane's* live folder, falling back to where the space
was made; so `cd`-ing a terminal moves the panel to the project you are in. The
space changing, or that folder changing, is noticed once a second by reading
`spaces()`/`focused()` — no redraw unless it actually moved.

## The read

One command per refresh:

```sh
kata list --status <open|closed|all> --limit 400 --json
```

- `--status` is the filter itself, not a post-filter, so the 400-row cap is
  spent on the rows being shown. 400 is the ceiling: the whole list arrives as
  one JSON document through `exec` (8 MiB of stdout), and a big project's
  closed issues are the part that could fill it. The status filter is how the
  rest is reached.
- `--project <name>` only in case 2 above; a bound project runs without it, the
  way kata itself resolves one.
- Each issue is normalized on arrival to what the panel draws: ref, title,
  body, status, owner, author, priority, labels, `work.branch`, `parent`,
  timestamps, and its `blocks`/`blocked_by`/`related` refs.
- A refusal is shown as kata wrote it — `kata` prints `{error: {message, hint}}`
  on stderr, so "no .kata.toml ancestor and no git ancestor" arrives with the
  `kata init --project` hint that fixes it.

There is no file to watch (issues change from terminals, agents and the CLI), so
the panel re-reads on a **15 s timer** — `kata tui`'s own pace — and on the ↻
button, which also forgets which project the place is, so `kata init` shows up
on a click instead of on the next space change. Rows stay on screen while a
read runs and after one fails: an error is a line above them, never an empty
panel.

## What you see

The panel is a card of its own in the side panel — 368 px wide in the person's
layout, the width Files and Changes get — rounded 10, `background` fill, a 1 px
`border`, at 13 px in `foreground`.

**Header**, 42 px, 14 px side padding, a 1 px bottom border:

- "Kata", 13 px semibold, then the project's name on a `raised` chip (10.5 px,
  fully rounded, 6 px side padding, at most 170 px, ellipsis). `muted` when kata
  itself would find the project; `dim` when the name was guessed from the repo,
  with a tooltip that says which.
- Two 24 px icon buttons at the right, 14 px glyphs in `muted`, `foreground` on
  `hover`, each with a tooltip: **fold/unfold all** (one button for both — with
  anything folded it unfolds; with everything open it folds every parent) and
  **↻**, which turns while a read is in flight (`.spin(900)`, drawn by GPUI, no
  timer of ours).

**Filter row**, 34 px, a 1 px bottom border:

- Three pills, 22 px, rounded fully, 11.5 px: **Open**, **Closed**, **All**.
  The chosen one is filled `selected` in `foreground`; the others are `muted`
  and fill `hover`. A pick re-reads with that status and closes the detail view.
- On the right, the **branch filter**: a 22 px rounded-6 button with a branch
  glyph, the branch it means ("All branches" in `dim` when it means every
  branch), and a chevron. It is filled `selected` while its list is open.
  Clicking it opens the branch list; it does not float, it replaces the tree — a
  panel with one scroll area stays one scroll area.

### The branch filter, and the default it starts on

It opens on the checkout's own answer, not on "everything":

- **The branch is the space's, live from Herdr** (`panes()[…].branch`, else the
  space's), so a `git checkout` is noticed within a second without running
  anything, and nothing has to poll `git`.
- **On the repo's own branch, every task shows.** The trunk is what
  `origin/HEAD` names, falling back to `main`/`master`/`trunk` when the clone
  does not record it. A checkout of `main` is not about one branch, so scoping
  it would hide the work.
- **On any other branch, that branch's tasks show** — a worktree or a topic
  checkout is about that branch, and the tasks recorded on it (`work.branch`
  metadata) are the ones being worked there.
- **A default that matches nothing falls back to every branch**, with a line
  above the tree: `Nothing on feat/explainer-skill — showing every branch`. Work
  recorded under another name should not open as an empty panel, and the line
  keeps the fallback from looking like an empty project.
- **A pick is the person's, and it is kept**: picking a branch or "All
  branches" in the list overrides the default for that checkout, and is kept
  even when it matches nothing (the empty tree offers "Every branch" in one
  click). Picks are keyed by folder *and* branch, so checking out another branch
  offers the default again instead of an old branch's filter.

`data/kata/settings.json` sets what the default is — one key, no UI:

```json
{ "branchFilter": "auto" }
```

- `auto` (the default, and what a missing or broken file means): as above.
- `all`: never filter by branch; a checkout does not change the list.
- `branch`: always filter by the space's branch, even on the trunk, and never
  fall back — an empty tree then means an empty branch.

The file is this machine's and is re-read on every refresh, so an edit lands
within 15 seconds with no button to press.

**The branch list** (while it is open): 26 px rows, 6 px side margins, 10 px
padding, rounded 6, `hover` fill, the name at 12 px `muted` and its task count
at 10.5 px `dim` on the right. "All branches" first (with the whole read's
count), then every branch the current status has, most tasks first, then "No
branch" for the tasks whose metadata has none. Picking one closes the list.
Branches come from each issue's `work.branch` metadata — the key kata's own
examples use — and hand-quoted values (`"feat/x"`) count as the same branch as
the unquoted ones. A branch the next read no longer has falls back to all
branches rather than to an empty tree.

**The tree**, one scroll area, 26 px rows, 6 px side margins, rounded 6, `hover`
fill:

- Indented 8 px + 14 px per level (up to 8 levels), then a 14 px chevron on a
  row that has children (a button of its own: clicking it folds, clicking the
  row opens), then a marker, the `#ref` at 11 px in `dim`, the title, and the
  priority.
- The marker is a filled circle at 6 px: `ansi3` (amber) when an open issue
  blocks something open, else `dim`. A closed issue gets a `done`-green
  check-circle instead, and its title turns `muted`.
- The title truncates; if it is the row's only content, the row is still
  clickable edge to edge.
- The priority chip (`P0`…`P4`) is 10 px, `ansi1` for P0/P1, `ansi3` for P2,
  `dim` above that — the queue's own emphasis.
- A folded row carries `+N`, N being every task under it, not just its children.
- Siblings sort by work order: open before closed, then priority (unset last),
  then most recently updated. A child whose parent the filter dropped is drawn
  as a root: the alternative is a row nobody can reach.
- With a branch filter hiding some of the read, a line under the tree says `N of
  M on this branch filter`, so nothing looks missing without a reason.
- An empty read says so in the panel's own words ("No issues here", "Nothing
  closed yet", the filter the sentence is about) rather than drawing nothing,
  and a filter the panel guessed offers "Every branch" as a row in that space.

**The detail view** — a row's click — takes the whole panel, under a 28 px nav
row with the two ways out of it:

- **`‹ #ref title`** — back one step along the trail, naming the issue it
  returns to. A chain of refs is easy to follow and hard to remember, so back
  says where it goes, and its tooltip adds how many steps are behind that one
  (`#wvb0 Overlay layer paints below the …`, `Back to #wvb0 — Overlay layer
  paints below the terminal (1 more behind it)`). On the first issue opened
  from the tree there is nothing behind it, so the same button reads `‹ All
  issues` and shows the tree: a "back" that goes where "all issues" goes is one
  button, not two.
- **`☑ All issues`**, at the right, drawn only when there is a trail: the whole
  tree, with the trail behind it cleared however deep it was. Its 11 px glyph is
  the tab's own list icon.

- `#ref`, a status chip (`open`, or the close reason — `done`, `duplicate`…, on
  a `done` fill), and the priority.
- The title, semibold at 13.5 px, wrapping.
- Owner, author (when they differ), branch, labels, how long ago it changed,
  the parent as a chip that opens it (when the parent is in this read), and the
  refs of its children.
- The description as **markdown**, kata's own body, rendered by `TextView`
  (`gpui-base`): kata bodies are plans and requirements, and they read as text,
  not as an escaped string.
- Blocks / Blocked by / Related as wrapping chips. A ref that is in the current
  read opens; the rest are text, in `dim` when the issue is closed, because the
  panel only knows what one list told it.

**The placeholder** for a space with no kata project is the header and one
centred note: "No kata project here", the folder, and `kata init --project
<repo>`. A read that could not happen — no `kata` on that machine, the daemon
down — is the same note with kata's own message, and the ↻ above it retries.

## How it behaves

- **Nothing is polled from Herdr.** Spaces, focus, panes and the theme come from
  `spaces()`, `focused()` and `panes()`, and Herdr re-renders the mod when they
  change. The one-second timer reads the space's folder only to notice a `cd`;
  it redraws nothing unless the answer changed.
- **One read at a time.** Every read takes a generation number and an older
  answer that lands late is dropped, so a status click during a slow read
  cannot paint the old filter's rows under the new filter's buttons.
- **Nothing is remembered once the place moves.** Rows, folds, the open issue
  and the trail behind it all belong to the space they came from; switching
  space, or `cd`-ing to another repo, starts clean. State that survives a
  *re-read* of the same place (folds, an open issue, the branch picks) stays,
  which is what makes the 15 s refresh invisible; an open issue that the new
  read no longer has closes back to the tree.
- **The trail is the issues, not a browser history.** Following a ref chip or
  the parent chip is one step further in; opening a row in the tree starts a
  new trail at that row, which is why the tree is always where an empty trail
  ends. `‹` walks the steps one at a time, `All issues` clears them. A status
  pick, a moved place and the ↻ button all forget the trail, and a read that no
  longer has an issue drops that step: the panel never offers a step it cannot
  take.
- **A checkout is a filter change, not a read.** The 1 s timer reads the space's
  folder, machine and branch from Herdr and does nothing at all unless one of
  them moved; a moved folder re-reads, a moved branch only redraws.
- **The tab is alive once opened.** tab-host keeps a block's copy while its
  block is in the stack, shown or hidden, so after the first click the 15 s
  read keeps running with the panel collapsed — opening the panel again shows a
  list that is already fresh.
- **Read-only, deliberately.** There is no claim, close, comment or edit here,
  and no `kata show`: everything on the detail view comes from the list the
  panel already read. Adding writes would need a claim flow, an actor, and a
  confirmation for the destructive ones; that is a different mod, and a person
  can do all of it from `kata tui` in a terminal.
- **It never steals the keyboard.** The panel takes no focus handle: no key
  down handlers, no `focusable`, so clicking it does not pull keys out of the
  terminal. Everything is a click.

## Installing

The mod lives with its project, and installing it is one thing: a real
directory in Herdr's mods folder (Herdr does not run mods behind a symlink), so
the install is a copy:

```sh
rsync -rlpt --delete ~/play/gadenbuie/herdr-mod-kata/mods/kata/ \
      ~/.config/herdr-app/mods/kata/
herdr-app check ~/.config/herdr-app/mods/kata
```

tab-host watches `mods/`, so the button and the panel appear the moment the
copy lands, and both go when the folder does. Nothing to wire, no layout to
edit: the wiring is tab-host's, and it belongs to it.

## Verification

```sh
herdr-app check ~/.config/herdr-app/mods/kata   # passes
```

Live, in this Herdr, on `work` (a personal, wired layout):

- **A space with a kata project.** A space on `~/work/posit-dev/paparazzi`
  (bound `.kata.toml`, checked out on `feat/explainer-skill`) resolves to
  `paparazzi` with an undimmed chip, opens with that branch in the filter
  button, and — because no task in that read is recorded on it — says `Nothing
  on feat/explainer-skill — showing every branch` and draws all 23 open issues:
  `#jfqz` and `#54b1` fold and unfold, their children indent, `+N` counts every
  task under a folded parent, priorities read `P1`–`P4`, and closed issues
  (under **Closed**) come with green checks and `muted` titles.
- **`branchFilter: "branch"`** in `data/kata/settings.json` turns the fallback
  off within one refresh: the same space then draws the branch filter's empty
  state (`No open issues on feat/explainer-skill.`) with the "Every branch" row
  that clears it.
- **A bigger project.** `~/work/posit-dev/shinychat` (84 open / 442 closed)
  draws three levels of nesting and the branch filter lists its branches with
  counts — `feat/history-exchange-tree` at 55, `feat/page-chat` at 42.
- **The detail view.** Opening `#jfqz` shows its ref, `open`, `P3`, its author,
  labels, age, `#wvb0, #ybxy` as children, and its description as rendered
  markdown. Following a ref chip to another issue swaps the nav row's `‹ All
  issues` for `‹ #jfqz Recording robustness defects` and adds `All issues` at the
  right; `‹` walks back one issue at a time, naming each, and returns to `‹ All
  issues` at the start of the trail, while `All issues` reaches the tree in one
  click from any depth.
- **A space with no kata project** (`~/play/gadenbuie/herdr-mod-plannotator`)
  shows the placeholder naming the folder and `kata init --project
  herdr-mod-plannotator`.
- **A space on another machine** (`remy`, whose checkout is not a kata
  workspace and has no `kata` installed) shows "Kata cannot be read here" with
  kata's own message, not another machine's issues.

## Files

- `mods/kata/main.js` — one `View`, one screen: the place (`placeOf`,
  `refresh`, `read`), the project resolution (`tomlProject`, `repoName`,
  `resolveProject`), the branch default (`trunkBranch`, `branchMode`,
  `automatic`, `isTrunk`, `key`, `chosen`, `fellBack`), the list model
  (`filtered`, `branches`, `rows`), the trail between issues (`open`, `back`,
  `dismiss`, `cameFrom`, `nav`), and the drawing (`head`, `filters`, `chooser`,
  `tree`, `row`, `detail`, `render`). No state lives outside the copy.
- `mods/kata/mod.json` — the contract, verbatim.
- `mods/kata/icon.svg` — the tab bar's glyph, a list with two checks;
  `chevron-*.svg`, `fold.svg`, `unfold.svg`, `refresh.svg`, `branch.svg`,
  `check-circle.svg` are the panel's own icons, all one-color so they tint with
  the theme.
- `mods/kata/gpui-kit.d.ts`, `jsconfig.json` — the app's own type file (rewritten
  by Herdr on every start; this copy is the editor's) and the settings that make
  it resolve `gpui-kit`/`gpui-base`/`herdr` without turning the runtime's shape
  into type errors.

## Limits

- **400 rows per status.** A project with more than 400 issues in one status
  shows the 400 most recently updated; the filters, not scrolling, are how the
  rest is reached.
- **`work.branch` is a convention, not a kata field.** Issues that carry their
  branch under another key show under "No branch", and the branch default cannot
  see them — which is why a default that matches nothing falls back to every
  branch rather than opening empty.
- **The tree is what the list knows.** A child whose parent falls outside the
  read is drawn as a root, and refs to issues outside the read are text, not
  links.
- **No keyboard.** The panel is click-only (and hover), on purpose: it never
  takes focus from the terminal it was opened from.
- **One list, no comments.** The detail view is the issue, not its thread;
  comments are `kata show`'s, and this mod does not ask.
