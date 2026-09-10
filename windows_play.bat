@echo off
rem ---------------------------------------------------------------------------
rem  Rapfi Gomoku launcher
rem
rem    windows_play.bat            start the bridge and open the board in a Chrome tab
rem    windows_play.bat stop       stop a running bridge
rem    windows_play.bat rescan     forget the cached CPU build and probe again
rem    windows_play.bat chrome     show which Chrome would be used, without opening it
rem ---------------------------------------------------------------------------
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if not defined PORT set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%"

if /i "%~1"=="--open-when-ready" goto :open_when_ready
if /i "%~1"=="stop"    goto :stop
if /i "%~1"=="rescan"  goto :rescan
if /i "%~1"=="chrome"  goto :which_chrome
if /i "%~1"=="/?"      goto :usage
if /i "%~1"=="help"    goto :usage
if not "%~1"=="" goto :usage

rem --------------------------------------------------------------------- start

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run the Rapfi bridge.
  echo Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "server.js" (
  echo server.js is missing - run this from the gomoku folder.
  pause
  exit /b 1
)

call :is_running
if not errorlevel 1 (
  echo Bridge is already running on %URL%
  call :open_chrome
  exit /b 0
)

echo Rapfi Gomoku
echo   serving %URL%   ^(close this window or press Ctrl+C to stop^)
echo.

rem Open the browser from a second copy of this script, once the port answers,
rem so the server itself can stay in the foreground and own Ctrl+C.
start "" /b "%~f0" --open-when-ready

node server.js
exit /b %errorlevel%

rem ------------------------------------------------------- wait, then open

:open_when_ready
for /l %%i in (1,1,90) do (
  call :is_running
  if not errorlevel 1 goto :open_now
  call :sleep1
)
echo.
echo Gave up waiting for %URL% to answer.
exit /b 1

:open_now
call :open_chrome
exit /b 0

rem ------------------------------------------------------------ chrome lookup

:find_chrome
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME for /f "usebackq skip=2 tokens=2,*" %%A in (`reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul`) do set "CHROME=%%B"
if not defined CHROME for /f "delims=" %%P in ('where chrome 2^>nul') do if not defined CHROME set "CHROME=%%P"
exit /b 0

:open_chrome
call :find_chrome
if defined CHROME (
  rem A plain URL goes to the Chrome that is already running, as a new tab in
  rem your own profile, rather than starting a second instance of it.
  start "" "!CHROME!" "%URL%"
) else (
  echo Chrome was not found - opening your default browser instead.
  start "" "%URL%"
)
exit /b 0

:which_chrome
call :find_chrome
if defined CHROME (
  echo Chrome:  !CHROME!
) else (
  echo Chrome was not found. The launcher would use your default browser.
)
echo URL:     %URL%
exit /b 0

rem -------------------------------------------------------------------- misc

:is_running
curl -s -o nul --max-time 2 "%URL%/api/status" >nul 2>&1
exit /b %errorlevel%

rem `timeout` aborts outright when stdin is redirected, which is exactly the
rem case for the background copy of this script, so wait with ping instead.
:sleep1
ping -n 2 127.0.0.1 >nul 2>&1
exit /b 0

:stop
set "KILLED="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:"LISTENING" ^| findstr /c:":%PORT% "') do (
  taskkill /pid %%P /f >nul 2>&1
  if not errorlevel 1 set "KILLED=1"
)
if defined KILLED (
  echo Stopped the bridge on port %PORT%.
) else (
  echo Nothing was listening on port %PORT%.
)
exit /b 0

:rescan
if exist "engine\selected-build.json" (
  del /q "engine\selected-build.json"
  echo Cleared the cached build choice - the next start will probe your CPU again.
) else (
  echo No cached build choice to clear.
)
exit /b 0

:usage
echo Usage:
echo   windows_play.bat            start the bridge and open the board in a Chrome tab
echo   windows_play.bat stop       stop a running bridge
echo   windows_play.bat rescan     forget the cached CPU build and probe again
echo   windows_play.bat chrome     show which Chrome would be used, without opening it
exit /b 0
