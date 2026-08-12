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

The analog clock shows position within the current 60-minute cycle: the second
hand from `ms % 60000`, the minute hand from `ms % 3600000`. Both wrap on their
own, which is why no hour hand is needed. The digital readout is the authority
on total elapsed time.

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
python3 -m http.server 8000
```

Then open <http://localhost:8000>. There is no other build or start command.

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

Deferred but expected: **accounts.** Storage stays behind one module so this
does not become a rewrite.

## Open questions

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
