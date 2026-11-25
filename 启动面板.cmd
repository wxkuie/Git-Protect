@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo Install Node.js 24 or add it to PATH, then run this again.
  pause
  exit /b 1
)
echo Starting Git quiet-helper config panel...
echo Close this window to stop the panel.
echo.
node "工具\git-guard\panel.mjs"
if errorlevel 1 pause
