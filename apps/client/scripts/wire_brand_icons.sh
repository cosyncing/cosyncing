#!/usr/bin/env bash
# Wire the locked brand assets into the platform build trees. Run from
# anywhere; paths are resolved from this script's location, never from the
# caller's working directory.
#
# Rasterization uses a pinned CairoSVG in an isolated venv under
# apps/client/output/ (generated scratch, not committed) so a fresh
# environment reproduces the exact same rasters.
set -euo pipefail

CLIENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
VENV="${CLIENT_ROOT}/output/brand/.venv-export"
CAIROSVG_VERSION="2.7.1"

if [ ! -x "${VENV}/bin/python" ]; then
  python3 -m venv "${VENV}"
  "${VENV}/bin/pip" -q install "cairosvg==${CAIROSVG_VERSION}"
fi

installed="$("${VENV}/bin/pip" show cairosvg 2>/dev/null | sed -n 's/^Version: //p' || true)"
if [ "${installed}" != "${CAIROSVG_VERSION}" ]; then
  "${VENV}/bin/pip" -q install "cairosvg==${CAIROSVG_VERSION}"
fi

"${VENV}/bin/python" "${CLIENT_ROOT}/scripts/wire_brand_icons.py"
