@echo off
rem ============================================================================
rem  ORscript - start the agent with the Python Studio MCP host.
rem
rem  ZeroScript's method, kept exactly: their Studio layer is Python, so nothing
rem  ever has to be compiled. This file finds Python the same way their start.bat
rem  does, points or-agent.exe at studio_mcp_host.py via OR_MCP_COMMAND, checks
rem  the host can see Studio, then starts the agent as usual.
rem
rem  Double-click THIS file instead of or-agent.exe.
rem ============================================================================
setlocal
cd /d "%~dp0"
set "HOST=studio_mcp_host.py"
set "WRAP=%CD%\or_mcp_host.bat"

rem ── 0. Only one agent may hold the bridge port. A still-running agent would
rem      keep port 3000, so the new one would be ignored AND OR_MCP_COMMAND
rem      (read when the agent starts) would never apply. ZeroScript kills its
rem      old bridge for the same reason.
tasklist /FI "IMAGENAME eq or-agent.exe" 2>nul | find /i "or-agent.exe" >nul
if not errorlevel 1 (
  echo [OR] An or-agent.exe is already running - closing it first.
  taskkill /F /IM or-agent.exe >nul 2>nul
  timeout /t 2 /nobreak >nul
)

rem ── 1. Find Python. py first (never the Microsoft Store stub), then python,
rem      then the standard install folders - a winget/installer run without
rem      "Add to PATH" leaves neither on PATH.
echo [OR] Looking for Python...
set "PY="
for %%C in ("py -3" "python") do (
  if not defined PY call :validate_py %%~C && set "PY=%%~C"
)
if not defined PY (
  for %%R in ("%LOCALAPPDATA%\Programs\Python" "%ProgramFiles%" "%ProgramFiles(x86)%") do (
    if exist "%%~R" (
      for /f "delims=" %%D in ('dir /b /ad /o-n "%%~R\Python3*" 2^>nul') do (
        if not defined PY (
          if exist "%%~R\%%D\python.exe" call :validate_py "%%~R\%%D\python.exe" && set "PY="%%~R\%%D\python.exe""
        )
      )
    )
  )
)
if not defined PY goto :no_python
for /f "tokens=*" %%v in ('call %PY% --version 2^>^&1') do echo [OR] Python: %PY% %%v

rem ── 2. Point the agent at the host. OR_MCP_COMMAND is split on spaces by the
rem      agent, so an interpreter path containing spaces goes through a tiny
rem      wrapper .bat, run with cmd /C - the same way the agent runs Roblox's
rem      own mcp.bat.
echo %PY% | find " " >nul
if errorlevel 1 (
  set "OR_MCP_COMMAND=%PY% %HOST%"
  if exist "%WRAP%" del "%WRAP%" >nul 2>nul
) else (
  >"%WRAP%" echo @echo off
  >>"%WRAP%" echo %PY% "%%~dp0%HOST%" %%*
  set "OR_MCP_COMMAND=cmd /C or_mcp_host.bat"
  echo [OR] Interpreter path has spaces - using or_mcp_host.bat as the command.
)
echo [OR] OR_MCP_COMMAND = %OR_MCP_COMMAND%

rem ── 3. Prove the host finds Studio BEFORE the agent depends on it.
echo.
call %PY% %HOST% --check
echo.

rem ── 4. Start the agent and wait for its bridge port.
echo [OR] Starting or-agent.exe...
start "" "%CD%\or-agent.exe"
set "TRIES=0"
:wait
netstat -ano -p TCP | find ":3000" | find "LISTENING" >nul
if not errorlevel 1 goto :up
timeout /t 1 /nobreak >nul
set /a TRIES+=1
if %TRIES% lss 10 goto :wait
echo [OR] WARNING: nothing is listening on port 3000 yet - check the OR window.
goto :done
:up
echo [OR] Bridge is listening on port 3000.
:done
echo.
echo [OR] TOOLS should now read 28 (Studio's 27 plus or_host_read_image).
echo [OR] If it still reads 27, the agent did not get OR_MCP_COMMAND.
echo [OR] Host log: studio_mcp_host.log
timeout /t 8 /nobreak >nul
exit /b 0

:no_python
echo.
echo [OR] ERROR: Python 3 was not found on PATH or in the usual install folders.
echo [OR] The capture fix needs it (ZeroScript needs it too): Studio sends the
echo [OR] picture as an MCP image item, and only this host can carry it past the
echo [OR] old or-agent.exe binary.
echo.
echo [OR] Install Python 3 from python.org and tick "Add python.exe to PATH",
echo [OR] then run this file again. Studio and Blender tools work either way.
echo.
pause
exit /b 1

:validate_py
rem A Microsoft Store "python" is a stub that fails silently, so run it for real.
rem %1 keeps its quotes here on purpose (paths with spaces), and call re-parses
rem the line so a quoted path is not mangled.
call %1 -c "import sys" >nul 2>nul
exit /b %errorlevel%
