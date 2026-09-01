# Tasky

A personal productivity workspace. It replaces tracking your day in a spreadsheet:
enter what you're working on, run one timer against it, finish it into a log, and
review where the time actually went.

## What it is, and is not

Built for one person tracking their own day — students, freelancers, remote
workers. It is **not** team software. There are no assignees, no projects, no
sharing, no permissions. If a feature only makes sense with a second user, it
does not belong here.

Priorities, in order: **convenience, clarity, low friction, minimal scrolling,
minimal tab switching, friendly design, simple architecture.**

The benchmark for any interaction is a spreadsheet row. If it takes more effort
than typing a row, it is losing to the tool it replaces.

## The core loop

Create an item → select it → run the timer → switch or pause freely → finish it
into the log → review the day → get analysis.

- Every item is labelled either **task** or **break**. Same record, different
  `kind`. A break is timed exactly like a task.
- **Exactly one item is selected at a time**, and the single central timer always
  belongs to the selected item.
- Switching items banks the current item's time and moves the timer. Nothing is
  lost, and two items can never run at once.

## Data model

State lives in `localStorage` under one key. Shape:

```js
{
  version: 1,
  items:    [{ id, name, kind: 'task' | 'break', createdAt }],
  segments: [{ id, itemId, startedAt, endedAt }],
  log:      [{ id, itemId, name, kind, finishedAt }],
  selectedId: null,
  runningSince: null,
}
```

**Segments are the source of truth for time.** An item's duration is the sum of
its segments — never a stored counter kept alongside them. Two reasons:

1. A cached total can drift out of sync with reality; a derived one cannot.
2. The AI analysis has to explain *switching patterns*, and the calendar has to
   place work at a *time of day*. Both need to know when each stretch happened.
   Storing only a total destroys that information at write time, permanently.

Timing rule: **never accumulate time by counting interval ticks.** Intervals
drift and browsers throttle them in background tabs. Store `startedAt`, and
compute elapsed as `now - startedAt` plus banked segments. The animation frame
exists only to trigger a repaint.

### Timer state

`runningSince` is the whole timer state — a timestamp when running, `null` when
not. There is no separate `isRunning` flag and no per-item timer, which is what
makes "only one item can run at once" true by construction rather than by
enforcement. The run always belongs to `selectedId`.

Starting sets `runningSince`. Pausing, switching, and finishing all **bank** the
open run into a segment and clear it. Deleting the selected item discards the
open run instead, along with that item's segments — a deleted item never
happened. Reset drops the selected item's segments and leaves it selected.

The controls follow from state, not from a mode variable: running shows Pause;
not running with time on the clock shows Continue and Reset; not running with a
clean slate shows Start. That third case is why returning to an item timed
earlier correctly offers Continue.

Finishing keeps the item's segments — they carry the timestamps the calendar
and analysis need — and the log entry stores identity only, with its duration
derived from those segments at render time.

A manually added completed entry gets a **synthetic segment** ending at the
moment it was added, rather than a duration field of its own, so every entry's
duration derives the same way. Those segments carry `manual: true`, because
their start and end are assumed rather than observed — the calendar and the
switching analysis must not read them as evidence of when work actually
happened. Deleting a log entry deletes its segments too.

Day totals sum stored milliseconds per `kind` and are never parsed back out of
formatted strings.

### Persistence

Every mutation already goes through `render()`, so `render()` writes. That is
what makes a closed tab survivable without each call site having to remember,
and it means there is exactly one place persistence can be forgotten.

**An interrupted run is credited only up to `savedAt`** — the last moment the
app is known to have been alive — never up to now. A tab closed overnight
mid-run must not come back claiming eight hours of work; inventing tracked time
is the worst thing this app could do. `pagehide` and `visibilitychange` keep
`savedAt` current, and a 5-second heartbeat while the timer runs bounds what a
crash can lose. Neither lifecycle handler banks the run, because switching tabs
must not pause a running timer.

The timer therefore always returns **paused** after a reload, with the time up
to the interruption preserved.

A failed write is surfaced in the status bar rather than swallowed. A stored
state missing newer fields is filled from `emptyState()`, and a corrupt entry
boots clean instead of failing to start.

**Reset tracked data** at the foot of the page wipes everything. It is two-step
rather than a modal — the project has no modals — because it cannot be undone.

### Calendar

`placements` maps a **log entry id to a start minute of the day**, and that is
the whole calendar model. It is deliberately separate from `segments`: dragging
a block is the user saying *when* something happened, and must never edit *how
long* it took. Nothing in the drag path touches a segment.

The day view runs midnight to midnight at **one pixel per minute**, which is why
every offset in the code is a plain minute count and needs no scale conversion.
Gridlines sit every 30 minutes; drops snap to 15. Block height is the duration
in minutes, floored at `MIN_BLOCK_PX` so a 40-second item is still grabbable —
the one place height stops being proportional.

The analog clock shows position within the current 60-minute cycle: the second
hand from `ms % 60000`, the minute hand from `ms % 3600000`. Both wrap on their
own, which is why no hour hand is needed. The digital readout is the authority
on total elapsed time.

## Pages

Two pages — **My Tasks** (everything built so far) and **My Assignments**
(empty, being built) — as tabs in the top bar.

They are **views in one document, switched on the hash**, not separate HTML
files. That is a deliberate constraint, not a shortcut: every page load runs
`reconcileOpenRun()`, so with separate files, clicking to another page and back
would bank the open run and silently pause a running timer. Keeping one
document alive means navigation costs nothing.

`location.hash` is the only source of truth for the current page — no state of
our own — so back, forward, refresh, and bookmarking work for free. An
unrecognised hash falls back to Tasks. Add a page by adding a
`<div class="page" data-page="...">`, a matching `.tab`, and an entry in
`PAGES` / `PAGE_TITLES`.

### Assignments

`assignments` is its own list in state — `{ id, name, kind, day, month, time }`
— deliberately apart from `items` and `log`. An assignment is something with a
date, not something you run a timer against, and nothing on this page touches
segments or the timer.

The form is progressive: the type chosen decides which fields exist. An
**assignment** needs a day and month (labelled *Due*), an **exam / event** needs
a day and month (labelled *On*) plus an optional free-text time, and **other**
needs neither and stores nulls for all three.

Two details that carry the "must input a date" requirement. The day and month
selects each open with a blank option, so a date has to be chosen rather than
inherited from a pre-selected 1 January. And the day options are rebuilt from
the chosen month, so 31 February is never offered instead of being offered and
then rejected — February keeps 29 days, since without a year a leap day cannot
be ruled out and refusing a real date is worse than allowing one that needs the
right year.

Time is free text on purpose ("9am", "period 3", "after lunch"), because a
picker would demand precision the user may not have.

### Per-page theming

Assignments is **neon cyan**; Tasks stays warm orange. This is done by
redefining the palette tokens scoped to `.page[data-page="assignments"]` — not
by writing cyan rules. Every component inside the page picks the new palette up
on its own, so anything built there later is themed with no extra work, and
there is no second copy of any component's styles to keep in sync.

The header sits **outside** any page container, so the tiger, the wordmark, and
the tabs keep the warm palette on both pages by construction rather than by
exception.

Two notes for whoever extends it. The `--yellow-*` tokens are named for the
warm theme that introduced them; their actual role is "the other category
colour", and on Assignments they are magenta. And `--glow` only exists inside
the cyan scope — it is what makes the theme read as neon rather than as plain
teal.

**Reset tracked data lives inside the Tasks page**, where the data it erases
lives. Revisit once Assignments has its own data.

## Layout contract

```
┌─ work zone — fills the screen, never scrolls ────────┐
│  task input          │                               │
│  unfinished list     │   timer            [ 📌 pin ] │
├─ scroll down ────────────────────────────────────────┤
│  completed log                                       │
│  calendar & daily summary                            │
│  AI analysis, advice                                 │
└──────────────────────────────────────────────────────┘
```

The rule: **the working surface never scrolls, the reviewing surface does.**
Scrolling to look back at your day is fine. Scrolling to do the work is not.

The timer is not sticky by default. A pin button makes its column sticky so it
stays visible while you scroll the review zone — which is why the pinned timer
is always a **side**, never a top or bottom bar. The pin is a saved preference
and must survive a reload.

## Stack

Plain HTML, CSS, and ES modules. **No framework, no bundler, no dependencies,
no build step.** Node and npm are not installed on this machine and nothing here
needs them.

Run it:

```bash
python3 tools/serve.py
```

Then open <http://localhost:8000>. There is no build step. The server is stdlib
only and sends `Cache-Control: no-store`, because `SimpleHTTPRequestHandler`
otherwise lets browsers hold on to edited modules across a reload.

### The one exception to "no dependencies"

AI analysis is the only feature that cannot be static: an API key must never
ship in client-side code. `tools/serve.py` therefore serves the files **and**
exposes `POST /api/analyze`, which is the only place the key is read:

```bash
pip3 install anthropic          # server-side only; the web app stays dependency-free
export ANTHROPIC_API_KEY=sk-ant-...
python3 tools/serve.py
```

Both are optional. Without them the whole app still runs and only the Analyze
button reports that analysis is unavailable. The key is read from the
environment by the SDK, is never written to a file, and never reaches the
browser.

### Reviewing progress

Brian reviews each step by opening a file in Chrome, so **after every change,
regenerate the standalone bundle and hand it to him**:

```bash
python3 tools/build_preview.py
```

That writes `preview.html` — the stylesheet and the whole module graph inlined
into one file with no external references, so it opens straight from `file://`.
`index.html` cannot be double-clicked: Chrome blocks ES modules over `file://`
and the app would render but never run.

`preview.html` is generated and gitignored. It is a snapshot for review, never
an input — nothing imports it, and edits belong in `index.html` and `src/`.

Add a dependency only when it solves a problem that has actually appeared. Same
for abstractions: write the direct version first.

## Deploying

Vercel serves this repo as a **static site with no build**, configured by
`vercel.json`. `.vercelignore` keeps `tools/`, `CLAUDE.md`, and the generated
`preview.html` off the deployment — nothing dev-only should be downloadable
from the deployed site.

**Analysis deliberately does not work when deployed.** `tools/serve.py` is a
long-running process; Vercel runs static files and functions in `api/`, so
`POST /api/analyze` has nothing behind it. The client treats a 404 or 405 from
that endpoint as the expected shape of a deployed Tasky and says analysis only
runs locally, rather than reporting a fault. Any other status still surfaces
its real error.

This is a security decision as much as a scoping one. The repo is public and a
Vercel URL is public and unauthenticated, so a working `/api/analyze` there
would be an open proxy to the API key — anyone who found the URL could spend
it. Porting analysis to a Vercel function needs auth or a rate limit first.

Everything else works deployed: the timer, log, calendar, goals, and
`localStorage` persistence. Storage is per-origin, so the deployed site starts
empty rather than showing localhost's data.

## Conventions

- `src/storage.js` is the only module that touches `localStorage`. Accounts and a
  backend come later; when they do, that file changes and nothing else has to.
- Render from state. Do not read values back out of the DOM, and do not keep a
  second copy of anything that can be derived.
- Colour, spacing, and radius come from the custom properties in `styles.css`.
  No hard-coded hex values in new rules.
- Durations have **two formats**, both in `src/time.js`, both truncating and
  never rounding up:
  - `formatClock` — the live timer readout, counting like a stopwatch: `MM:SS`
    below an hour, `HH:MM:SS` from an hour onward. Nothing resets at the
    boundary.
  - `formatHuman` — completed durations and totals, spelled out: `2 hrs 15 min
    30 sec`. Zero-value units are omitted **anywhere** in the string, so an hour
    and five seconds reads `2 hrs 5 sec` with the empty minutes skipped. Exactly
    zero reads `0 sec`. Only the hour unit pluralises (`1 hr` / `2 hrs`); `min`
    and `sec` never change.

## MVP boundaries

In scope: item capture and deletion, task/break labelling, the selectable list,
the single timer with start/pause/resume/stop/finish, switching without time
loss, the completed log, date-based review with a calendar summary, AI analysis,
and reminders.

Out of scope for the MVP, deliberately: accounts and auth, sync across devices,
CSV import or export, teams and sharing, recurring tasks, subtasks, tags, and
project grouping.

Deferred but expected: **accounts and sync.** Storage stays behind one module so this
does not become a rewrite.

### Analysis

`goals` is a plain list of free text, stored apart from activity. A goal is
context for the analysis and nothing else — it never changes a task, a timer,
or a calendar block, and deleting one leaves recorded activity untouched.

The prompt lives in `tools/serve.py`, and its rules matter as much as the code:
the model is given the app's already-computed durations and totals and told not
to recompute them, is told that missing calendar placement means the time of
day is **unknown** rather than guessable, and is told to say
"Not enough recorded information today to evaluate this goal" rather than
stretch. Manual log entries are passed through flagged, so their assumed timing
is never read as observed. Analysis is recommendation-heavy when goals exist and
descriptive when they don't; it never invents a goal.

Output comes back through a JSON schema (`output_config.format`) as headed
sections of short points, so it renders with `textContent` — model output is
never parsed as markup.

A stored analysis carries a **fingerprint** of the goals, log, and placements it
was generated from. When the current data no longer matches, the UI says so
instead of letting a stale reading pass as current.

Decide these with Brian; do not settle them unilaterally.

- **`stop` vs `pause`** — the spec lists both. Their behaviours are not yet
  distinguished.
- **The mascot** — whether it reacts to state (working, paused, on a break, day
  finished). Cheap to design in now, awkward to retrofit.
- **Phone support** — whether Tasky must work on a narrow screen. The work zone
  currently stacks and is allowed to scroll below 760px, as a placeholder.
- **AI hosting** — an API key cannot ship in client-side code, so the analysis
  will eventually need a small serverless endpoint. This is the one thing that
  breaks the "purely static" property.
