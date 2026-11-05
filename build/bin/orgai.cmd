@echo off
rem The orgai command of a packaged OrgAI (cli-spec 7, Wave 6): runs OrgAI.exe as Node on the CLI bundle.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\OrgAI.exe" "%~dp0..\app.asar.unpacked\out\cli\orgai.mjs" %*
exit /b %ERRORLEVEL%
