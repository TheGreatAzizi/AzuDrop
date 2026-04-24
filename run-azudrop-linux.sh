#!/bin/sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js LTS and run this file again."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing AzuDrop dependencies..."
  npm install || exit 1
fi
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3000" >/dev/null 2>&1 &
fi
echo "Starting AzuDrop..."
echo "Keep this window open while using AzuDrop."
npm start
