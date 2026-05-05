"""Structured application logger.

Usage:
    from logger import get_logger
    logger = get_logger(__name__)
    logger.info("Request received", uid=uid, route="/api/validate")

All log entries are emitted as single-line JSON, which makes them easy to
grep, pipe into log aggregators, or parse programmatically.121
"""

import json
import logging
from typing import Any


class _IgnoreHealthcheckFilter(logging.Filter):
    """Hide noisy development health-check access logs from Werkzeug."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return "/api/health" not in message


class StructuredLogger:
    """Thin wrapper that converts keyword fields into logging `extra` payloads."""

    def __init__(self, logger: logging.Logger):
        self._logger = logger

    def debug(self, message: str, exc_info: Any = None, **fields: Any) -> None:
        self._log(logging.DEBUG, message, exc_info=exc_info, **fields)

    def info(self, message: str, exc_info: Any = None, **fields: Any) -> None:
        self._log(logging.INFO, message, exc_info=exc_info, **fields)

    def warning(self, message: str, exc_info: Any = None, **fields: Any) -> None:
        self._log(logging.WARNING, message, exc_info=exc_info, **fields)

    def error(self, message: str, exc_info: Any = None, **fields: Any) -> None:
        self._log(logging.ERROR, message, exc_info=exc_info, **fields)

    def _log(self, level: int, message: str, exc_info: Any = None, **fields: Any) -> None:
        if exc_info and exc_info is not True:
            self._logger.log(level, message, extra=fields, exc_info=(type(exc_info), exc_info, exc_info.__traceback__))
            return
        self._logger.log(level, message, extra=fields, exc_info=bool(exc_info))


class _StructuredFormatter(logging.Formatter):
    """Emit each log record as a single-line JSON string."""

    # Keys that belong to the LogRecord internals — exclude them from extras.
    _SKIP = frozenset({
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "message", "taskName",
    })

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        # Attach any caller-supplied keyword fields (e.g. uid=, route=).
        for key, value in record.__dict__.items():
            if key not in self._SKIP:
                entry[key] = value

        if record.exc_info:
            entry["exc_info"] = self.formatException(record.exc_info)

        return json.dumps(entry, default=str, ensure_ascii=False)


def _bootstrap() -> None:
    root = logging.getLogger()
    if root.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(_StructuredFormatter())
    handler.addFilter(_IgnoreHealthcheckFilter())
    root.addHandler(handler)
    root.setLevel(logging.INFO)

    werkzeug_logger = logging.getLogger("werkzeug")
    werkzeug_logger.addFilter(_IgnoreHealthcheckFilter())


_bootstrap()


def get_logger(name: str) -> StructuredLogger:
    """Return a structured logger that accepts arbitrary keyword fields."""
    return StructuredLogger(logging.getLogger(name))
