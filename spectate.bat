@echo off
rem ---------------------------------------------------------------------------
rem  Rapfi Gomoku spectator
rem
rem  Opens the board on its own in a small app window that stays on top of
rem  every other window: tactics mode, hint on, no panels. Enter the moves of a
rem  game you are watching and the hint marks the engine's best move. The strip
rem  on the right picks your side; the engine then plays the other one.
rem
rem    spectate.bat          start the bridge if needed and open the window
rem
rem  Keys in the window: U undo, N new game, H hint on/off.
rem  Right-drag on the board works even while another program has the focus:
rem  hold the right button over the board, move, and let go to play there.
rem  Stop the bridge with: windows_play.bat stop
rem ---------------------------------------------------------------------------
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if not defined PORT set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%/?spectate"
set "PROFILE=%LocalAppData%\RapfiGomoku\spectator"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run the Rapfi bridge.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

call :is_running
if errorlevel 1 (
  echo Starting the Rapfi bridge in a minimised window...
  start "Rapfi bridge" /min cmd /c node server.js
  for /l %%i in (1,1,90) do (
    call :is_running
    if not errorlevel 1 goto :ready
    ping -n 2 127.0.0.1 >nul 2>&1
  )
  echo Gave up waiting for the bridge on port %PORT%.
  pause
  exit /b 1
)
:ready

call :find_browser
if not defined BROWSER (
  echo Neither Chrome nor Edge was found, and an app window needs one of them.
  pause
  exit /b 1
)

rem A profile of its own makes this a separate browser process, so the window
rem is easy to find and your normal Chrome windows are left alone. Run again
rem while it is open, Chrome just brings up a second board window.
start "" "!BROWSER!" --app="%URL%" --user-data-dir="%PROFILE%" --window-size=580,560 --no-first-run --no-default-browser-check --disable-features=Translate

rem Chrome resets a window's z-order on its own, so pinning it once is not
rem enough: a hidden watcher keeps it on top until the window closes. The same
rem process reads the mouse for the right-drag cursor.
start "" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText('%~f0'); iex ($s -split ('#' + 'POWERSHELL' + '#'))[1]"
exit /b 0

rem ------------------------------------------------------------------ helpers

:is_running
curl -s -o nul --max-time 2 "http://127.0.0.1:%PORT%/api/status" >nul 2>&1
exit /b %errorlevel%

:find_browser
set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER for /f "usebackq skip=2 tokens=2,*" %%A in (`reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul`) do set "BROWSER=%%B"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
exit /b 0

rem The watcher. cmd never reads past the exit above, so what follows the
rem marker is only ever run by PowerShell, and it does two jobs.
rem
rem Keeping the window on top: Chrome drops the topmost flag unless its window
rem has focus when the flag is set, so the watcher brings the window forward
rem once, pins it, and pins it again whenever it has focus and has lost the flag.
rem
rem The right-drag cursor: the game being watched has the focus, so the page
rem never sees the mouse. Raw input still reaches a background window, so the
rem watcher registers for it and posts where the pointer is on screen as the
rem right button goes down, while it is held and as it comes up, to the bridge,
rem which relays them to the page.
rem
rem It quits once no spectator window (found by the title app.js gives it) is
rem left.
#POWERSHELL#
$mutex = New-Object Threading.Mutex($false, 'Local\RapfiGomokuSpectatorPin')
if (-not $mutex.WaitOne(0)) { exit }   # another watcher already has it

Add-Type -Name Win -Namespace Spectator -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")]
public static extern int GetWindowLong(IntPtr hWnd, int index);
[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Spectator {
  // A hidden window that receives raw mouse input even while another program
  // has the focus. Positions are in physical pixels, so the process is made DPI
  // aware first. Events are batched and posted every 20ms from a thread of
  // their own, so a slow request never holds up reading the mouse.
  public class RightDrag : NativeWindow {
    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }

    [DllImport("user32.dll")]
    static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT point);
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);

    const int WM_INPUT = 0x00FF;
    const uint RID_INPUT = 0x10000003;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const ushort RIGHT_DOWN = 0x0004, RIGHT_UP = 0x0008;

    readonly string url;
    readonly object gate = new object();
    readonly List<string> pending = new List<string>();
    bool held, moved;

    public RightDrag(int port) {
      url = "http://127.0.0.1:" + port + "/api/cursor";
      SetProcessDPIAware();
      CreateHandle(new CreateParams());
      var device = new RAWINPUTDEVICE { UsagePage = 1, Usage = 2, Flags = RIDEV_INPUTSINK, Target = Handle };
      if (!RegisterRawInputDevices(new[] { device }, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)))) {
        throw new InvalidOperationException("raw mouse input could not be registered");
      }
      var sender = new Thread(Post);
      sender.IsBackground = true;
      sender.Start();
    }

    protected override void WndProc(ref Message m) {
      if (m.Msg == WM_INPUT) Read(m.LParam);
      base.WndProc(ref m);
    }

    void Read(IntPtr handle) {
      uint header = (uint)(IntPtr.Size == 8 ? 24 : 16);
      uint size = 0;
      GetRawInputData(handle, RID_INPUT, IntPtr.Zero, ref size, header);
      if (size == 0) return;
      IntPtr buffer = Marshal.AllocHGlobal((int)size);
      try {
        if (GetRawInputData(handle, RID_INPUT, buffer, ref size, header) != size) return;
        if (Marshal.ReadInt32(buffer, 0) != 0) return;            // not a mouse
        int at = (int)header;                                      // RAWMOUSE
        ushort buttons = (ushort)Marshal.ReadInt16(buffer, at + 4);
        lock (gate) {
          if ((buttons & RIGHT_DOWN) != 0 && !held) { held = true; pending.Add(Event("down")); }
          else if (held) moved = true;
          if ((buttons & RIGHT_UP) != 0 && held) { held = false; FlushMove(); pending.Add(Event("up")); }
        }
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    // Where the pointer is now. Movement between two posts is sent once, as
    // the latest position.
    string Event(string phase) {
      POINT p;
      GetCursorPos(out p);
      return "{\"phase\":\"" + phase + "\",\"x\":" + p.X + ",\"y\":" + p.Y + "}";
    }

    void FlushMove() {
      if (!moved) return;
      pending.Add(Event("move"));
      moved = false;
    }

    void Post() {
      while (true) {
        Thread.Sleep(20);
        string body;
        lock (gate) {
          FlushMove();
          if (pending.Count == 0) continue;
          body = "{\"events\":[" + string.Join(",", pending.ToArray()) + "]}";
          pending.Clear();
        }
        try {
          var request = (HttpWebRequest)WebRequest.Create(url);
          request.Method = "POST";
          request.Proxy = null;            // proxy detection alone can take seconds
          request.ContentType = "application/json";
          request.Timeout = 1000;
          byte[] data = Encoding.UTF8.GetBytes(body);
          request.ContentLength = data.Length;
          using (var stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
          using (request.GetResponse()) { }
        } catch (Exception) {
          // The bridge is down or busy; these events are simply lost.
        }
      }
    }
  }
}
'@

$User32 = [Spectator.Win]
$HWND_TOPMOST = [IntPtr](-1)
$SWP_NOSIZE_NOMOVE = 0x0003
$VK_MENU = 0x12
$KEYUP = 0x2

$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$drag = New-Object Spectator.RightDrag $port

function Test-Topmost($h) { ($User32::GetWindowLong($h, -20) -band 0x8) -ne 0 }

# Waits while still handing the raw input messages to the hidden window.
function Wait-Pumping($ms) {
  $until = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $until) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 5
  }
}

$titles = 'Gomoku spectator', 'Q3_forecast_v7.xlsx'
$started = Get-Date
$brought = @{}
while ($true) {
  $windows = @(Get-Process chrome, msedge -ErrorAction SilentlyContinue |
    Where-Object { $titles -contains $_.MainWindowTitle })
  if ($windows.Count) {
    foreach ($proc in $windows) {
      $h = $proc.MainWindowHandle
      if (Test-Topmost $h) { continue }
      if (-not $brought.ContainsKey([string]$h)) {
        # A tap of Alt lets a background process hand the focus over.
        $User32::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
        $User32::keybd_event($VK_MENU, 0, $KEYUP, [UIntPtr]::Zero)
        [void]$User32::SetForegroundWindow($h)
        Wait-Pumping 200
        $brought[[string]$h] = $true
      }
      if ($User32::GetForegroundWindow() -eq $h) {
        [void]$User32::SetWindowPos($h, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOSIZE_NOMOVE)
      }
    }
  } elseif ($brought.Count -or ((Get-Date) - $started).TotalSeconds -gt 60) {
    exit
  }
  Wait-Pumping 500
}
