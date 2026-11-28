@echo off
setlocal
cd /d "%~dp0"
where pwsh >nul 2>nul
if not errorlevel 1 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
) else (
  rem 只有 PowerShell 5.1 的机器也要能卸载：卸载脚本只做删除，5.1 足够
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
)
pause
