@echo off
rem dsh-session-groups one-click install / update (calls install.ps1)
rem Double-click to run. Optional argument: check / update / install
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
