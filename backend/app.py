"""Backward-compatible entrypoint that delegates to backend_app.main."""

from backend_app.main import app
from backend_app.core.config import get_api_port
from backend_app.core.logger import get_logger


if __name__ == "__main__":
    port = get_api_port()
    get_logger(__name__).info(f"Starting dev server on http://127.0.0.1:{port}")
    app.run(debug=True, host="127.0.0.1", port=port)
