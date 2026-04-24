#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install Node.js LTS from https://nodejs.org/ and run this file again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing AzuDrop dependencies..."
  npm install || { read -n 1 -s -r -p "Install failed. Press any key..."; exit 1; }
fi
open "http://localhost:3000"
echo "Starting AzuDrop..."
echo "Keep this window open while using AzuDrop."
npm start
