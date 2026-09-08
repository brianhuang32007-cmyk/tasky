// The printable daily summary. Lays out one report on top of pdf.js and knows
// nothing about app state — the caller hands it finished rows and totals, which
// keeps the layout testable and stops report formatting leaking into main.js.

import { formatHuman } from './time.js';
import { createDocument, textWidth, ellipsize } from './pdf.js';

const INK = '#2c2118';
const MUTED = '#8b7460';
const BORDER = '#efdfc9';
const ACCENT = '#f2913b';
const ACCENT_STRONG = '#dc7716';
const ACCENT_SOFT = '#fceedd';
const STRIPE = '#a85514';
const NOSE = '#c9603a';
const BREAK_INK = '#8a6410';
const BREAK_SOFT = '#fbeec4';
const WHITE = '#ffffff';

const PAGE = { width: 612, height: 792 };
const MARGIN = 56;
const LEFT = MARGIN;
const RIGHT = PAGE.width - MARGIN;
const MIDDLE = PAGE.width / 2;

const ROW_HEIGHT = 26;
const KIND_COLUMN = 452;   // right edge of the TASK / BREAK column
const FOOTER_Y = 46;
const LOWEST_ROW = 132;    // rows stop here; below is footer air

/**
 * Tasky, transcribed straight from the mascot in index.html. Drawn in that
 * SVG's own 64-unit y-down space — see drawSpace() — so the two stay
 * recognisably the same tiger, smile included.
 */
function drawTiger(p) {
  p.fill(ACCENT).ellipse(16, 18, 8.5, 8.5).ellipse(48, 18, 8.5, 8.5);
  p.fill(ACCENT_SOFT).ellipse(16, 18, 4.2, 4.2).ellipse(48, 18, 4.2, 4.2);
  p.fill(ACCENT).ellipse(32, 35, 22, 20);

  p.stroke(STRIPE).lineWidth(2.6).roundCaps();
  p.line(32, 16.5, 32, 22.5);
  p.line(24.5, 18.5, 23, 24);
  p.line(39.5, 18.5, 41, 24);
  p.path([11.6, 31.4], [[14, 32.1, 15.9, 32.4, 17.5, 32.5]], 'S');
  p.path([12.1, 38.6], [[14.5, 38.4, 16.4, 38.1, 18, 37.5]], 'S');
  p.path([52.4, 31.4], [[50, 32.1, 48.1, 32.4, 46.5, 32.5]], 'S');
  p.path([51.9, 38.6], [[49.5, 38.4, 47.6, 38.1, 46, 37.5]], 'S');

  p.fill(ACCENT_SOFT).ellipse(26.6, 43.4, 7.2, 5.6).ellipse(37.4, 43.4, 7.2, 5.6);

  p.fill(INK).ellipse(24, 33, 3.1, 3.5).ellipse(40, 33, 3.1, 3.5);
  p.fill(WHITE).ellipse(22.9, 31.7, 1.15, 1.15).ellipse(38.9, 31.7, 1.15, 1.15);

  p.fill(NOSE).path([28.6, 38.4], [
    [29.6, 37.6, 34.4, 37.6, 35.4, 38.4],
    [35.9, 41, 33.4, 42.8, 32, 42.8],
    [30.6, 42.8, 28.1, 41, 28.6, 38.4],
  ], 'f');

  // The smile.
  p.stroke(INK).lineWidth(1.6).roundCaps();
  p.line(32, 42.8, 32, 45.1);
  p.path([32, 45.1], [[31.4, 47, 28.8, 47.4, 27.6, 45.9]], 'S');
  p.path([32, 45.1], [[32.6, 47, 35.2, 47.4, 36.4, 45.9]], 'S');
}

const centre = (p, text, y, size, weight, colour, tracking = 0) => {
  p.fill(colour);
  p.text(text, MIDDLE - textWidth(text, size, weight, tracking) / 2, y, size, weight, tracking);
};

const rightAlign = (p, text, x, y, size, weight, colour) => {
  p.fill(colour);
  p.text(text, x - textWidth(text, size, weight), y, size, weight);
};

/** A hairline the full width of the content column. */
const rule = (p, y) => {
  p.stroke(BORDER).lineWidth(1).line(LEFT, y, RIGHT, y);
};

function drawHeader(p, now) {
  p.drawSpace(MIDDLE - 44, PAGE.height - MARGIN, 88, 64, drawTiger);

  centre(p, 'Tasky', 618, 26, 'bold', ACCENT_STRONG);
  centre(p, 'DAILY SUMMARY', 596, 9, 'bold', MUTED, 2.4);

  const date = now.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  centre(p, date, 566, 17, 'bold', INK);

  return 542; // where the body may start
}

/** Continuation pages get a line of context instead of the whole crown. */
function drawContinuation(p, now) {
  const date = now.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  p.fill(MUTED).text(`Tasky · Daily summary · ${date}`, LEFT, PAGE.height - MARGIN, 9);
  return PAGE.height - MARGIN - 30;
}

function drawColumnHeadings(p, y) {
  p.fill(MUTED).text('COMPLETED', LEFT, y, 8.5, 'bold', 1.4);
  rightAlign(p, 'TIME', RIGHT, y, 8.5, 'bold', MUTED);
  rule(p, y - 10);
  return y - 30;
}

function drawRow(p, entry, y) {
  const isBreak = entry.kind === 'break';

  // A dot rather than a filled badge: at this size a badge would need padding
  // the row cannot spare, and the colour alone carries the same distinction.
  p.fill(isBreak ? BREAK_INK : ACCENT).ellipse(LEFT + 3.5, y + 3.5, 3.5, 3.5);

  const nameX = LEFT + 16;
  const nameWidth = KIND_COLUMN - nameX - 46;
  p.fill(INK).text(ellipsize(entry.name, nameWidth, 11.5), nameX, y, 11.5);

  rightAlign(p, isBreak ? 'BREAK' : 'TASK', KIND_COLUMN, y, 8, 'bold', MUTED);
  rightAlign(p, formatHuman(entry.ms), RIGHT, y, 11.5, 'regular', INK);
}

/** One of the two closing figures. */
function drawTotal(p, x, y, width, label, ms, soft, ink) {
  p.fill(soft).rect(x, y, width, 58);
  p.fill(ink).text(label, x + 16, y + 36, 8.5, 'bold', 1.4);
  p.fill(INK).text(formatHuman(ms), x + 16, y + 14, 16, 'bold');
}

function drawTotals(p, y, totals) {
  const width = (RIGHT - LEFT - 16) / 2;
  drawTotal(p, LEFT, y, width, 'TOTAL TASK TIME', totals.task, ACCENT_SOFT, ACCENT_STRONG);
  drawTotal(p, LEFT + width + 16, y, width, 'TOTAL BREAK TIME', totals.break, BREAK_SOFT, BREAK_INK);
}

function drawFooter(p, now) {
  const stamp = now.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  centre(p, `Generated by Tasky · ${stamp}`, FOOTER_Y, 8, 'regular', MUTED);
}

/**
 * The finished report.
 *
 * `entries` are completed items only — unfinished work is deliberately absent,
 * because a summary of the day is a record of what was done. Rows flow onto as
 * many pages as they need rather than being silently cut off, and the totals
 * always close the last page.
 */
export function buildDailySummary({ entries, totals, now = new Date() }) {
  const doc = createDocument(PAGE);

  let page = doc.addPage();
  let y = drawColumnHeadings(page, drawHeader(page, now));
  const pages = [page];

  const newPage = () => {
    page = doc.addPage();
    pages.push(page);
    y = drawColumnHeadings(page, drawContinuation(page, now));
  };

  if (entries.length === 0) {
    centre(page, 'Nothing completed yet today.', y - 12, 11, 'regular', MUTED);
    y -= 44;
  }

  for (const entry of entries) {
    if (y < LOWEST_ROW) newPage();
    drawRow(page, entry, y);
    y -= ROW_HEIGHT;
  }

  // The totals need room beneath the closing rule; a new page beats a box
  // hanging off the bottom edge.
  rule(page, y + 12);
  if (y - 12 < LOWEST_ROW) {
    newPage();
    y -= 12;
  }
  drawTotals(page, y - 70, totals);

  for (const p of pages) drawFooter(p, now);

  return doc.toBlob();
}

/** tasky-daily-summary-2026-09-08.pdf */
export function dailySummaryFilename(now = new Date()) {
  const pad = (v) => String(v).padStart(2, '0');
  return `tasky-daily-summary-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.pdf`;
}
