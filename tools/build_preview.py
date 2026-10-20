#!/usr/bin/env python3
"""Bundle Tasky into a single self-contained preview.html.

Chrome refuses to load ES modules over file://, so index.html cannot simply be
double-clicked. This inlines the stylesheet and the module graph into one file
that opens anywhere with no server.

The bundle is a disposable snapshot for review. index.html and src/ remain the
real application; nothing here is imported by the app.

    python3 tools/build_preview.py
    python3 tools/build_preview.py --styles styles.css,styles.v2.css --out preview-v2.html

Several stylesheets inline in the order given, so a design layer can be stacked
on the base sheet and compared against it without either being edited.
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENTRY = ROOT / "src" / "main.js"

LINK_TAG = '<link rel="stylesheet" href="styles.css">'
SCRIPT_TAG = '<script type="module" src="src/main.js"></script>'

IMPORT_RE = re.compile(
    r"^[ \t]*import\s+.*?\s+from\s+['\"](\.[^'\"]+)['\"];?[ \t]*$",
    re.MULTILINE | re.DOTALL,
)
EXPORT_RE = re.compile(r"^([ \t]*)export\s+", re.MULTILINE)


def inline_module(path, seen, chunks):
    """Depth-first so dependencies are emitted before the files that use them."""
    path = path.resolve()
    if path in seen:
        return
    seen.add(path)

    source = path.read_text()
    for spec in IMPORT_RE.findall(source):
        inline_module(path.parent / spec, seen, chunks)

    # Everything lands in one scope, so imports go and exports lose their keyword.
    source = EXPORT_RE.sub(r"\1", IMPORT_RE.sub("", source)).strip()
    chunks.append(f"/* ---- {path.relative_to(ROOT)} ---- */\n{source}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--styles", default="styles.css",
                        help="comma-separated stylesheets, inlined in order")
    parser.add_argument("--out", default="preview.html")
    args = parser.parse_args()

    out_path = ROOT / args.out
    sheets = [ROOT / name.strip() for name in args.styles.split(",") if name.strip()]

    missing = [s for s in sheets if not s.exists()]
    if missing:
        sys.exit("build_preview: no such stylesheet: "
                 + ", ".join(str(m.relative_to(ROOT)) for m in missing))

    html = (ROOT / "index.html").read_text()
    css = "\n\n".join(
        f"/* ---- {s.relative_to(ROOT)} ---- */\n{s.read_text().strip()}" for s in sheets
    )

    if LINK_TAG not in html or SCRIPT_TAG not in html:
        sys.exit(
            "build_preview: index.html no longer contains the expected stylesheet "
            "or module tag. Update LINK_TAG/SCRIPT_TAG in this script."
        )

    chunks = []
    inline_module(ENTRY, set(), chunks)

    html = html.replace(LINK_TAG, f"<style>\n{css}\n</style>")
    html = html.replace(SCRIPT_TAG, "<script>\n" + "\n\n".join(chunks) + "\n</script>")

    out_path.write_text(html)
    print(f"wrote {out_path.relative_to(ROOT)} ({len(html):,} bytes, "
          f"{len(chunks)} modules, {len(sheets)} stylesheet(s))")


if __name__ == "__main__":
    main()
