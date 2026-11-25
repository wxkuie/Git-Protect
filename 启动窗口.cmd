@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed.
  echo Run: npm install
  echo If the binary download fails, set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ first.
  pause
  exit /b 1
)
rem Clear this so electron.exe runs as the app, not as plain node
set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .
