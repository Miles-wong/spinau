"""Per-conversation AI call timing tracker.

Instructs each LLM call site to call _ai_tracker.log_call(name, duration, details)
so that once a conversation ends, print_summary() can report a breakdown of
how long each extraction/assistant step took.
"""
import os
import time


def _verbose() -> bool:
    return os.environ.get("AI_TRACKER_VERBOSE", "").strip().lower() in {"1", "true", "yes", "on"}


class AICallTracker:
    """Track timing for all AI calls in a conversation."""

    def __init__(self):
        self.calls = []
        self.start_time = None
        self.session_id = None

    def start_session(self, session_id=None):
        """Start a new tracking session."""
        self.calls = []
        self.start_time = time.time()
        self.session_id = session_id or f"session_{int(time.time() * 1000)}"
        if _verbose():
            print(f"\n{'=' * 70}")
            print(f"[TIMER] Begin dialogue preprocessing | Session: {self.session_id}")
            print(f"{'=' * 70}\n")

    def log_call(self, name: str, duration: float, details: str = ""):
        """Log an AI call with its duration."""
        self.calls.append(
            {
                "name": name,
                "duration": duration,
                "details": details,
                "timestamp": time.time(),
            }
        )
        if _verbose():
            print(f"[AI_CALL] {name}: {duration:.3f} seconds | {details}")

    def log_subcomponent(self, name: str, duration: float):
        """Log a sub-component of processing."""
        if _verbose():
            print(f"  └─ {name}: {duration:.3f}s")

    def get_summary(self) -> str:
        """Get a summary of all calls."""
        if not self.calls:
            return "No AI calls tracked"

        total = sum(call["duration"] for call in self.calls)
        summary = f"\n{'=' * 70}\n"
        summary += f"[AI Call Summary] Session: {self.session_id}\n"
        summary += f"{'=' * 70}\n"

        for i, call in enumerate(self.calls, 1):
            summary += f"{i}. {call['name']}: {call['duration']:.3f} seconds"
            if call["details"]:
                summary += f" ({call['details']})"
            summary += "\n"

        summary += f"{'-' * 70}\n"
        summary += f"Total Time: {total:.3f} seconds | Call Count: {len(self.calls)}\n"
        summary += f"{'=' * 70}\n"
        return summary

    def print_summary(self):
        """Print summary to console."""
        if _verbose():
            print(self.get_summary())


_ai_tracker = AICallTracker()
