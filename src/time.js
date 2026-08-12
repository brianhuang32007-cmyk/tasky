// Duration formatting and analog-clock geometry. Pure functions — no state,
// no DOM.
//
// Two formats exist on purpose:
//   formatClock   the live timer readout, counting like a stopwatch
//   formatCompact at-a-glance totals in the log, per the rule in CLAUDE.md

const MINUTE = 60_000;
const HOUR = 3_600_000;

const pad = (n) => String(n).padStart(2, '0');

const parts = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000)); // truncate, never round up
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
};

/** MM:SS below an hour, HH:MM:SS from an hour onward. */
export function formatClock(ms) {
  const { hours, minutes, seconds } = parts(ms);
  return hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** At most two units, largest first, zero tail dropped: 1h 20m, 4m 5s, 30s. */
export function formatCompact(ms) {
  const { hours, minutes, seconds } = parts(ms);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

// The clock shows position within the current 60-minute cycle, so both hands
// wrap on their own and no hour hand is needed. Fractional by design — the
// hands sweep rather than step.

export const secondHandAngle = (ms) => ((ms % MINUTE) / MINUTE) * 360;

export const minuteHandAngle = (ms) => ((ms % HOUR) / HOUR) * 360;
