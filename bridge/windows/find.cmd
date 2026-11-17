@echo off
cd /d "%~dp0"
title Dan Karting - find RentiX and decoder
dk-bridge.exe ports
echo.
dk-bridge.exe find
pause
