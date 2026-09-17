@echo off
rem ============================================================================
rem  ORscript - start the agent with the Python Studio MCP host.
rem
rem  Only needed while or-agent.exe is older than 1.18.1 (the rebuilt agent
rem  carries Studio's MCP image item itself). ZeroScript's method, kept exactly:
rem  their Studio layer is Python, so nothing has to be compiled.
rem
rem  This window NEVER closes by itself - every step it prints stays on screen,
rem  and the same lines are appended to or_agent_start.log next to this file.
rem
rem  Double-click THIS file instead of or-agent.exe.
rem ============================================================================
setlocal
cd /d "%~dp0"
title ORscript agent launcher
set "HOST=studio_mcp_host.py"
set "HL="%CD%\studio_mcp_host.log""
set "LOG="%CD%\or_agent_start.log""
set "CHK="%TEMP%\or_host_check.txt""
set "WRAP="%CD%\or_mcp_host.bat""
set "STAMP=%DATE% %TIME%"
call :say ""
call :say "=== ORscript agent launcher - %STAMP% ==="

rem ── 0. One agent only: an old process keeps port 3000 AND would still be the
rem      one without the host, and OR_MCP_COMMAND is read when a process starts.
tasklist /FI "IMAGENAME eq or-agent.exe" 2>nul | find /i "or-agent.exe" >nul
if not errorlevel 1 (
  call :say "Closing the running or-agent.exe (it owns port 3000)..."
  taskkill /F /IM or-agent.exe >nul 2>nul
  timeout /t 2 /nobreak >nul
)

rem ── 1. Find Python: py -3 (never the Microsoft Store stub), then python, then
rem      the standard install folders - an install without "Add to PATH" works.
call :say "Looking for Python..."
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
for /f "tokens=*" %%v in ('call %PY% --version 2^>^&1') do call :say "Python: %PY%  (%%v)"

rem ── 2. Build the command the agent runs. It splits OR_MCP_COMMAND on spaces, so
rem      an interpreter path with spaces (or the py launcher's own "-3") goes
rem      through a generated one-line wrapper, which the agent runs via cmd /C.
>"%WRAP%" echo @echo off
>>"%WRAP%" echo %PY% "%%~dp0%HOST%" %%*
set "OR_MCP_COMMAND=cmd /C or_mcp_host.bat"
call :say "Wrapper: %WRAP%"
call :say "OR_MCP_COMMAND=%OR_MCP_COMMAND%"

rem Make it stick for every future start (short 8.3 path = no spaces to split on).
for %%I in (%WRAP%) do set "WRAP8=%%~sI"
echo %WRAP8% | find " " >nul
if errorlevel 1 (
  setx OR_MCP_COMMAND "cmd /C %WRAP8%" >nul 2>nul
  if errorlevel 1 (call :say "Note: could not store the setting for future starts.") else (call :say "Stored permanently: every future or-agent.exe start uses the host.")
) else (
  call :say "Note: this folder has spaces and 8.3 names are off - double-click this file each time."
)

rem ── 3. Prove the host can see Studio BEFORE the agent depends on it.
call :say ""
call %PY% %HOST% --check >"%CHK%" 2>&1
type "%CHK%" >>"%LOG%"
type "%CHK%"
del "%CHK%" >nul 2>nul
echo. >>"%LOG%"

rem ── 4. Start the agent, then check that the host was actually spawned.
for %%F in (%HL%) do set "LOGSIZE=%%~zF"
call :say ""
call :say "Starting or-agent.exe..."
start "" "%CD%\or-agent.exe"
set "TRIES=0"
:wait
netstat -ano -p TCP | find ":3000" | find "LISTENING" >nul
if not errorlevel 1 goto :up
timeout /t 1 /nobreak >nul
set /a TRIES+=1
if %TRIES% lss 15 goto :wait
call :say "WARNING: nothing is listening on port 3000 after 15s - check the OR window."
goto :hostcheck
:up
call :say "Bridge is listening on port 3000."
set "TRIES=0"
:hostcheck
for %%F in (%HL%) do set "NOW=%%~zF"
if "%NOW%"=="%LOGSIZE%" (
  if %TRIES% lss 12 (
    timeout /t 1 /nobreak >nul
    set /a TRIES+=1
    goto :hostcheck
  )
)
for %%F in (%HL%) do set "NOW=%%~zF"
echo.
if "%NOW%"=="%LOGSIZE%" goto :host_missing
call :say "OK: the Python host is running (studio_mcp_host.log grew)."
call :say "In OR, TOOLS must read 28. If it still says 27, close the OR window"
call :say "completely and start it again from this file."
goto :end

:host_missing
call :say "PROBLEM: the host did NOT start, so the agent is running WITHOUT it."
call :say "That is why captures stay empty (TOOLS 27)."
call :say "Check the output above: Python missing, or the check reported no StudioMCP."
call :say "Log: %LOG%"
goto :end

:end
echo.
echo Press any key to close this window.
pause >nul
exit /b 0

:no_python
call :say ""
call :say "ERROR: Python 3 was not found on PATH or in the usual install folders."
call :say "The capture fix needs it - ZeroScript needs it too. Studio's picture is"
call :say "an MCP image item, and only this host can carry it past the old binary."
call :say ""
call :say "Install Python 3 from python.org, tick \"Add python.exe to PATH\", then"
call :say "run this file again. Everything else already works without it."
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

:validate_py
rem A Microsoft Store "python" is a stub that silently fails, so run it for real.
call %1 -c "import sys" >nul 2>nul
exit /b %errorlevel%

:say
echo %~1
echo %~1 >>"%LOG%"
exit /b 0
