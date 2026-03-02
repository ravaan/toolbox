@echo off
setlocal
set "SCRIPT=%~dp0claude-box"
set "SCRIPT=%SCRIPT:\=/%"
"C:\Program Files\Git\bin\bash.exe" "%SCRIPT%" %*
