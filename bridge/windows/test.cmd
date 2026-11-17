@echo off
cd /d "%~dp0"
title Dan Karting - timing test (read only, nothing is sent)
dk-bridge.exe listen
pause
