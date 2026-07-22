# System Monitor - Start/Stop Guide

## How to Start

```bash
cd desktop
npm start
```

The app will:
- Open in a **transparent frosted-glass window**
- Add an **icon to system tray** (bottom-right corner near clock)
- **NOT show in taskbar** (invisible to interviewer)
- Register **global keyboard shortcut: `Alt+.`** (Windows) or `Cmd+.`** (Mac)

## How to Show/Hide the Window

### Method 1: Global Keyboard Shortcut (Fastest)
- **Windows:** Press `Alt+.` to show/hide
- **Mac:** Press `Cmd+.` to show/hide
- Works from anywhere, even when in other apps during interview

### Method 2: System Tray Icon

**Right-click the tray icon** (bottom-right corner) to see menu:
- **Show System Monitor** - Open the window
- **Hide** - Hide the window (keeps running in background)
- **Quit** - Fully close the app

**Left-click the tray icon** - Toggle show/hide window

## How to Stop Properly

### Method 1: From System Tray (Recommended)
1. Right-click the tray icon (bottom-right)
2. Click "Quit"

### Method 2: From PowerShell/Terminal
```powershell
# Stop all Electron processes
Stop-Process -Name "electron" -Force

# Or more specific (Windows)
taskkill /F /IM electron.exe
```

### Method 3: From Task Manager
1. Press `Ctrl+Shift+Esc`
2. Find "Electron" process
3. Right-click → End task

## If App Gets Stuck

```powershell
# Kill all Electron processes forcefully
Stop-Process -Name "electron" -Force -ErrorAction SilentlyContinue

# Then restart
cd desktop
npm start
```

## Transparency Controls

Once the app is open:
- **Slider at bottom** - Smooth gradient from 0-100
  - 0 = Solid opaque (easiest to read)
  - 50 = Medium transparency
  - 100 = Maximum glass effect (most stealthy)
- **Keyboard shortcuts:**
  - Hold `g` + press `+` to increase by 5 points
  - Hold `g` + press `-` to decrease by 5 points

The window uses **backdrop-filter blur** with smooth transitions for every value.

## Frameless Window & Cursor

The window has **no titlebar** (for better transparency):
- **To move window:** Click and drag the **header bar** (top bar with "System Monitor")
- **Normal cursor:** Appears on all buttons, inputs, and content areas
- **Move cursor:** Only appears on the header bar for dragging

## Quick Troubleshooting

**Problem:** Window disappeared after clicking X
- **Solution:** Press `Alt+.` (Windows) or `Cmd+.` (Mac), OR check system tray icon (bottom-right) and click it

**Problem:** Can't find system tray icon
- **Solution:** Click the up arrow (^) in system tray to show hidden icons, OR use `Alt+.` shortcut

**Problem:** App won't start
- **Solution:** 
  ```bash
  # Kill any stuck processes
  Stop-Process -Name "electron" -Force
  
  # Reinstall dependencies
  cd desktop
  npm install
  npm start
  ```

**Problem:** Want to completely quit
- **Solution:** Right-click tray icon → Quit (or use `Stop-Process` command)
