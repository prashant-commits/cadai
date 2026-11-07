"""Token file for the service tests.

The service refuses to start when ``CADAI_GEO_TOKEN`` is set. Tests authenticate
with ``CADAI_GEO_TOKEN_FILE`` instead.
"""

import os
import tempfile
from pathlib import Path

os.environ.pop("CADAI_GEO_TOKEN", None)
_TOKEN_PATH = Path(tempfile.gettempdir()) / "cadai-geo-pytest-token"
if _TOKEN_PATH.exists():
    _TOKEN_PATH.chmod(0o600)
_TOKEN_PATH.write_text("test-token\n", encoding="utf-8")
_TOKEN_PATH.chmod(0o400)
os.environ["CADAI_GEO_TOKEN_FILE"] = str(_TOKEN_PATH)
