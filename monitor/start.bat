@echo off
:: Agent Monitor — Windows launcher
:: Double-click to run manually, or add to Task Scheduler.
:: Output is always saved to agent-monitor.log in this folder.

cd /d "%~dp0"

echo [%date% %time%] Running agent capture... >> agent-monitor.log 2>&1
node agent.js >> agent-monitor.log 2>&1

if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] agent.js exited with code %ERRORLEVEL% >> agent-monitor.log 2>&1
)

:: Show last 20 lines of log so you can see what happened
echo.
echo === Last output ===
powershell -command "Get-Content agent-monitor.log -Tail 20"
echo.
pause
