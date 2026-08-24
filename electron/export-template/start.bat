@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" "http://localhost:__PORT__"
"%~dp0runtime\python\python.exe" "%~dp0la_main.py" --serve --port __PORT__
pause
