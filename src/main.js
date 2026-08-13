// Item capture, the unfinished list, and the one central timer.
//
// Time is never accumulated by counting ticks. A run records the moment it
// started; elapsed time is always computed from timestamps, so a throttled or
// backgrounded tab cannot lose time. The animation frame only repaints.
//
// Persistence, the calendar, AI, and reminders are later milestones.

import { emptyState } from './storage.js';
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

const state = emptyState();

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

// randomUUID needs a secure context. file:// qualifies in Chrome, but the
// standalone preview bundle should not break anywhere it does not.
const newId = () =>
  crypto.randomUUID?.() ??
  `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const selectedItem = () => state.items.find((i) => i.id === state.selectedId);

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

function deleteIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', CROSS);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('fill', 'none');

  svg.append(path);
  return svg;
}

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
  statusRegion.textContent = `${n} unfinished item${n === 1 ? '' : 's'}`;
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
  renderItems();
  renderTimerItem();
  renderControls();
  renderLog();
  renderCalendar();
  paintTimer();
  syncLoop();
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

timelineGrid.addEventListener('click', (event) => {
  const logId = event.target.closest('[data-unplace]')?.dataset.unplace;
  if (!logId) return;

  unplaceEntry(logId);
  render();
});

buildTicks();
render();
