#!/usr/bin/env python3
"""Tasky's dev server: static files, plus the one endpoint that needs a secret.

The app is otherwise a static page. Analysis is the exception — an API key
cannot ship in client-side code, so the call is made here and the key is read
from the environment and never sent to the browser.

    export ANTHROPIC_API_KEY=sk-ant-...
    python3 tools/serve.py

Then open http://localhost:8000. Static serving works without the key or the
SDK; only /api/analyze needs them.
"""

import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("PORT", "8000"))

MODEL = "claude-opus-5"
MAX_TOKENS = 4000

SYSTEM_PROMPT = """\
You are a productivity advisor inside Tasky, a personal time-tracking app. You
are given one day of one person's recorded activity and, when they have set
any, their own stated goals.

When goals exist your job is to help them hit those goals, not to narrate the
day back to them. Weight the response toward evaluation and concrete
recommendations.

GROUNDING
- Everything you say about what happened must come from the data provided.
  Never invent a task, a duration, a break, a time of day, or a goal.
- The app has already calculated every duration and total. Use the numbers as
  given; never recompute or contradict them.
- Where no calendar placement is given, you do not know when something
  happened. Do not guess start or end times.
- Quote real values when assessing performance ("1 hr 14 min against your
  30-minute target"), not vague characterisations.
- Keep observation and recommendation clearly separate: what the data shows,
  then what they might try.
- Where a cause is uncertain, say so, weigh the plausible explanations, and
  name which one the evidence best supports.

STANCE
- Frame recommendations as options, not orders. The person decides.
- Be warm and matter-of-fact. Never scold, shame, or moralise about how the
  time was spent.
- No motivational filler, no praise padding, no medical or mental-health
  claims.
- If a goal looks unrealistic against their actual data, say so plainly and
  offer a version that isn't.
- Prefer a different strategy over "try harder" or "spend less time". Naming a
  concrete technique is welcome where it genuinely fits the goal — timeboxing,
  a fixed break cadence, protecting a focus block, batching similar work,
  moving demanding work to their observed best hours. Crediting a technique to
  its originator is fine when accurate.

GOAL RELEVANCE
- Only discuss a goal this day has evidence for. If a goal cannot be judged
  from this data, say "Not enough recorded information today to evaluate this
  goal." and move on. Do not force every goal into the response.

OUTPUT
Return sections. When goals exist, use these headings in this order, omitting
any you have nothing grounded to say about:
  Goal Progress — met, missed, or partially met for each relevant goal, with
    the actual numbers
  What Helped / What Got in the Way
  Time Allocation Analysis
  Recommendations
  Suggested Next-Day Adjustment

When there are no goals, be descriptive rather than prescriptive, and use:
  Daily Overview
  Time Usage
  Notable Patterns
  General Suggestions
Never invent goals the person has not set.

Each point is one or two sentences. Be specific and scannable — three to six
points per section.\
"""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "heading": {"type": "string"},
                    "points": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["heading", "points"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["sections"],
    "additionalProperties": False,
}


def _lines(entries, empty):
    return "\n".join(entries) if entries else empty


def build_user_message(data):
    """Render the payload as readable text. Only what the app actually knows."""
    goals = data.get("goals") or []
    completed = data.get("completed") or []
    totals = data.get("totals") or {}
    switching = data.get("switching") or {}
    calendar = data.get("calendar") or {}

    tasks = [c for c in completed if c.get("kind") == "task"]
    breaks = [c for c in completed if c.get("kind") == "break"]

    def describe(item):
        bits = [f"- {item.get('name')} — {item.get('duration')}"]
        if item.get("scheduled"):
            bits.append(f" — placed {item['scheduled']}")
        else:
            bits.append(" — not placed on the calendar")
        if item.get("manual"):
            bits.append(" (added by hand afterwards; its timing was not observed)")
        return "".join(bits)

    parts = [f"Date: {data.get('date', 'unknown')}", ""]

    parts += [
        f"GOALS ({len(goals)})",
        _lines([f"- {g}" for g in goals], "The user has not set any goals."),
        "",
        f"COMPLETED TASKS ({len(tasks)})",
        _lines([describe(t) for t in tasks], "None recorded."),
        "",
        f"COMPLETED BREAKS ({len(breaks)})",
        _lines([describe(b) for b in breaks], "None recorded."),
        "",
        "TOTALS (already calculated by the app — do not recompute)",
        f"- Total task time: {totals.get('task', '0 sec')}",
        f"- Total break time: {totals.get('break', '0 sec')}",
        f"- Total tracked: {totals.get('total', '0 sec')}",
        f"- Tasks completed: {totals.get('taskCount', 0)}",
        f"- Breaks taken: {totals.get('breakCount', 0)}",
        "",
        "SWITCHING",
        _lines(switching.get("notes") or [], "No timed stretches recorded."),
        "",
        "CALENDAR",
        _lines(
            calendar.get("notes") or [],
            "The user has not arranged a calendar for this day, so no start or "
            "end times are known.",
        ),
    ]
    return "\n".join(parts)


def run_analysis(data):
    import anthropic  # imported lazily so static serving works without it

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment

    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=SYSTEM_PROMPT,
        output_config={
            "effort": "medium",
            "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA},
        },
        messages=[{"role": "user", "content": build_user_message(data)}],
    )

    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to analyse this data.")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise RuntimeError("The model returned no analysis.")

    return json.loads(text)


class Handler(SimpleHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/analyze":
            self._send_json(404, {"error": "Unknown endpoint."})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send_json(400, {"error": "Could not read the request body."})
            return

        if not os.environ.get("ANTHROPIC_API_KEY"):
            self._send_json(503, {
                "error": "ANTHROPIC_API_KEY is not set. Export it and restart "
                         "the server to enable analysis.",
            })
            return

        try:
            self._send_json(200, run_analysis(data))
        except ModuleNotFoundError:
            self._send_json(503, {
                "error": "The anthropic package is not installed. "
                         "Run: pip3 install anthropic",
            })
        except Exception as exc:  # surfaced to the user, not swallowed
            self._send_json(502, {"error": f"{type(exc).__name__}: {exc}"})

    def end_headers(self):
        # SimpleHTTPRequestHandler sends only Last-Modified, so browsers hold
        # on to edited modules across a reload. This is a dev server; never
        # serve a stale file.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)


def main():
    handler = partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    key = "set" if os.environ.get("ANTHROPIC_API_KEY") else "NOT SET — analysis disabled"
    print(f"Tasky on http://localhost:{PORT}  (ANTHROPIC_API_KEY: {key})")
    server.serve_forever()


if __name__ == "__main__":
    main()
