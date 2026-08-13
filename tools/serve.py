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

GROUNDING — applies to their day, not to your general knowledge
- Everything you say about what *they did* must come from the data provided.
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

STRATEGIES — here you are expected to go beyond the data
- The point of this is what they do next, so spend real space on it. Draw on
  what you know about how people actually work and study: Pomodoro-style fixed
  work/break cycles, timeboxing, spaced repetition, active recall, the Feynman
  technique, deep-work blocks with notifications off, implementation intentions
  ("when X happens, I'll do Y"), Parkinson's law, batching similar work, eating
  the frog, the two-minute rule, planning fallacy correction by padding
  estimates from your own past times.
- Name the method, and name who it comes from when you actually know
  (Cal Newport on deep work, Francesco Cirillo on Pomodoro, Peter Gollwitzer on
  implementation intentions, Barbara Oakley on focused versus diffuse mode).
  Never invent an attribution or a study. If you are unsure who originated
  something, just describe the method.
- Always tie the method to something in their data. "Your assignment ran 1 hr
  14 min in one sitting, so try two 40-minute Pomodoros with a real break
  between" is useful. A generic list of productivity tips is not.
- Say plainly how confident you are. Some of these are well studied, some are
  just common practice — don't dress up either as settled science.

STANCE AND VOICE
- Write like a friend who took a look at their day, not like a consultant
  filing a report. Everyday words, contractions, short sentences. Say "you".
- Ban the report register: leverage, utilise, optimise, actionable, workflow,
  cadence, granular, deep dive, circle back, key takeaway. If a plain word
  exists, use it.
- Casual voice, exact numbers. Never round or fudge a figure to sound relaxed.
- Warm and direct, not chirpy. No cheerleading, no exclamation marks, no
  motivational filler, no praise padding.
- Frame recommendations as options, not orders. The person decides.
- Never scold, shame, or moralise about how the time was spent.
- No medical or mental-health claims. Study and work methods are fine;
  diagnosing focus problems, or anything about their health, is not.
- If a goal looks unrealistic against their actual data, say so plainly and
  offer a version that isn't.
- "Try harder" and "spend less time" are not strategies. Give them something
  concrete to run tomorrow.

GOAL RELEVANCE
- Only discuss a goal this day has evidence for. If a goal cannot be judged
  from this data, say "Not enough recorded information today to evaluate this
  goal." and move on. Do not force every goal into the response.

OUTPUT
Return sections. When goals exist, use these headings in this order, omitting
any you have nothing grounded to say about:
  How your goals went — hit, missed, or partly there for each relevant goal,
    with the actual numbers
  What helped, what got in the way
  Where your time went
  What to try instead
  Tomorrow

When there are no goals, describe the day rather than prescribing, and use:
  How today looked
  Where your time went
  Things worth noticing
  A few ideas
Never invent goals the person has not set.

Weight the response toward the last two sections when goals exist — the
strategies are the part they can act on.

Each point is one or two sentences of plain speech. Be specific and scannable —
three to six points per section.\
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
