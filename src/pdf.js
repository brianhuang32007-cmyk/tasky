// A very small PDF writer: pages, the two base-14 Helveticas, text, and filled
// or stroked vector paths. Enough for the daily summary and nothing beyond it.
//
// Written by hand for the same reason the .ics is written by hand — the format
// is small and well specified, and a library would be the first build step this
// project has ever needed.
//
// PDF's origin is the bottom-left corner with y increasing upward, which is the
// opposite of every other coordinate system in this app. Rather than flip every
// number by hand, drawSpace() installs a transform so a y-down drawing (the
// mascot, lifted straight out of its SVG) can be transcribed unchanged.

const KAPPA = 0.5523; // circle-to-bezier constant: 4/3 * (sqrt(2) - 1)

// Adobe's metrics for the two fonts used, in 1/1000 em, for ASCII 32-126.
// Needed because right-aligning a duration means knowing how wide it is, and
// nothing in the browser can measure PDF Helvetica for us.
const WIDTHS = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
};

// The handful of non-Latin-1 characters this app actually produces — its own
// copy uses curly quotes and em dashes, and a user can paste anything.
const WIN_ANSI_EXTRAS = new Map(Object.entries({
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c,
  'ž': 0x9e, 'Ÿ': 0x9f,
}));

/** A character's WinAnsi byte, or null if the font cannot represent it. */
function winAnsi(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 128) return cp;
  if (cp >= 160 && cp <= 255) return cp; // WinAnsi matches Latin-1 through here
  return WIN_ANSI_EXTRAS.get(ch) ?? null;
}

/**
 * A PDF string literal. Only the delimiters and the escape itself have to be
 * escaped; everything outside printable ASCII becomes an octal byte so the
 * finished file stays 7-bit and its length in characters is its length in
 * bytes — which is what makes the xref offsets below trustworthy.
 */
function pdfString(text) {
  let out = '';

  for (const ch of text) {
    const code = winAnsi(ch);
    if (code === null) {
      out += '?';
    } else if (code === 0x28 || code === 0x29 || code === 0x5c) {
      out += `\\${ch}`;
    } else if (code < 32 || code > 126) {
      out += `\\${code.toString(8).padStart(3, '0')}`;
    } else {
      out += ch;
    }
  }

  return out;
}

/** How wide `text` renders, in points. Unmeasurable characters count as 556. */
export function textWidth(text, size, weight = 'regular', tracking = 0) {
  const table = WIDTHS[weight];
  let mille = 0;

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    mille += cp >= 32 && cp <= 126 ? table[cp - 32] : 556;
  }

  // Tc adds its space after every glyph, the last one included.
  return (mille / 1000) * size + tracking * [...text].length;
}

/** Shortens to fit, with an ellipsis, or returns it untouched if it already does. */
export function ellipsize(text, maxWidth, size, weight = 'regular') {
  if (textWidth(text, size, weight) <= maxWidth) return text;

  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}…`, size, weight) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

const n = (value) => {
  // Three decimals is finer than any printer resolves, and keeps the file from
  // filling with floating-point noise like 43.400000000000006.
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** '#f2913b' -> '0.949 0.569 0.231', PDF's 0-1 component form. */
function rgb(hex) {
  const int = parseInt(hex.slice(1), 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
    .map((c) => n(c / 255))
    .join(' ');
}

/**
 * One page's drawing surface. Every method appends operators to a content
 * stream; nothing is measured or laid out here, which is the caller's job.
 */
function createPage(width, height) {
  const ops = [];

  const api = {
    width,
    height,

    fill(hex) { ops.push(`${rgb(hex)} rg`); return api; },
    stroke(hex) { ops.push(`${rgb(hex)} RG`); return api; },
    lineWidth(w) { ops.push(`${n(w)} w`); return api; },
    roundCaps() { ops.push('1 J', '1 j'); return api; },

    text(content, x, y, size, weight = 'regular', tracking = 0) {
      const font = weight === 'bold' ? '/F2' : '/F1';
      ops.push(
        `BT ${font} ${n(size)} Tf ${n(tracking)} Tc ` +
        `${n(x)} ${n(y)} Td (${pdfString(content)}) Tj ET`,
      );
      return api;
    },

    rect(x, y, w, h) { ops.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`); return api; },

    line(x1, y1, x2, y2) {
      ops.push(`${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
      return api;
    },

    /** An ellipse as four beziers, which is how PDF draws every curve. */
    ellipse(cx, cy, rx, ry, mode = 'f') {
      const ox = rx * KAPPA;
      const oy = ry * KAPPA;
      ops.push(
        `${n(cx - rx)} ${n(cy)} m`,
        `${n(cx - rx)} ${n(cy + oy)} ${n(cx - ox)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
        `${n(cx + ox)} ${n(cy + ry)} ${n(cx + rx)} ${n(cy + oy)} ${n(cx + rx)} ${n(cy)} c`,
        `${n(cx + rx)} ${n(cy - oy)} ${n(cx + ox)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
        `${n(cx - ox)} ${n(cy - ry)} ${n(cx - rx)} ${n(cy - oy)} ${n(cx - rx)} ${n(cy)} c`,
        mode,
      );
      return api;
    },

    /** Cubic segments: [[x, y], [c1x, c1y, c2x, c2y, x, y], ...]. */
    path(start, segments, mode = 'f') {
      ops.push(`${n(start[0])} ${n(start[1])} m`);
      for (const s of segments) ops.push(`${s.map(n).join(' ')} c`);
      ops.push(mode);
      return api;
    },

    /**
     * Runs `draw` in a y-down space of `size` units, scaled to `boxSize` points
     * and placed with its top-left at (x, y). Lets artwork be transcribed from
     * an SVG viewBox without every coordinate being flipped by hand.
     */
    drawSpace(x, y, boxSize, size, draw) {
      const scale = boxSize / size;
      ops.push('q', `${n(scale)} 0 0 ${n(-scale)} ${n(x)} ${n(y)} cm`);
      draw(api);
      ops.push('Q');
      return api;
    },

    stream: () => ops.join('\n'),
  };

  return api;
}

export function createDocument({ width = 612, height = 792 } = {}) {
  const pages = [];

  return {
    addPage() {
      const page = createPage(width, height);
      pages.push(page);
      return page;
    },

    /**
     * Assembles the file. The xref table is byte offsets into it, so the string
     * must be pure ASCII for its character length to equal its byte length —
     * pdfString() guarantees that, and the assertion below keeps it honest.
     */
    toBlob() {
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        null, // the Pages node, once the kid ids are known
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      ];

      const kids = [];
      for (const page of pages) {
        const contentId = objects.length + 2;
        kids.push(`${objects.length + 1} 0 R`);

        objects.push(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(page.width)} ${n(page.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
        );

        const stream = page.stream();
        objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      }

      objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;

      let out = '%PDF-1.4\n';
      const offsets = [];
      objects.forEach((body, i) => {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      });

      const startxref = out.length;
      out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
      out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
      out += `startxref\n${startxref}\n%%EOF\n`;

      if (out.length !== new TextEncoder().encode(out).length) {
        throw new Error('PDF is not 7-bit: the xref offsets would be wrong');
      }

      return new Blob([out], { type: 'application/pdf' });
    },
  };
}
