@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it, then double-click start.cmd again.
  pause
  exit /b 1
)
node tools/start-app.cjs
if errorlevel 1 pause
