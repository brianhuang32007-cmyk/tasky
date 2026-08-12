// Duration formatting and analog-clock geometry. Pure functions — no state,
// no DOM.
//
// Two formats exist on purpose:
//   formatClock the live timer readout, counting like a stopwatch
//   formatHuman completed durations and totals, spelled out in words

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

/**
 * Spelled out, zero-value units omitted anywhere in the string — so an hour
 * and five seconds reads "2 hrs 5 sec", skipping the empty minutes. Exactly
 * zero reads "0 sec". Only "hr" pluralises; min and sec stay abbreviated.
 */
export function formatHuman(ms) {
  const { hours, minutes, seconds } = parts(ms);
  const out = [];

  if (hours > 0) out.push(`${hours} ${hours === 1 ? 'hr' : 'hrs'}`);
  if (minutes > 0) out.push(`${minutes} min`);
  if (seconds > 0) out.push(`${seconds} sec`);

  return out.length > 0 ? out.join(' ') : '0 sec';
}

// The clock shows position within the current 60-minute cycle, so both hands
// wrap on their own and no hour hand is needed. Fractional by design — the
// hands sweep rather than step.

/** Minutes from midnight as a wall-clock label: 570 -> "9:30 AM". */
export function formatTimeOfDay(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export const secondHandAngle = (ms) => ((ms % MINUTE) / MINUTE) * 360;

export const minuteHandAngle = (ms) => ((ms % HOUR) / HOUR) * 360;
