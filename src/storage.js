// The only place that talks to localStorage.
// Accounts and a backend come later; when they do, this module changes and
// nothing else has to.

const KEY = 'tasky.state.v1';

// Segments are the source of truth for time. An item's total duration is the
// sum of its segments — never a separate counter that can drift out of sync.
export function emptyState() {
  return {
    version: 1,
    items: [],      // { id, name, kind: 'task' | 'break', createdAt }
    segments: [],   // { id, itemId, startedAt, endedAt }
    log: [],        // { id, itemId, name, kind, finishedAt }
    selectedId: null,
    runningSince: null,

    // Calendar placement only: log entry id -> start minute of the day.
    // Deliberately separate from segments. Arranging a block on the calendar
    // is the user describing when something happened, and must never edit the
    // recorded duration.
    placements: {},
    calendarShown: false,

    // Free-text instructions the user gives the analysis. Stored apart from
    // activity: a goal never changes a task, a timer, or a calendar block.
    goals: [],      // { id, text }

    // The last analysis, with a fingerprint of the data it was generated from,
    // so a stale one is never presented as current.
    analysis: null, // { sections, generatedAt, fingerprint, goalCount }
  };
}

export function load() {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Private browsing or storage disabled: run in memory for this session.
    return emptyState();
  }
  if (!raw) return emptyState();

  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === 1 ? parsed : emptyState();
  } catch {
    return emptyState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
