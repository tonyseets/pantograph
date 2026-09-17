#!/bin/bash
# Download one Figma MCP asset URL into a page's asset dir, named by content hash.
# usage: fetch-asset.sh <url> [ext]           (run from .figma/<page>/)
#        FIGMA_PAGE_DIR=.figma/pricing fetch-asset.sh <url> [ext]
# Prints the path it wrote, relative to the page dir. A browser UA is required:
# the Figma CDN's WAF returns empty bodies to plain curl, which then hash identically.
set -e
cd "${FIGMA_PAGE_DIR:-$PWD}"
mkdir -p assets
URL="$1"; EXT="${2:-${URL##*.}}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
TMP=$(mktemp)
curl -sL -A "$UA" -o "$TMP" "$URL"
if [ ! -s "$TMP" ]; then echo "EMPTY: $URL" >&2; rm -f "$TMP"; exit 1; fi
H=$(shasum -a 256 "$TMP" | cut -c1-16)
mv "$TMP" "assets/$H.$EXT"
echo "assets/$H.$EXT"
