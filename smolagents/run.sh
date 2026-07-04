#!/usr/bin/env bash
# Launch the lexis smolagents harness web app.
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m lexis_smol.server
