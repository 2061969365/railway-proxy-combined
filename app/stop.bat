@echo off
setlocal enabledelayedexpansion
set PORT=4096
for /f "tokens=2 delims=:" %%a in ('findstr /R "\"port\"" config\settings.json 2^>nul') do (
  set TMP=%%a
  set TMP=!TMP: =!
  set TMP=!TMP:,=!
  set TMP=!TMP:"=!
  if not "!TMP!"=="" set PORT=!TMP!
)
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R ":%PORT% .*LISTENING"') do (
  tasklist /FI "PID eq %%p" 2>nul | findstr /I "node.exe" >nul
  if !errorlevel! equ 0 (
    echo Stopping node PID %%p on port %PORT%
    taskkill /f /pid %%p >nul 2>&1
    set FOUND=1
  )
)
REM Also kill orphan node proxies via pid.json
if exist config\pid.json (
  for /f "tokens=2 delims=:, " %%p in ('findstr /R "\"pid\"" config\pid.json 2^>nul') do (
    set PID=%%p
    set PID=!PID:,=!
    set PID=!PID:}=!
    taskkill /f /pid !PID! >nul 2>&1
    if !errorlevel! equ 0 echo Stopped orphan PID !PID! via pid.json
    set FOUND=1
  )
  del /f /q config\pid.json 2>nul
)
REM Fallback: kill any node with server.js
if %FOUND%==0 (
  for /f "tokens=2" %%p in ('tasklist ^| findstr /I "node.exe"') do (
    wmic process where "ProcessId=%%p" get CommandLine 2>nul | findstr /I "server.js" >nul
    if !errorlevel! equ 0 (
      echo Stopping orphan proxy PID %%p
      taskkill /f /pid %%p >nul 2>&1
      set FOUND=1
    )
  )
)
if %FOUND%==0 echo No node process found on port %PORT%
echo OpenCode Free Proxy stopped
timeout /t 2 >nul
