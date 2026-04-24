@echo off
setlocal
cd /d "%~dp0"
title AzuDrop
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Please install Node.js LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing AzuDrop dependencies...
  call npm install
  if errorlevel 1 (
    echo Installation failed.
    pause
    exit /b 1
  )
)
start "" "http://localhost:3000"
echo Starting AzuDrop...
echo Keep this window open while using AzuDrop.
npm start
pause
