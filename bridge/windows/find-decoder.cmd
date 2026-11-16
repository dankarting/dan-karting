@echo off
cd /d "%~dp0"
dk-bridge.exe ports
echo.
dk-bridge.exe find
pause
