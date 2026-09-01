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

    // The Assignments page. Separate from items/log: an assignment is
    // something with a date, not something you run a timer against.
    // completedAt is the whole done/not-done state: a timestamp or null. One
    // list rather than two keeps counting by type across both states trivial.
    assignments: [], // { id, name, kind, day, month, time, createdAt, completedAt }

    // Free-text instructions the user gives the analysis. Stored apart from
    // activity: a goal never changes a task, a timer, or a calendar block.
    goals: [],      // { id, text }

    // The last analysis, with a fingerprint of the data it was generated from,
    // so a stale one is never presented as current.
    analysis: null, // { sections, generatedAt, fingerprint, goalCount }

    // The moment of the last successful write. On load this is the latest
    // point the app is known to have been alive, which is what bounds an
    // interrupted run — see reconcileOpenRun() in main.js.
    savedAt: null,
  };
}

/**
 * Fills in anything a stored state predates, so a save written by an older
 * build still loads instead of throwing on a missing field.
 */
function withDefaults(stored) {
  return { ...emptyState(), ...stored };
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
    return parsed && parsed.version === 1 ? withDefaults(parsed) : emptyState();
  } catch {
    // Corrupt entry: start clean rather than failing to boot.
    return emptyState();
  }
}

export function save(state) {
  try {
    state.savedAt = Date.now();
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    // Quota exceeded, or storage blocked. The caller surfaces this rather
    // than letting the user believe their day is being kept.
    return false;
  }
}
