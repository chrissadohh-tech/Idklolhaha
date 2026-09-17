@echo off
rem ============================================================================
rem  ORscript - start the agent with the Python Studio MCP host.
rem
rem  ZeroScript's trick, kept: their Studio layer is Python, so nothing has to
rem  be compiled. This sets OR_MCP_COMMAND to studio_mcp_host.py and then starts
rem  or-agent.exe exactly as before - the host finds your Studio (newest
rem  StudioMCP.exe, so a Studio update cannot break it) and hands screen captures
rem  back as real images.
rem
rem  Double-click THIS file instead of or-agent.exe.
rem ============================================================================
setlocal
cd /d "%~dp0"
set "PY="
for %%C in (py python python3) do (
  if not defined PY %%~C -c "import sys" >nul 2>nul && set "PY=%%C"
)
if not defined PY (
  echo [OR] Python 3 was not found on PATH.
  echo [OR] Captures need it ^(Studio sends the picture as an MCP image item^).
  echo [OR] Install Python 3 from python.org - tick "Add python.exe to PATH" - and
  echo [OR] run this file again. Blender tools do not need Python.
  echo [OR]
  echo [OR] Starting the agent anyway...
  start "" "%~dp0or-agent.exe"
  exit /b 1
)
set "OR_MCP_COMMAND=%PY% studio_mcp_host.py"
echo [OR] Python          : %PY%
echo [OR] Studio MCP host : studio_mcp_host.py
echo [OR] Log             : studio_mcp_host.log
echo [OR]
%PY% studio_mcp_host.py --check
echo [OR]
start "" "%~dp0or-agent.exe"
endlocal
