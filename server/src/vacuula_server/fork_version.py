"""This fork's own version, shown next to upstream's APP_VERSION ("Vacuula 1.1.0 · sb 1.0.0").

APP_VERSION stays upstream's: the installer and mDNS compare it. Raise FORK_VERSION with each
release of the fork (see FORK.md, "Versions"). FORK_COMMIT is the commit the image was built from,
passed in by build/pi/deploy.sh; empty when run from source.
"""
from __future__ import annotations

import os

FORK_VERSION = "1.1.0"
FORK_COMMIT = os.environ.get("VACUULA_FORK_COMMIT", "")
