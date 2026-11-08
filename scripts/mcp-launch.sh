#!/usr/bin/env bash
# Starts the gpt-image MCP server from this checkout. Installs + builds on first run (or when src/
# changed), so a fresh cloud session needs no manual setup. stdout is reserved for MCP — all
# install/build output goes to stderr.
set -e
cd "$(dirname "$0")/.."
if [ ! -d node_modules/@modelcontextprotocol ] || [ ! -d node_modules/playwright ]; then
  npm ci --no-audit --no-fund --loglevel=error >&2 || npm install --no-audit --no-fund --loglevel=error >&2
fi
if [ ! -f dist/cli.js ] || [ -n "$(find src -newer dist/cli.js -print -quit)" ]; then
  npm run build --silent >&2
fi
# Save images inside the project so they're easy to open, unless told otherwise.
export GPT_IMAGE_OUTPUT_DIR="${GPT_IMAGE_OUTPUT_DIR:-$PWD/generated-images}"
exec node dist/cli.js "$@"
