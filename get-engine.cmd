@echo off
rem Downloads the Rapfi release this project drives and unpacks the Windows
rem build, its weights and its config into engine\. Those files are committed to
rem this repository, so this is only needed to restore them; see README.md.
setlocal
cd /d "%~dp0"

set "TAG=250615"
set "URL=https://github.com/dhbloo/rapfi/releases/download/%TAG%/Rapfi-engine.7z"
set "ARCHIVE=%TEMP%\Rapfi-engine-%TAG%.7z"
rem Named in full because a GNU tar earlier on PATH reads C:\... as a remote host.
set "WINTAR=%SystemRoot%\System32\tar.exe"

echo Downloading Rapfi %TAG% engine package, about 35 MB.
curl -L --fail --progress-bar -o "%ARCHIVE%" "%URL%"
if errorlevel 1 (
  echo Download failed.
  pause
  exit /b 1
)

if not exist "%WINTAR%" (
  echo %WINTAR% is missing. Windows 10 1803 or newer provides it.
  pause
  exit /b 1
)

if not exist engine mkdir engine
echo Unpacking the Windows builds, weights and config.
"%WINTAR%" -xf "%ARCHIVE%" -C engine "pbrain-rapfi-windows-*.exe" "*.bin" "*.bin.lz4" config.toml AUTHORS
if errorlevel 1 (
  echo Unpack failed.
  pause
  exit /b 1
)

del "%ARCHIVE%" >nul 2>nul
echo.
echo Done. Run windows_play.bat to start.
