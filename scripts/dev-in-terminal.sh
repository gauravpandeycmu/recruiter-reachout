#!/usr/bin/env bash
# Thin wrapper — prefer: npm run dev:terminal
exec node "$(cd "$(dirname "$0")" && pwd)/dev-in-terminal.mjs"
