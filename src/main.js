// Item capture, the unfinished list, and the one central timer.
//
// Time is never accumulated by counting ticks. A run records the moment it
// started; elapsed time is always computed from timestamps, so a throttled or
// backgrounded tab cannot lose time. The animation frame only repaints.
//
// Every mutation goes through render(), so persisting there is what makes the
// day survive a closed tab without each call site having to remember.

import { emptyState, load, save } from './storage.js';
import {
  formatClock,
  formatHuman,
  formatTimeOfDay,
  secondHandAngle,
  minuteHandAngle,
} from './time.js';

// The day view runs midnight to midnight at one pixel per minute, which keeps
// every height and offset calculation a plain minute count.
const DAY_START = 0;
const DAY_END = 24 * 60;
const SLOT = 30; // gridline spacing, and the labelled drop zones
const SNAP = 15; // finer than the gridlines so blocks can sit on quarter hours
const MIN_BLOCK_PX = 22; // a 3-minute block still has to be grabbable

const SVG_NS = 'http://www.w3.org/2000/svg';

let state = load();

// Whether the last write actually landed. Surfaced in the status bar rather
// than swallowed — silently failing to save a day is worse than saying so.
let storageOk = true;

// Which reset is awaiting confirmation: null, 'tasks', or 'assignments'.
// Two-step, so a stray click cannot erase a page's data.
let resetArmed = null;

const form = document.querySelector('[data-form="capture"]');
const nameInput = form.elements.name;
const hint = document.querySelector('[data-region="capture-hint"]');
const itemsRegion = document.querySelector('[data-region="items"]');
const statusRegion = document.querySelector('[data-region="status"]');
const timerItemRegion = document.querySelector('[data-region="timer-item"]');
const digitalRegion = document.querySelector('[data-region="digital"]');
const controlsRegion = document.querySelector('[data-region="controls"]');
const finishButton = document.querySelector('[data-action="finish"]');
const minuteHand = document.querySelector('[data-region="minute-hand"]');
const secondHand = document.querySelector('[data-region="second-hand"]');
const ticksGroup = document.querySelector('[data-region="ticks"]');
const logRegion = document.querySelector('[data-region="log"]');
const manualForm = document.querySelector('[data-form="manual"]');
const manualHint = document.querySelector('[data-region="manual-hint"]');
const totalTaskRegion = document.querySelector('[data-region="total-task"]');
const totalBreakRegion = document.querySelector('[data-region="total-break"]');
const calendarIntro = document.querySelector('[data-region="calendar-intro"]');
const calendarRegion = document.querySelector('[data-region="calendar"]');
const unscheduledRegion = document.querySelector('[data-region="unscheduled"]');
const timelineGrid = document.querySelector('[data-region="timeline-grid"]');
const timelineScroller = document.querySelector('.timeline');
const daySummaryRegion = document.querySelector('[data-region="daysummary"]');
const goalForm = document.querySelector('[data-form="goal"]');
const goalHint = document.querySelector('[data-region="goal-hint"]');
const goalsRegion = document.querySelector('[data-region="goals"]');
const analyzeButton = document.querySelector('[data-action="analyze"]');
const analyzeDateRegion = document.querySelector('[data-region="analyze-date"]');
const analysisStatusRegion = document.querySelector('[data-region="analysis-status"]');
const analysisRegion = document.querySelector('[data-region="analysis"]');
const assignmentForm = document.querySelector('[data-form="assignment"]');
const assignmentHint = document.querySelector('[data-region="assignment-hint"]');
const assignmentsRegion = document.querySelector('[data-region="assignments"]');
const assignmentsDoneRegion = document.querySelector('[data-region="assignments-done"]');
const assignmentTotalsRegion = document.querySelector('[data-region="assignment-totals"]');
const whenRegion = document.querySelector('[data-region="when"]');
const whenLabel = document.querySelector('[data-region="when-label"]');
const daySelect = document.querySelector('[data-region="day"]');
const monthSelect = document.querySelector('[data-region="month"]');
const timeField = document.querySelector('[data-region="time"]');
const descField = document.querySelector('[data-region="desc"]');
const assignmentsEmptyTpl = document.querySelector('[data-template="assignments-empty"]');
const resetZones = [...document.querySelectorAll('.reset-zone')];
const progressNameRegion = document.querySelector('[data-region="progress-name"]');
const progressBadgeRegion = document.querySelector('[data-region="progress-badge"]');
const progressWhenRegion = document.querySelector('[data-region="progress-when"]');
const noteField = document.querySelector('[data-region="progress-note"]');
const noteCount = document.querySelector('[data-region="note-count"]');
const progressFill = document.querySelector('[data-region="progress-fill"]');
const progressPercentRegion = document.querySelector('[data-region="progress-percent"]');
const modesRegion = document.querySelector('[data-region="modes"]');
const slider = document.querySelector('[data-region="slider"]');
const totalPointsField = document.querySelector('[data-region="total-points"]');
const pointsSummary = document.querySelector('[data-region="points-summary"]');
const subtaskForm = document.querySelector('[data-form="subtask"]');
const subtaskHint = document.querySelector('[data-region="subtask-hint"]');
const subtasksRegion = document.querySelector('[data-region="subtasks"]');
const boxCountField = document.querySelector('[data-region="box-count"]');
const boxesSummary = document.querySelector('[data-region="boxes-summary"]');
const boxesRegion = document.querySelector('[data-region="boxes"]');
const completeButton = document.querySelector('[data-action="complete-assignment"]');
const modePanels = {
  manual: document.querySelector('[data-region="mode-manual"]'),
  weighted: document.querySelector('[data-region="mode-weighted"]'),
  unweighted: document.querySelector('[data-region="mode-unweighted"]'),
};

/** Only write a value that actually changed, so typing is never interrupted. */
function setValue(el, value) {
  const next = String(value);
  if (el.value !== next) el.value = next;
}

// randomUUID needs a secure context. file:// qualifies in Chrome, but the
// standalone preview bundle should not break anywhere it does not.
const newId = () =>
  crypto.randomUUID?.() ??
  `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const selectedItem = () => state.items.find((i) => i.id === state.selectedId);

// --- persistence ----------------------------------------------------------

function persist() {
  storageOk = save(state);
}

/**
 * Closes a run that was still open when the tab went away.
 *
 * The run is credited only up to `savedAt` — the last moment the app is known
 * to have been alive — never up to now. Crediting to now would invent hours of
 * work for a tab that was closed overnight, which is the worst thing a time
 * tracker can do. A heartbeat keeps savedAt within a few seconds of the truth.
 */
function reconcileOpenRun() {
  if (state.runningSince === null) return;

  const endedAt = Math.max(state.runningSince, state.savedAt ?? state.runningSince);
  if (state.selectedId && endedAt > state.runningSince) {
    state.segments.push({
      id: newId(),
      itemId: state.selectedId,
      startedAt: state.runningSince,
      endedAt,
    });
  }
  state.runningSince = null;
}

// While the timer runs, nothing else triggers a write, so a crash would lose
// the whole stretch. This bounds that loss to a few seconds.
let heartbeat = null;

function syncHeartbeat() {
  const running = state.runningSince !== null;
  if (running && heartbeat === null) {
    heartbeat = setInterval(persist, 5000);
  } else if (!running && heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/** Everything the Tasks page owns. Assignments are deliberately untouched. */
function resetTasks() {
  const fresh = emptyState();

  state.items = fresh.items;
  state.segments = fresh.segments;
  state.log = fresh.log;
  state.selectedId = fresh.selectedId;
  state.runningSince = fresh.runningSince;
  state.placements = fresh.placements;
  state.calendarShown = fresh.calendarShown;
  state.goals = fresh.goals;
  state.analysis = fresh.analysis;

  analysisPending = false;
  analysisError = null;
}

/** Everything the Assignments page owns. Tasks are deliberately untouched. */
function resetAssignments() {
  state.assignments = emptyState().assignments;
}

const RESETS = { tasks: resetTasks, assignments: resetAssignments };

// --- time ----------------------------------------------------------------

/** Banked segments, plus the run in progress if this item owns it. */
function elapsedMs(itemId, now = Date.now()) {
  let total = 0;
  for (const seg of state.segments) {
    if (seg.itemId === itemId) total += seg.endedAt - seg.startedAt;
  }
  if (state.runningSince !== null && state.selectedId === itemId) {
    total += now - state.runningSince;
  }
  return total;
}

/** Closes the open run into a segment. Safe to call when nothing is running. */
function bankRunningSegment() {
  if (state.runningSince === null) return;
  const endedAt = Date.now();
  if (state.selectedId && endedAt > state.runningSince) {
    state.segments.push({
      id: newId(),
      itemId: state.selectedId,
      startedAt: state.runningSince,
      endedAt,
    });
  }
  state.runningSince = null;
}

// --- mutations -----------------------------------------------------------

function addItem(name, kind) {
  state.items.push({ id: newId(), name, kind, createdAt: Date.now() });
}

function selectItem(id) {
  if (id === state.selectedId) return;
  bankRunningSegment(); // switching banks the outgoing item's time
  state.selectedId = id; // never auto-starts the incoming item
}

function deleteItem(id) {
  // The item is going away, so its open run is discarded rather than banked.
  if (state.selectedId === id) state.runningSince = null;

  state.items = state.items.filter((item) => item.id !== id);
  state.segments = state.segments.filter((seg) => seg.itemId !== id);

  if (state.selectedId === id) state.selectedId = null;
}

function startTimer() {
  if (!state.selectedId || state.runningSince !== null) return;
  state.runningSince = Date.now();
}

function pauseTimer() {
  bankRunningSegment();
}

function resetTimer() {
  if (!state.selectedId) return;
  state.runningSince = null;
  state.segments = state.segments.filter((seg) => seg.itemId !== state.selectedId);
}

function finishItem() {
  const item = selectedItem();
  if (!item) return;

  bankRunningSegment(); // the final stretch counts

  // Segments are kept: they carry the timestamps the calendar and analysis
  // need, and the log entry's duration is derived from them.
  state.log.unshift({
    id: newId(),
    itemId: item.id,
    name: item.name,
    kind: item.kind,
    finishedAt: Date.now(),
  });

  state.items = state.items.filter((i) => i.id !== item.id);
  state.selectedId = null;
}

/**
 * A completed entry the user never timed. It gets a synthetic segment rather
 * than a duration field of its own, so duration stays derived from segments
 * for every entry alike. The segment is marked manual because its start and
 * end are assumed, not observed — the calendar should not read it as evidence
 * of when the work actually happened.
 */
function addManualEntry(name, kind, ms) {
  const itemId = newId();
  const endedAt = Date.now();

  state.segments.push({
    id: newId(),
    itemId,
    startedAt: endedAt - ms,
    endedAt,
    manual: true,
  });

  state.log.unshift({ id: newId(), itemId, name, kind, finishedAt: endedAt });
}

function deleteLogEntry(logId) {
  const entry = state.log.find((e) => e.id === logId);
  if (!entry) return;

  state.log = state.log.filter((e) => e.id !== logId);
  // Drop its segments too, or the time would linger with nothing pointing at it.
  state.segments = state.segments.filter((seg) => seg.itemId !== entry.itemId);
  delete state.placements[logId];
}

/** Placement only — the entry's segments, and so its duration, are untouched. */
function placeEntry(logId, startMinute) {
  const entry = state.log.find((e) => e.id === logId);
  if (!entry) return;

  const minutes = Math.round(elapsedMs(entry.itemId) / 60_000);
  const latest = Math.max(DAY_START, DAY_END - minutes);
  state.placements[logId] = Math.min(Math.max(startMinute, DAY_START), latest);
}

function unplaceEntry(logId) {
  delete state.placements[logId];
}

/** Summed from stored millisecond values, never parsed back from the display. */
function totalFor(kind) {
  return state.log
    .filter((entry) => entry.kind === kind)
    .reduce((sum, entry) => sum + elapsedMs(entry.itemId), 0);
}

// --- rendering -----------------------------------------------------------

function badge(kind) {
  const el = document.createElement('span');
  el.className = `badge badge-${kind}`;
  el.textContent = kind === 'break' ? 'Break' : 'Task';
  return el;
}

const CROSS = 'M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5';
const TICK = 'M3.6 8.4 6.6 11.4 12.4 4.9';

function strokeIcon(d) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('fill', 'none');

  svg.append(path);
  return svg;
}

const deleteIcon = () => strokeIcon(CROSS);
const checkIcon = () => strokeIcon(TICK);

function itemRow(item) {
  const li = document.createElement('li');
  li.className = item.id === state.selectedId ? 'item is-selected' : 'item';
  li.dataset.id = item.id;

  // The selectable area and the delete control are siblings, not nested, so a
  // click on delete can never fall through into selection.
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'item-select';
  select.setAttribute('aria-pressed', String(item.id === state.selectedId));

  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.name;
  name.title = item.name; // full text stays reachable when the row truncates

  select.append(name, badge(item.kind));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'item-delete';
  remove.setAttribute('aria-label', `Delete ${item.name}`);
  remove.append(deleteIcon());

  li.append(select, remove);
  return li;
}

function placeholder(text) {
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = text;
  return p;
}

function renderItems() {
  if (state.items.length === 0) {
    itemsRegion.replaceChildren(placeholder('No unfinished tasks yet.'));
  } else {
    const list = document.createElement('ul');
    list.className = 'items';
    list.append(...state.items.map(itemRow));
    itemsRegion.replaceChildren(list);
  }

  const n = state.items.length;
  const count = `${n} unfinished item${n === 1 ? '' : 's'}`;
  statusRegion.textContent = storageOk
    ? count
    : `${count} · not saved — this browser is blocking local storage`;
}

function logRow(entry) {
  const li = document.createElement('li');
  li.className = 'log-row';
  li.dataset.logId = entry.id;

  const name = document.createElement('span');
  name.className = 'log-name';
  name.textContent = entry.name;
  name.title = entry.name;

  const duration = document.createElement('span');
  duration.className = 'log-duration';
  duration.textContent = formatHuman(elapsedMs(entry.itemId));

  const done = document.createElement('span');
  done.className = 'log-done';
  done.textContent = 'Done';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'item-delete';
  remove.setAttribute('aria-label', `Delete ${entry.name} from the log`);
  remove.append(deleteIcon());

  li.append(name, badge(entry.kind), duration, done, remove);
  return li;
}

function renderLog() {
  if (state.log.length === 0) {
    logRegion.replaceChildren(placeholder('No completed tasks yet.'));
  } else {
    const list = document.createElement('ul');
    list.className = 'items';
    list.append(...state.log.map(logRow));
    logRegion.replaceChildren(list);
  }

  totalTaskRegion.textContent = formatHuman(totalFor('task'));
  totalBreakRegion.textContent = formatHuman(totalFor('break'));
}

// --- goals and analysis ---------------------------------------------------

// Transient, so it is not part of the fingerprint below.
let analysisPending = false;
let analysisError = null;

function addGoal(text) {
  state.goals.push({ id: newId(), text });
}

function deleteGoal(id) {
  state.goals = state.goals.filter((goal) => goal.id !== id);
}

/**
 * Everything an analysis depends on. Comparing this against the fingerprint
 * stored with an analysis is how a stale one is caught rather than presented
 * as though it still describes the current day.
 */
function analysisFingerprint() {
  return JSON.stringify({
    goals: state.goals.map((g) => g.text),
    log: state.log.map((e) => [e.id, e.name, e.kind, elapsedMs(e.itemId)]),
    placements: state.placements,
  });
}

/** Ordered stretches of real timing, used for the switching summary. */
function switchingNotes() {
  const logged = new Set(state.log.map((entry) => entry.itemId));
  const nameOf = new Map(state.log.map((entry) => [entry.itemId, entry.name]));

  const timed = state.segments
    .filter((seg) => logged.has(seg.itemId) && !seg.manual)
    .sort((a, b) => a.startedAt - b.startedAt);

  if (timed.length === 0) return [];

  let switches = 0;
  for (let i = 1; i < timed.length; i += 1) {
    if (timed[i].itemId !== timed[i - 1].itemId) switches += 1;
  }

  const stretches = new Map();
  for (const seg of timed) {
    stretches.set(seg.itemId, (stretches.get(seg.itemId) ?? 0) + 1);
  }

  const fragmented = [...stretches.entries()]
    .filter(([, count]) => count > 1)
    .map(([itemId, count]) => `${nameOf.get(itemId)} (${count} stretches)`);

  const longest = timed.reduce((a, b) =>
    b.endedAt - b.startedAt > a.endedAt - a.startedAt ? b : a,
  );

  const notes = [
    `- Timed work was recorded in ${timed.length} stretch${timed.length === 1 ? '' : 'es'} across ${stretches.size} item${stretches.size === 1 ? '' : 's'}.`,
    `- Times the user moved from one item to another mid-day: ${switches}`,
    `- Longest unbroken stretch: ${formatHuman(longest.endedAt - longest.startedAt)} on ${nameOf.get(longest.itemId)}`,
  ];

  notes.push(
    fragmented.length > 0
      ? `- Items worked in more than one stretch: ${fragmented.join(', ')}`
      : '- Every timed item was completed in a single unbroken stretch.',
  );

  return notes;
}

/** Only describes the calendar if the user actually arranged one. */
function calendarNotes() {
  const placed = state.log
    .filter((entry) => entry.id in state.placements)
    .map((entry) => ({
      entry,
      start: state.placements[entry.id],
      minutes: entryMinutes(entry),
    }))
    .sort((a, b) => a.start - b.start);

  if (!state.calendarShown || placed.length === 0) return [];

  const notes = [
    `- The user placed ${placed.length} of ${state.log.length} finished items on a day view.`,
  ];

  for (const { entry, start, minutes } of placed) {
    notes.push(
      `- ${formatTimeOfDay(start)} to ${formatTimeOfDay(start + minutes)} — ${entry.name} (${entry.kind})`,
    );
  }

  for (let i = 1; i < placed.length; i += 1) {
    const previousEnd = placed[i - 1].start + placed[i - 1].minutes;
    const gap = placed[i].start - previousEnd;
    if (gap > 0) {
      notes.push(
        `- Unaccounted gap of ${formatHuman(gap * 60_000)} between ${formatTimeOfDay(previousEnd)} and ${formatTimeOfDay(placed[i].start)}`,
      );
    }
  }

  const unplaced = state.log.filter((entry) => !(entry.id in state.placements));
  if (unplaced.length > 0) {
    notes.push(
      `- Finished but not placed, so their time of day is unknown: ${unplaced.map((e) => e.name).join(', ')}`,
    );
  }

  return notes;
}

/** Only what the app actually knows. Nothing here is inferred. */
function analysisPayload() {
  const taskMs = totalFor('task');
  const breakMs = totalFor('break');

  return {
    date: new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    goals: state.goals.map((goal) => goal.text),
    completed: state.log.map((entry) => {
      const start = state.placements[entry.id];
      return {
        name: entry.name,
        kind: entry.kind,
        duration: formatHuman(elapsedMs(entry.itemId)),
        scheduled:
          start === undefined
            ? null
            : `${formatTimeOfDay(start)} to ${formatTimeOfDay(start + entryMinutes(entry))}`,
        manual: state.segments.some((s) => s.itemId === entry.itemId && s.manual),
      };
    }),
    totals: {
      task: formatHuman(taskMs),
      break: formatHuman(breakMs),
      total: formatHuman(taskMs + breakMs),
      taskCount: state.log.filter((e) => e.kind === 'task').length,
      breakCount: state.log.filter((e) => e.kind === 'break').length,
    },
    switching: { notes: switchingNotes() },
    calendar: { notes: calendarNotes() },
  };
}

async function runAnalysis() {
  analysisPending = true;
  analysisError = null;
  render();

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(analysisPayload()),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      // A static deploy has no /api/analyze at all, so the host answers 404
      // (or 405 for a POST to a static path). That is the expected shape of a
      // deployed Tasky, not a fault worth showing as one.
      if (response.status === 404 || response.status === 405) {
        throw new Error(
          'Analysis only runs on the local server. Run python3 tools/serve.py and open localhost:8000 to use it.',
        );
      }
      throw new Error(body.error || `Request failed (${response.status}).`);
    }

    state.analysis = {
      sections: body.sections ?? [],
      generatedAt: Date.now(),
      goalCount: state.goals.length,
      fingerprint: analysisFingerprint(),
    };
  } catch (error) {
    // A file:// page has no server to call, which is the likeliest cause here.
    analysisError =
      location.protocol === 'file:'
        ? 'Analysis needs the local server. Run python3 tools/serve.py and open http://localhost:8000.'
        : error.message;
  } finally {
    analysisPending = false;
    render();
  }
}

function goalRow(goal) {
  const li = document.createElement('li');
  li.className = 'goal';

  const text = document.createElement('span');
  text.className = 'goal-text';
  text.textContent = goal.text;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'item-delete';
  remove.dataset.goalId = goal.id;
  remove.setAttribute('aria-label', `Delete goal: ${goal.text}`);
  remove.append(deleteIcon());

  li.append(text, remove);
  return li;
}

function renderGoals() {
  if (state.goals.length === 0) {
    goalsRegion.replaceChildren(
      placeholder('No goals yet — analysis will simply describe your day.'),
    );
    return;
  }

  const list = document.createElement('ul');
  list.className = 'goal-list';
  list.append(...state.goals.map(goalRow));
  goalsRegion.replaceChildren(list);
}

function analysisSection(section) {
  const block = document.createElement('section');
  block.className = 'analysis-section';

  const heading = document.createElement('h4');
  heading.className = 'analysis-heading';
  heading.textContent = section.heading;

  const points = document.createElement('ul');
  points.className = 'analysis-points';
  for (const point of section.points ?? []) {
    const li = document.createElement('li');
    li.textContent = point;
    points.append(li);
  }

  block.append(heading, points);
  return block;
}

function renderAnalysis() {
  renderGoals();

  analyzeButton.disabled = analysisPending;
  analyzeButton.textContent = analysisPending ? 'Analyzing…' : 'Analyze';
  analyzeDateRegion.textContent = new Date().toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
  });

  if (analysisPending) {
    analysisStatusRegion.textContent = 'Reading today’s data…';
    analysisStatusRegion.className = 'analysis-status';
  } else if (analysisError) {
    analysisStatusRegion.textContent = analysisError;
    analysisStatusRegion.className = 'analysis-status is-error';
  } else if (state.analysis && state.analysis.fingerprint !== analysisFingerprint()) {
    // Never let an old analysis pass as a description of changed data.
    analysisStatusRegion.textContent =
      'Your goals or activity have changed since this analysis. Run Analyze again for a current one.';
    analysisStatusRegion.className = 'analysis-status is-stale';
  } else {
    analysisStatusRegion.textContent = '';
    analysisStatusRegion.className = 'analysis-status';
  }

  if (!state.analysis) {
    analysisRegion.replaceChildren(
      placeholder(
        state.log.length === 0
          ? 'Finish something first, then press Analyze.'
          : 'Press Analyze for a read on your day.',
      ),
    );
    return;
  }

  analysisRegion.replaceChildren(...state.analysis.sections.map(analysisSection));
}

function renderReset() {
  for (const zone of resetZones) {
    const armed = resetArmed === zone.dataset.scope;
    zone.querySelector('[data-action="reset"]').hidden = armed;
    zone.querySelector('[data-region="reset-confirm"]').hidden = !armed;
  }
}

// --- calendar -------------------------------------------------------------

const entryMinutes = (entry) => Math.round(elapsedMs(entry.itemId) / 60_000);

// Held here rather than in dataTransfer, whose payload is unreadable during
// dragover — and we need the grab offset to keep a block under the cursor.
let dragging = null;

function startDrag(logId, grabOffsetMin) {
  return (event) => {
    dragging = { logId, grabOffsetMin };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', logId); // Firefox needs a payload
  };
}

function unscheduledChip(entry) {
  const chip = document.createElement('div');
  chip.className = `chip chip-${entry.kind}`;
  chip.draggable = true;
  chip.dataset.logId = entry.id;

  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = entry.name;
  name.title = entry.name;

  const duration = document.createElement('span');
  duration.className = 'chip-duration';
  duration.textContent = formatHuman(elapsedMs(entry.itemId));

  chip.append(name, badge(entry.kind), duration);
  chip.addEventListener('dragstart', startDrag(entry.id, 0));
  return chip;
}

function renderUnscheduled() {
  const pending = state.log.filter((entry) => !(entry.id in state.placements));

  if (pending.length === 0) {
    const done = document.createElement('p');
    done.className = 'placeholder';
    done.textContent = state.log.length === 0
      ? 'Finish something first.'
      : 'Everything is placed.';
    unscheduledRegion.replaceChildren(done);
    return;
  }

  unscheduledRegion.replaceChildren(...pending.map(unscheduledChip));
}

/** Gridlines and hour labels never change, so they are built once. */
function buildTimelineLines() {
  const lines = document.createElement('div');
  lines.className = 'timeline-lines';

  for (let minute = DAY_START; minute <= DAY_END; minute += SLOT) {
    const top = minute - DAY_START;

    const line = document.createElement('div');
    line.className = minute % 60 === 0 ? 'slot-line slot-hour' : 'slot-line';
    line.style.top = `${top}px`;
    lines.append(line);

    if (minute % 60 === 0) {
      const label = document.createElement('span');
      label.className = 'slot-label';
      label.style.top = `${top}px`;
      label.textContent = formatTimeOfDay(minute);
      lines.append(label);
    }
  }
  return lines;
}

function calendarBlock(entry, startMinute) {
  const minutes = entryMinutes(entry);
  const height = Math.max(minutes, MIN_BLOCK_PX);

  const block = document.createElement('div');
  block.className = `cal-block cal-${entry.kind}${height < 44 ? ' is-short' : ''}`;
  block.draggable = true;
  block.dataset.logId = entry.id;
  block.style.top = `${startMinute - DAY_START}px`;
  block.style.height = `${height}px`;
  block.title = `${entry.name} — ${formatHuman(elapsedMs(entry.itemId))}, from ${formatTimeOfDay(startMinute)}`;

  const name = document.createElement('span');
  name.className = 'cal-name';
  name.textContent = entry.name;

  const meta = document.createElement('span');
  meta.className = 'cal-meta';
  meta.textContent = `${formatHuman(elapsedMs(entry.itemId))} · ${entry.kind === 'break' ? 'Break' : 'Task'}`;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cal-remove';
  remove.dataset.unplace = entry.id;
  remove.setAttribute('aria-label', `Remove ${entry.name} from the calendar`);
  remove.textContent = '×';

  block.append(name, meta, remove);

  // Grabbing mid-block should not teleport its top edge to the cursor. Clamped
  // to the block: an offset from outside it would throw the drop far off.
  block.addEventListener('dragstart', (event) => {
    const grab = Math.min(Math.max(event.offsetY, 0), height);
    startDrag(entry.id, grab)(event);
  });

  return block;
}

function renderTimeline() {
  const blocks = document.createElement('div');
  blocks.className = 'timeline-blocks';

  for (const entry of state.log) {
    const start = state.placements[entry.id];
    if (start !== undefined) blocks.append(calendarBlock(entry, start));
  }

  timelineGrid.replaceChildren(buildTimelineLines(), blocks);
}

function renderDaySummary() {
  const taskMs = totalFor('task');
  const breakMs = totalFor('break');
  const set = (region, value) => {
    document.querySelector(`[data-region="${region}"]`).textContent = value;
  };

  set('stat-task-time', formatHuman(taskMs));
  set('stat-break-time', formatHuman(breakMs));
  set('stat-task-count', String(state.log.filter((e) => e.kind === 'task').length));
  set('stat-break-count', String(state.log.filter((e) => e.kind === 'break').length));
  set('stat-total', formatHuman(taskMs + breakMs));
}

function renderCalendar() {
  calendarIntro.hidden = state.calendarShown;
  calendarRegion.hidden = !state.calendarShown;
  daySummaryRegion.hidden = !state.calendarShown;

  if (!state.calendarShown) return;

  renderUnscheduled();
  renderTimeline();
  renderDaySummary();
}

function controlButton(label, action, variant) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${variant}`;
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

/** Rebuilt only on state change, never per frame — it would eat focus. */
function renderControls() {
  const item = selectedItem();

  if (!item) {
    const start = controlButton('Start', 'start', 'btn-primary');
    start.disabled = true;
    controlsRegion.replaceChildren(start);
    finishButton.disabled = true;
    return;
  }

  finishButton.disabled = false;

  if (state.runningSince !== null) {
    controlsRegion.replaceChildren(controlButton('Pause', 'pause', 'btn-primary'));
    return;
  }

  // Anything with time on the clock resumes rather than starts, which also
  // covers returning to an item timed earlier.
  if (elapsedMs(item.id) > 0) {
    controlsRegion.replaceChildren(
      controlButton('Continue', 'start', 'btn-primary'),
      controlButton('Reset', 'reset', 'btn-secondary'),
    );
    return;
  }

  controlsRegion.replaceChildren(controlButton('Start', 'start', 'btn-primary'));
}

function renderTimerItem() {
  const item = selectedItem();

  if (!item) {
    const empty = document.createElement('span');
    empty.className = 'timer-empty';
    empty.textContent = 'Select a task to begin';
    timerItemRegion.replaceChildren(empty);
    return;
  }

  const name = document.createElement('span');
  name.className = 'timer-name';
  name.textContent = item.name;
  name.title = item.name;

  timerItemRegion.replaceChildren(name, badge(item.kind));
}

/** The only thing that runs every frame: digital text and two hand angles. */
function paintTimer() {
  const ms = state.selectedId ? elapsedMs(state.selectedId) : 0;

  digitalRegion.textContent = formatClock(ms);
  minuteHand.setAttribute('transform', `rotate(${minuteHandAngle(ms)} 60 60)`);
  secondHand.setAttribute('transform', `rotate(${secondHandAngle(ms)} 60 60)`);
}

function render() {
  persist();

  renderItems();
  renderTimerItem();
  renderControls();
  renderLog();
  renderCalendar();
  renderAnalysis();
  renderAssignments();
  renderReset();
  renderPage();
  paintTimer();
  syncLoop();
  syncHeartbeat();
}

// --- animation -----------------------------------------------------------

let frame = null;

function syncLoop() {
  const shouldRun = state.runningSince !== null;
  if (shouldRun && frame === null) {
    frame = requestAnimationFrame(function step() {
      paintTimer();
      frame = requestAnimationFrame(step);
    });
  } else if (!shouldRun && frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
}

function buildTicks() {
  for (let i = 0; i < 12; i += 1) {
    const angle = (i * 30 * Math.PI) / 180;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);

    const tick = document.createElementNS(SVG_NS, 'line');
    tick.setAttribute('class', 'clock-tick');
    tick.setAttribute('x1', String(60 + sin * 44));
    tick.setAttribute('y1', String(60 - cos * 44));
    tick.setAttribute('x2', String(60 + sin * 49));
    tick.setAttribute('y2', String(60 - cos * 49));
    ticksGroup.append(tick);
  }
}

// --- feedback ------------------------------------------------------------

function showHint(message) {
  hint.textContent = message;
  nameInput.classList.add('is-invalid');
}

function clearHint() {
  hint.textContent = '';
  nameInput.classList.remove('is-invalid');
}

// --- events --------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();
  if (name === '') {
    showHint('Give the item a name first.');
    nameInput.focus();
    return;
  }

  addItem(name, form.elements.kind.value);

  // reset() clears the field and restores Task as the checked default.
  form.reset();
  clearHint();
  render();
  nameInput.focus();
});

nameInput.addEventListener('input', clearHint);

// Delegated, so rows rebuilt by render() need no listeners of their own.
// Delete is tested first: it wins over selection when both could match.
itemsRegion.addEventListener('click', (event) => {
  const row = event.target.closest('.item');
  if (!row) return;

  if (event.target.closest('.item-delete')) {
    deleteItem(row.dataset.id);
    render();
    return;
  }

  if (event.target.closest('.item-select')) {
    selectItem(row.dataset.id);
    render();
  }
});

logRegion.addEventListener('click', (event) => {
  const row = event.target.closest('.log-row');
  if (!row || !event.target.closest('.item-delete')) return;

  deleteLogEntry(row.dataset.logId);
  render();
});

manualForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const fields = manualForm.elements;
  const name = fields.name.value.trim();
  // Values are not clamped to 59: 90 minutes simply becomes 1 hr 30 min.
  const unit = (field) => Math.max(0, Math.floor(Number(fields[field].value) || 0));
  const ms = ((unit('hours') * 60 + unit('minutes')) * 60 + unit('seconds')) * 1000;

  if (name === '') {
    manualHint.textContent = 'Give the entry a name first.';
    fields.name.focus();
    return;
  }

  if (ms === 0) {
    manualHint.textContent = 'Add a duration in hours, minutes, or seconds.';
    fields.hours.focus();
    return;
  }

  addManualEntry(name, fields.kind.value, ms);

  manualForm.reset();
  manualHint.textContent = '';
  render();
  fields.name.focus();
});

manualForm.addEventListener('input', () => {
  manualHint.textContent = '';
});

controlsRegion.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;

  if (action === 'start') startTimer();
  else if (action === 'pause') pauseTimer();
  else if (action === 'reset') resetTimer();

  render();
});

finishButton.addEventListener('click', () => {
  finishItem();
  render();
});

document.querySelector('[data-action="generate"]').addEventListener('click', () => {
  state.calendarShown = true;
  render();

  // A full midnight-to-midnight day opens on hours nobody worked. Scroll once,
  // here rather than in render(), so it never fights the user's own scrolling.
  const placed = Object.values(state.placements);
  const focus = placed.length > 0 ? Math.min(...placed) : 7 * 60;
  timelineScroller.scrollTop = Math.max(0, focus - DAY_START - 30);
});

timelineGrid.addEventListener('dragover', (event) => {
  event.preventDefault(); // without this the drop never fires
  event.dataTransfer.dropEffect = 'move';
  timelineGrid.classList.add('is-dropping');
});

timelineGrid.addEventListener('dragleave', (event) => {
  if (!timelineGrid.contains(event.relatedTarget)) {
    timelineGrid.classList.remove('is-dropping');
  }
});

timelineGrid.addEventListener('drop', (event) => {
  event.preventDefault();
  timelineGrid.classList.remove('is-dropping');

  const logId = dragging?.logId ?? event.dataTransfer.getData('text/plain');
  if (!logId) return;

  // One pixel per minute, so the offset within the grid is already a minute
  // count. Subtract where the block was grabbed, then snap.
  const offset = event.clientY - timelineGrid.getBoundingClientRect().top;
  const raw = DAY_START + offset - (dragging?.grabOffsetMin ?? 0);

  placeEntry(logId, Math.round(raw / SNAP) * SNAP);
  dragging = null;
  render();
});

goalForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const text = goalForm.elements.text.value.trim();
  if (text === '') {
    goalHint.textContent = 'Describe the goal first.';
    goalForm.elements.text.focus();
    return;
  }

  addGoal(text);
  goalForm.reset();
  goalHint.textContent = '';
  render();
  goalForm.elements.text.focus();
});

goalForm.addEventListener('input', () => {
  goalHint.textContent = '';
});

goalsRegion.addEventListener('click', (event) => {
  const goalId = event.target.closest('[data-goal-id]')?.dataset.goalId;
  if (!goalId) return;

  // Deleting a goal only changes what the next analysis is told; recorded
  // activity is untouched.
  deleteGoal(goalId);
  render();
});

analyzeButton.addEventListener('click', () => {
  runAnalysis();
});

assignmentForm.addEventListener('change', (event) => {
  if (event.target.name === 'kind') renderAssignmentForm();
  if (event.target === monthSelect) buildDayOptions();
});

assignmentForm.addEventListener('input', () => {
  assignmentHint.textContent = '';
});

assignmentForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const fields = assignmentForm.elements;
  const name = fields.name.value.trim();
  const kind = fields.kind.value;

  if (name === '') {
    assignmentHint.textContent = 'Give it a name first.';
    fields.name.focus();
    return;
  }

  // A date is required for an assignment and an exam or event, and meaningless
  // for anything else. The blank first option is what makes "must input a
  // date" real — a pre-selected 1 January could be submitted without a thought.
  if (needsDate(kind) && (!daySelect.value || !monthSelect.value)) {
    assignmentHint.textContent =
      kind === 'assignment' ? 'Pick a deadline day and month.' : 'Pick a day and month.';
    (daySelect.value ? monthSelect : daySelect).focus();
    return;
  }

  addAssignment({
    name,
    kind,
    day: Number(daySelect.value),
    month: Number(monthSelect.value),
    time: fields.time.value.trim(),
    description: fields.description.value.trim(),
  });

  assignmentForm.reset();
  buildDayOptions(); // the reset month may allow a different number of days
  assignmentHint.textContent = '';
  render();
  fields.name.focus();
});

// One handler for both lists: complete is only ever offered on open rows.
function onAssignmentClick(event) {
  const completeId = event.target.closest('[data-complete-id]')?.dataset.completeId;
  if (completeId) {
    completeAssignment(completeId);
    render();
    return;
  }

  const deleteId = event.target.closest('[data-assignment-id]')?.dataset.assignmentId;
  if (deleteId) {
    deleteAssignment(deleteId);
    render();
  }
}

assignmentsRegion.addEventListener('click', onAssignmentClick);
assignmentsDoneRegion.addEventListener('click', onAssignmentClick);

// --- progress page events ---------------------------------------------------

noteField.addEventListener('input', () => {
  if (!progressEntry) return;
  progressOf(progressEntry).note = noteField.value.slice(0, NOTE_LIMIT);
  commitProgress();
});

slider.addEventListener('input', () => {
  if (!progressEntry) return;
  progressOf(progressEntry).manual = clampPercent(Number(slider.value));
  commitProgress();
});

modesRegion.addEventListener('change', (event) => {
  if (!progressEntry || event.target.name !== 'mode') return;
  // Switching keeps every mode's own work, so flipping back loses nothing.
  progressOf(progressEntry).mode = event.target.value;
  commitProgress();
});

totalPointsField.addEventListener('input', () => {
  if (!progressEntry) return;
  progressOf(progressEntry).total = Math.max(0, Math.floor(Number(totalPointsField.value) || 0));
  commitProgress();
});

subtaskForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!progressEntry) return;

  const fields = subtaskForm.elements;
  const name = fields.name.value.trim();
  const points = Math.max(0, Math.floor(Number(fields.points.value) || 0));

  if (name === '') {
    subtaskHint.textContent = 'Name the subtask first.';
    fields.name.focus();
    return;
  }
  if (points === 0) {
    subtaskHint.textContent = 'Give it a point value — that is what sets its weight.';
    fields.points.focus();
    return;
  }

  progressOf(progressEntry).subtasks.push({
    id: newId(),
    name: name.slice(0, NAME_LIMIT),
    points,
    done: false,
  });

  subtaskForm.reset();
  subtaskHint.textContent = '';
  commitProgress();
  fields.name.focus();
});

subtaskForm.addEventListener('input', () => {
  subtaskHint.textContent = '';
});

subtasksRegion.addEventListener('click', (event) => {
  if (!progressEntry) return;
  const p = progressOf(progressEntry);

  const removeId = event.target.closest('[data-remove-subtask]')?.dataset.removeSubtask;
  if (removeId) {
    p.subtasks = p.subtasks.filter((t) => t.id !== removeId);
    commitProgress();
    return;
  }

  const toggleId = event.target.dataset?.subtaskId;
  if (toggleId) {
    const task = p.subtasks.find((t) => t.id === toggleId);
    if (task) task.done = event.target.checked;
    commitProgress();
  }
});

boxCountField.addEventListener('input', () => {
  if (!progressEntry) return;
  const p = progressOf(progressEntry);

  p.count = Math.max(0, Math.min(MAX_BOXES, Math.floor(Number(boxCountField.value) || 0)));
  // Ticks are kept when the count grows or shrinks, so a mistyped number is
  // not destructive.
  p.checked = Array.from({ length: p.count }, (_, i) => Boolean(p.checked[i]));
  commitProgress();
});

boxesRegion.addEventListener('change', (event) => {
  if (!progressEntry) return;
  const index = event.target.dataset?.boxIndex;
  if (index === undefined) return;

  progressOf(progressEntry).checked[Number(index)] = event.target.checked;
  commitProgress();
});

document.querySelector('[data-action="back-to-assignments"]').addEventListener('click', () => {
  location.hash = '#assignments';
});

completeButton.addEventListener('click', () => {
  if (!progressEntry) return;

  // Completing leaves nothing to edit here, so it returns to the list where
  // the assignment now sits under Completed.
  completeAssignment(progressEntry.id);
  location.hash = '#assignments';
  render();
});

for (const zone of resetZones) {
  zone.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    const scope = zone.dataset.scope;
    if (action === 'reset') resetArmed = scope;
    else if (action === 'reset-cancel') resetArmed = null;
    else if (action === 'reset-confirm') {
      RESETS[scope]();
      resetArmed = null;
    }

    render();
  });
}

// Checkpoints, not state changes: they keep savedAt close to the truth so a
// run interrupted by a closed tab is credited accurately on the next load.
// Switching tabs must not pause a running timer, so neither of these banks.
addEventListener('pagehide', () => persist());
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persist();
});

timelineGrid.addEventListener('click', (event) => {
  const logId = event.target.closest('[data-unplace]')?.dataset.unplace;
  if (!logId) return;

  unplaceEntry(logId);
  render();
});

// --- assignments ----------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// February gets 29: without a year there is no way to rule out a leap day, and
// refusing a real date is worse than allowing one that needs the right year.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const KIND_LABELS = { assignment: 'Assignment', event: 'Exam / event', other: 'Other' };

// Open assignments are listed in this order — one list, grouped by type.
const KIND_ORDER = { assignment: 0, event: 1, other: 2 };

const DAY_MS = 86_400_000;
const REMINDER_WINDOWS = [1, 3, 7];

/** Midnight today, so day arithmetic is never thrown off by the time of day. */
const startOfToday = (now = new Date()) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate());

/**
 * A stored date carries no year, so it means the next time that day comes
 * round: this year if it is still ahead, otherwise next year.
 *
 * The month check catches 29 February in a non-leap year, where the Date
 * constructor would silently roll over to 1 March. Advancing a year at a time
 * finds the real next leap day instead, and the bound stops it looping.
 */
function nextOccurrence(entry, now = new Date()) {
  if (!entry.month) return null;

  const today = startOfToday(now);
  for (let year = now.getFullYear(); year <= now.getFullYear() + 8; year += 1) {
    const candidate = new Date(year, entry.month - 1, entry.day);
    if (candidate.getMonth() !== entry.month - 1) continue; // 29 Feb, not a leap year
    if (candidate >= today) return candidate;
  }
  return null;
}

/** Whole days from today. 0 is today, 1 tomorrow. */
function daysUntil(entry, now = new Date()) {
  const due = nextOccurrence(entry, now);
  return due === null ? null : Math.round((due - startOfToday(now)) / DAY_MS);
}

function dueLabel(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** A day/month as a sortable number: 14 March becomes 314. */
const dateKey = (entry) => (entry.month ? entry.month * 100 + entry.day : null);

/**
 * Type first, then soonest date, then name.
 *
 * There is no year in a date, so this orders within a calendar year: January
 * always sorts ahead of December. Undated entries sit after dated ones in the
 * same group, which in practice only affects Other, where nothing has a date
 * and the whole group falls through to alphabetical.
 */
function compareAssignments(a, b) {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;

  const dateA = dateKey(a);
  const dateB = dateKey(b);

  if (dateA !== dateB) {
    if (dateA === null) return 1;
    if (dateB === null) return -1;
    return dateA - dateB;
  }

  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/** Which kinds require a date. Other needs nothing. */
const needsDate = (kind) => kind === 'assignment' || kind === 'event';

function option(value, label) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}

function buildMonthOptions() {
  monthSelect.replaceChildren(
    option('', 'Month'),
    ...MONTHS.map((name, i) => option(String(i + 1), name)),
  );
}

/**
 * Day options track the chosen month, so 31 February is never offered rather
 * than being offered and then rejected.
 */
function buildDayOptions() {
  const month = Number(monthSelect.value);
  const count = month ? DAYS_IN_MONTH[month - 1] : 31;
  const chosen = daySelect.value;

  daySelect.replaceChildren(
    option('', 'Day'),
    ...Array.from({ length: count }, (_, i) => option(String(i + 1), String(i + 1))),
  );

  // Keep the day if it still exists in the new month; otherwise clear it.
  daySelect.value = chosen && Number(chosen) <= count ? chosen : '';
}

// Both capped the same way: maxlength stops the typing, the slice guards the
// data in case a value ever arrives from somewhere other than that input.
const NAME_LIMIT = 50;
const DESCRIPTION_LIMIT = 50;
const NOTE_LIMIT = 350;
const MAX_BOXES = 50;

/**
 * Progress lives on the assignment record. Flat rather than nested per mode:
 * each mode reads only its own fields, and switching modes keeps the other
 * modes' work rather than discarding it.
 */
function emptyProgress() {
  return {
    note: '',
    mode: 'manual',
    manual: 0,        // manual: the percentage itself
    total: 100,       // weighted: points that count as finished
    subtasks: [],     // weighted: { id, name, points, done }
    count: 0,         // unweighted: how many boxes
    checked: [],      // unweighted: one boolean per box
  };
}

/** Attached on first use, so existing assignments need no migration. */
function progressOf(entry) {
  entry.progress = { ...emptyProgress(), ...(entry.progress ?? {}) };
  return entry.progress;
}

const clampPercent = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** The one place a percentage is derived, whichever mode is in use. */
function percentOf(entry) {
  const p = entry.progress;
  if (!p) return 0;

  if (p.mode === 'weighted') {
    // Guard the divide: a total of zero means "not set up yet", not an error.
    if (!p.total) return 0;
    const earned = p.subtasks.reduce((sum, t) => sum + (t.done ? t.points : 0), 0);
    return clampPercent((earned / p.total) * 100);
  }

  if (p.mode === 'unweighted') {
    if (!p.count) return 0;
    const done = p.checked.slice(0, p.count).filter(Boolean).length;
    return clampPercent((done / p.count) * 100);
  }

  return clampPercent(p.manual);
}

function addAssignment({ name, kind, day, month, time, description }) {
  state.assignments.push({
    id: newId(),
    name: name.slice(0, NAME_LIMIT),
    kind,
    day: needsDate(kind) ? day : null,
    month: needsDate(kind) ? month : null,
    time: needsDate(kind) && time ? time : null,
    description:
      kind === 'other' && description ? description.slice(0, DESCRIPTION_LIMIT) : null,
    createdAt: Date.now(),
    completedAt: null,
  });
}

function deleteAssignment(id) {
  state.assignments = state.assignments.filter((a) => a.id !== id);
}

function completeAssignment(id) {
  const entry = state.assignments.find((a) => a.id === id);
  if (entry) entry.completedAt = Date.now();
}

const isDone = (entry) => Boolean(entry.completedAt);

const formatWhen = (entry) =>
  entry.month ? `${entry.day} ${MONTHS[entry.month - 1]}` : '';

/** Shows only the fields the chosen kind actually requires. */
function renderAssignmentForm() {
  const kind = assignmentForm.elements.kind.value;

  whenRegion.hidden = !needsDate(kind);
  timeField.hidden = !needsDate(kind);
  descField.hidden = kind !== 'other';
  whenLabel.textContent = kind === 'assignment' ? 'Due' : 'On';
}

function assignmentRow(entry) {
  const li = document.createElement('li');
  li.className = isDone(entry) ? 'assignment is-done' : 'assignment';
  li.dataset.kind = entry.kind;

  const name = document.createElement('span');
  name.className = 'assignment-title';
  name.textContent = entry.name;
  name.title = entry.name;

  const kind = document.createElement('span');
  kind.className = `badge badge-${entry.kind}`;
  kind.textContent = KIND_LABELS[entry.kind];

  li.append(name, kind);

  const when = formatWhen(entry);
  if (when) {
    const date = document.createElement('span');
    date.className = 'assignment-when';
    date.textContent = entry.kind === 'assignment' ? `Due ${when}` : when;
    li.append(date);
  }

  if (entry.description) {
    const desc = document.createElement('span');
    desc.className = 'assignment-desc-text';
    desc.textContent = entry.description;
    desc.title = entry.description;
    li.append(desc);
  }

  if (entry.time) {
    const time = document.createElement('span');
    time.className = 'assignment-time';
    time.textContent = entry.time;
    li.append(time);
  }

  const percent = percentOf(entry);
  if (!isDone(entry) && percent > 0) {
    const meter = document.createElement('span');
    meter.className = 'row-progress';
    meter.title = `${percent}% done`;

    const fill = document.createElement('span');
    fill.className = 'row-progress-fill';
    fill.style.width = `${percent}%`;

    const label = document.createElement('span');
    label.className = 'row-progress-label';
    label.textContent = `${percent}%`;

    meter.append(fill);
    li.append(meter, label);
  }

  // Only what is still open can be completed; both states can be deleted.
  if (!isDone(entry)) {
    const progress = document.createElement('a');
    progress.className = 'btn-progress';
    progress.href = `#progress/${entry.id}`;
    progress.textContent = 'Progress';
    li.append(progress);

    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'item-check';
    done.dataset.completeId = entry.id;
    done.setAttribute('aria-label', `Mark ${entry.name} complete`);
    done.append(checkIcon());
    li.append(done);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'item-delete';
  remove.dataset.assignmentId = entry.id;
  remove.setAttribute('aria-label', `Delete ${entry.name}`);
  remove.append(deleteIcon());
  li.append(remove);

  return li;
}

function assignmentList(entries) {
  const list = document.createElement('ul');
  list.className = 'assignment-list';
  list.append(...entries.map(assignmentRow));
  return list;
}

function totalTile(label, open, done, kind) {
  const tile = document.createElement('div');
  tile.className = 'asg-total';
  if (kind) tile.dataset.kind = kind;

  const heading = document.createElement('span');
  heading.className = 'asg-total-label';
  heading.textContent = label;

  const counts = document.createElement('span');
  counts.className = 'asg-total-counts';

  const openCount = document.createElement('strong');
  openCount.textContent = String(open);
  const doneCount = document.createElement('strong');
  doneCount.textContent = String(done);

  counts.append(openCount, document.createTextNode(' open · '),
                doneCount, document.createTextNode(' done'));

  tile.append(heading, counts);
  return tile;
}

function reminderRow(entry, days) {
  const li = document.createElement('li');
  li.className = 'reminder-item';
  li.dataset.kind = entry.kind;

  const name = document.createElement('a');
  name.className = 'reminder-name';
  name.href = `#progress/${entry.id}`;
  name.textContent = entry.name;
  name.title = entry.name;

  const kind = document.createElement('span');
  kind.className = `badge badge-${entry.kind}`;
  kind.textContent = KIND_LABELS[entry.kind];

  const when = document.createElement('span');
  when.className = 'reminder-when';
  when.textContent = `${formatWhen(entry)} · ${dueLabel(days)}`;

  li.append(name, kind, when);
  return li;
}

function renderReminders() {
  const now = new Date();

  // Only open, dated assignments can be due. Windows are cumulative, so
  // something due tomorrow shows up in all three.
  const dated = state.assignments
    .filter((a) => !isDone(a) && a.month)
    .map((a) => ({ entry: a, days: daysUntil(a, now) }))
    .filter(({ days }) => days !== null);

  for (const window of REMINDER_WINDOWS) {
    const due = dated
      .filter(({ days }) => days <= window)
      .sort((x, y) => x.days - y.days || x.entry.name.localeCompare(y.entry.name, undefined, { sensitivity: 'base' }));

    const countRegion = document.querySelector(`[data-region="count-${window}"]`);
    const listRegion = document.querySelector(`[data-region="list-${window}"]`);

    countRegion.textContent = due.length === 0
      ? 'None'
      : `${due.length} due`;
    countRegion.classList.toggle('is-none', due.length === 0);

    if (due.length === 0) {
      listRegion.replaceChildren(placeholder('Nothing due in this window.'));
      continue;
    }

    const list = document.createElement('ul');
    list.className = 'reminder-list';
    list.append(...due.map(({ entry, days }) => reminderRow(entry, days)));
    listRegion.replaceChildren(list);
  }
}

function renderAssignmentTotals() {
  const of = (kind) => state.assignments.filter((a) => a.kind === kind);
  const open = (list) => list.filter((a) => !isDone(a)).length;
  const done = (list) => list.filter(isDone).length;

  const all = state.assignments;
  const totals = document.createElement('div');
  totals.className = 'asg-total-grid';

  totals.append(
    totalTile('Assignments', open(of('assignment')), done(of('assignment')), 'assignment'),
    totalTile('Exams / events', open(of('event')), done(of('event')), 'event'),
    totalTile('Other', open(of('other')), done(of('other')), 'other'),
  );

  const overall = totalTile('All', open(all), done(all));
  overall.classList.add('is-strong');
  totals.append(overall);

  assignmentTotalsRegion.replaceChildren(totals);
}

function renderAssignments() {
  renderAssignmentForm();

  // filter() already copies, so sorting here never reorders stored state.
  const openItems = state.assignments.filter((a) => !isDone(a)).sort(compareAssignments);
  const doneItems = state.assignments
    .filter(isDone)
    .sort((a, b) => b.completedAt - a.completedAt);

  assignmentsRegion.replaceChildren(
    openItems.length === 0
      ? assignmentsEmptyTpl.content.cloneNode(true)
      : assignmentList(openItems),
  );

  assignmentsDoneRegion.replaceChildren(
    doneItems.length === 0
      ? placeholder('Nothing completed yet.')
      : assignmentList(doneItems),
  );

  renderAssignmentTotals();
  renderReminders();
}

// --- the progress page ------------------------------------------------------

// Which assignment the progress page is showing. Derived from the hash on
// every route, so it can never point at something that has been deleted.
let progressEntry = null;

function subtaskRow(entry, task) {
  const p = entry.progress;
  const li = document.createElement('li');
  li.className = task.done ? 'subtask is-done' : 'subtask';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'subtask-box';
  box.checked = task.done;
  box.dataset.subtaskId = task.id;
  box.setAttribute('aria-label', `Mark ${task.name} done`);

  const name = document.createElement('span');
  name.className = 'subtask-name';
  name.textContent = task.name;
  name.title = task.name;

  const points = document.createElement('span');
  points.className = 'subtask-points';
  points.textContent = `${task.points} pt${task.points === 1 ? '' : 's'}`;

  const weight = document.createElement('span');
  weight.className = 'subtask-weight';
  weight.textContent = p.total ? `${Math.round((task.points / p.total) * 100)}%` : '—';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'item-delete';
  remove.dataset.removeSubtask = task.id;
  remove.setAttribute('aria-label', `Remove ${task.name}`);
  remove.append(deleteIcon());

  li.append(box, name, points, weight, remove);
  return li;
}

function renderSubtasks(entry) {
  const p = entry.progress;

  if (p.subtasks.length === 0) {
    subtasksRegion.replaceChildren(
      placeholder('No subtasks yet. Add one above with the points it is worth.'),
    );
  } else {
    const list = document.createElement('ul');
    list.className = 'subtask-list';
    list.append(...p.subtasks.map((task) => subtaskRow(entry, task)));
    subtasksRegion.replaceChildren(list);
  }

  const listed = p.subtasks.reduce((sum, t) => sum + t.points, 0);
  const earned = p.subtasks.reduce((sum, t) => sum + (t.done ? t.points : 0), 0);
  pointsSummary.textContent = p.total
    ? `${earned} of ${p.total} earned · ${listed} listed`
    : 'Set a total above for the weights to mean anything.';
}

function renderBoxes(entry) {
  const p = entry.progress;

  if (p.count === 0) {
    boxesRegion.replaceChildren(placeholder('Choose how many subtasks there are.'));
    boxesSummary.textContent = '';
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'box-grid';

  for (let i = 0; i < p.count; i += 1) {
    const label = document.createElement('label');
    label.className = 'box';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(p.checked[i]);
    box.dataset.boxIndex = String(i);
    box.setAttribute('aria-label', `Subtask ${i + 1}`);

    const num = document.createElement('span');
    num.textContent = String(i + 1);

    label.append(box, num);
    wrap.append(label);
  }

  boxesRegion.replaceChildren(wrap);

  const done = p.checked.slice(0, p.count).filter(Boolean).length;
  boxesSummary.textContent =
    `${done} of ${p.count} ticked · ${Math.round(100 / p.count)}% each`;
}

function renderProgress() {
  const entry = progressEntry;
  if (!entry) return;

  const p = progressOf(entry);

  progressNameRegion.textContent = entry.name;
  progressBadgeRegion.className = `badge badge-${entry.kind}`;
  progressBadgeRegion.textContent = KIND_LABELS[entry.kind];

  const when = formatWhen(entry);
  progressWhenRegion.textContent = when
    ? (entry.kind === 'assignment' ? `Due ${when}` : when)
    : '';

  setValue(noteField, p.note);
  noteCount.textContent = String(p.note.length);

  const percent = percentOf(entry);
  progressFill.style.width = `${percent}%`;
  progressPercentRegion.textContent = `${percent}%`;

  // Offered only once the work is actually finished.
  completeButton.hidden = percent < 100;

  for (const radio of modesRegion.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === p.mode;
  }
  for (const [mode, panel] of Object.entries(modePanels)) {
    panel.hidden = mode !== p.mode;
  }

  setValue(slider, p.manual);
  setValue(totalPointsField, p.total);
  setValue(boxCountField, p.count);

  renderSubtasks(entry);
  renderBoxes(entry);
}

/** A progress edit changes no structure elsewhere, so it saves and repaints. */
function commitProgress() {
  persist();
  renderProgress();
}

// --- pages ----------------------------------------------------------------

// The hash is the source of truth for which page is showing, so back, forward,
// refresh, and bookmarking all work without any state of our own. Switching is
// a view change rather than a page load, which is the point: a page load would
// run reconcileOpenRun() and silently pause a running timer every time you
// looked at another page.
const PAGES = ['tasks', 'assignments', 'progress'];
const PAGE_TITLES = { tasks: 'My Tasks', assignments: 'My Assignments', progress: 'Progress' };

// Progress is a sub-page of Assignments, so that tab stays lit while on it.
const TAB_FOR = { tasks: 'tasks', assignments: 'assignments', progress: 'assignments' };

const pageEls = [...document.querySelectorAll('.page')];
const tabEls = [...document.querySelectorAll('.tab')];

/**
 * `#progress/<id>` carries which assignment it is showing. Resolving the id
 * here means a link to a deleted assignment falls back to the list instead of
 * rendering a page about nothing.
 */
function currentPage() {
  const [name, param] = location.hash.replace(/^#\/?/, '').split('/');

  if (name === 'progress') {
    progressEntry = state.assignments.find((a) => a.id === param) ?? null;
    return progressEntry ? 'progress' : 'assignments';
  }

  progressEntry = null;
  return PAGES.includes(name) ? name : 'tasks';
}

function renderPage() {
  const page = currentPage();

  for (const el of pageEls) el.hidden = el.dataset.page !== page;

  for (const tab of tabEls) {
    const active = tab.dataset.page === TAB_FOR[page];
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  document.title = `${PAGE_TITLES[page]} \u00b7 Tasky`;

  if (page === 'progress') renderProgress();
}

// A full render, not just renderPage: leaving the progress page has to rebuild
// the assignments list so the row reflects the progress just edited.
addEventListener('hashchange', render);

reconcileOpenRun();
buildTicks();
buildMonthOptions();
buildDayOptions();
render(); // renderPage() runs inside it
