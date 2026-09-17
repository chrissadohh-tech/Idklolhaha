@echo off
setlocal
cd /d "%~dp0"
if not exist "or-agent.exe" (
  echo or-agent.exe is missing from this folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath '%~dp0or-agent.exe' } catch {}" >nul 2>&1
start "" "%~dp0or-agent.exe"
if errorlevel 1 (
  echo Windows refused to start or-agent.exe.
  echo Right-click or-agent.exe - Properties - Unblock - Apply, then try again.
  pause
)
