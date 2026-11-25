@echo off
rem Double-click to install what is missing and open Anime Element Studio.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
