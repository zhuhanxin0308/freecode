@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.freecode"
"%~dp0..\..\..\..\free code.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
