const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, desktopCapturer, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Backend } = require('./backend');

const SOURCE_FILES = [
  'main.js',
  'backend.js',
  'lib-providers.js',
  'preload.js',
  'renderer/index.html',
  'renderer/styles.css',
  'renderer/app.js',
  'renderer/audio-manager.js',
  'renderer/audio-worklet.js',
];

function getSourceVersion() {
  return SOURCE_FILES.reduce((latest, relativePath) => {
    try {
      return Math.max(latest, fs.statSync(path.join(__dirname, relativePath)).mtimeMs);
    } catch {
      return latest;
    }
  }, 0);
}

const startupSourceVersion = getSourceVersion();

function relaunchWithLatestCode() {
  // Remove --hidden so a hotkey-triggered refresh opens visibly after relaunch.
  const args = process.argv.slice(1).filter(arg => arg !== '--hidden');
  app.relaunch({ args });
  app.isQuitting = true;
  app.quit();
}

// Speaker/system audio ONLY — never grant the microphone
function setupSystemAudioCapture() {
  // Block mic/camera device access entirely (speaker-out loopback is via display media)
  session.defaultSession.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'microphone' || details.deviceType === 'camera') {
      console.log(`[main] Denied ${details.deviceType} (speaker-loopback only)`);
      return false;
    }
    return true;
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    // Allow display-media / generic media for loopback; never treat as mic grant
    if (permission === 'media' || permission === 'display-capture') {
      // If this request is explicitly for microphone, deny
      const types = details?.mediaTypes || [];
      if (types.length && types.every((t) => t === 'audio') && details?.requestingUrl) {
        // getDisplayMedia still uses media permission — allow; mic devices already blocked above
        callback(true);
        return;
      }
      callback(true);
      return;
    }
    callback(false);
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
      });
      if (!sources.length) {
        console.error('[main] No screen sources for audio capture');
        callback({});
        return;
      }
      // audio: 'loopback' = what plays through speakers/headphones (Windows/Linux).
      // Never pass a microphone WebFrame or leave audio undefined (that can fall back to mic).
      const grant = { video: sources[0] };
      if (request.audioRequested) {
        grant.audio = 'loopback';
      }
      callback(grant);
      console.log('[main] Granted SPEAKER loopback only (no microphone)');
    } catch (err) {
      console.error('[main] setDisplayMediaRequestHandler error:', err);
      callback({});
    }
  });
}

// Prevent EPIPE errors when console.log writes to closed stdout
// (happens when app runs without a terminal)
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return; // Ignore broken pipe
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return;
});

let mainWindow;
let backend;
let tray = null;
const launchedHidden = process.argv.includes('--hidden');

// Keep only one tray instance. Launching the app again reveals the existing one.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 350,
    minHeight: 500,
    alwaysOnTop: true,
    frame: false, // Frameless for better transparency
    transparent: true, // TRUE TRANSPARENCY
    skipTaskbar: true, // HIDE from taskbar
    resizable: true, // Allow resizing - resize cursors won't show in screen share
    title: 'System Monitor',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // CRITICAL: This makes the window invisible during screen capture/share
  mainWindow.setContentProtection(true);

  // Initialize backend
  backend = new Backend(mainWindow);

  mainWindow.loadFile('renderer/index.html');

  mainWindow.once('ready-to-show', () => {
    if (!launchedHidden) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    backend = null;
  });

  // Don't quit when window is closed (keep in tray)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  console.log('[main] Window created: System Monitor (transparent, no taskbar)');
  console.log('[main] setContentProtection(true) - invisible during screen share');
}

function createTray() {
  // Create a simple icon for system tray (you can replace with a proper icon file)
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAFGSURBVDiNpdM9S8NAGMDx/5WkVRQEP4CDg4uDm4uLODi5ODk5OYmTk5Obk5OIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiKhVq9Xq9Xq9Xq9XT6fT6fR6vV6v1+v1er1er9fr9Xq9Xq9XT6fT6fR6vV4fj8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeJzP5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fT09P/wGXFjYvAAAAAElFTkSuQmCC');
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show System Monitor',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      }
    },
    {
      label: 'Hide',
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('System Monitor');
  tray.setContextMenu(contextMenu);
  
  // Click to toggle window
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    }
  });
  
  console.log('[main] System tray icon created');
}

// IPC handlers
ipcMain.handle('load-config', async () => {
  return await backend.loadConfig();
});

ipcMain.handle('save-config', async (_event, config) => {
  return await backend.saveConfig(config);
});

ipcMain.handle('start-session', async () => {
  if (!backend) {
    console.error('[main] Backend not initialized');
    throw new Error('Backend not initialized');
  }
  console.log('[main] Calling backend.startSession()');
  return await backend.startSession();
});

ipcMain.handle('stop-session', async () => {
  return await backend.stopSession();
});

ipcMain.handle('pause-session', async () => {
  return await backend.pauseSession();
});

ipcMain.handle('resume-session', async () => {
  return await backend.resumeSession();
});

ipcMain.handle('add-transcript', async (_event, text) => {
  return await backend.addTranscript(text);
});

ipcMain.handle('clear-transcript', async () => {
  return await backend.clearTranscript();
});

ipcMain.handle('generate-answer', async (_event, override) => {
  return await backend.generateAnswer(override);
});

ipcMain.handle('abort-answer', async () => {
  return await backend.abortAnswer();
});

ipcMain.handle('analyse-screen', async () => {
  return await backend.analyseScreen();
});

ipcMain.handle('transcribe-audio', async (_event, base64Wav) => {
  return await backend.transcribeAudio(base64Wav);
});

ipcMain.handle('hide-window', async () => {
  if (mainWindow) {
    // Stop session before hiding
    if (backend) {
      try {
        await backend.stopSession();
        console.log('[main] Session stopped on window close');
      } catch (err) {
        console.log('[main] No active session to stop');
      }
    }
    mainWindow.hide();
  }
});

app.whenReady().then(() => {
  // Start with Windows and remain in the tray. In development Electron needs the
  // app directory as an argument; packaged builds only need the hidden flag.
  if (process.platform === 'win32') {
    const loginArgs = app.isPackaged
      ? ['--hidden']
      : [path.resolve(__dirname), '--hidden'];
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: loginArgs,
    });
    console.log('[main] Windows login launch enabled (hidden in tray)');
  }

  setupSystemAudioCapture();
  createTray(); // Create system tray icon first
  createWindow();

  // Register global shortcut: Alt+. (Windows/Linux) or Cmd+. (Mac)
  const shortcut = process.platform === 'darwin' ? 'Command+.' : 'Alt+.';
  const registered = globalShortcut.register(shortcut, async () => {
    console.log(`[main] Global shortcut ${shortcut} pressed - toggling window`);
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        // Hide window and stop any active session
        if (backend) {
          try {
            await backend.stopSession();
            console.log('[main] Session stopped on window hide');
          } catch (err) {
            console.log('[main] No active session to stop');
          }
        }
        mainWindow.hide();
      } else {
        if (!app.isPackaged && getSourceVersion() > startupSourceVersion) {
          console.log('[main] Source changed; relaunching with latest code');
          relaunchWithLatestCode();
          return;
        }
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  if (registered) {
    console.log(`[main] Global shortcut registered: ${shortcut}`);
  } else {
    console.error(`[main] Failed to register global shortcut: ${shortcut}`);
  }

  // ── Ctrl+Right → expand window to the RIGHT ───────────────────────────────
  // ── Ctrl+Left  → expand window to the LEFT  ──────────────────────────────
  // Each shortcut toggles between normal width (420) and wide width (800).
  // Pressing the opposite direction while expanded re-anchors to that side.
  const NORMAL_WIDTH = 420;
  const WIDE_WIDTH   = 800;
  let expandedSide = null; // null | 'left' | 'right'

  function expandWindow(side) {
    if (!mainWindow) return;
    const [curX, curY]     = mainWindow.getPosition();
    const [curW, curH]     = mainWindow.getSize();
    const { width: scrW }  = screen.getPrimaryDisplay().workAreaSize;

    if (expandedSide === side) {
      // Already expanded this side → snap back to normal width
      const normalX = side === 'left'
        ? Math.min(curX + (curW - NORMAL_WIDTH), scrW - NORMAL_WIDTH)
        : curX;
      mainWindow.setSize(NORMAL_WIDTH, curH, true);
      mainWindow.setPosition(Math.max(0, normalX), curY, true);
      expandedSide = null;
      console.log(`[main] Window snapped back to normal (was expanded ${side})`);
    } else {
      // Expand toward the requested side
      const wideW = WIDE_WIDTH;
      let newX = curX;
      if (side === 'left') {
        newX = Math.max(0, curX - (wideW - curW));
      }
      // Clamp so window stays on screen
      newX = Math.max(0, Math.min(newX, scrW - wideW));
      mainWindow.setSize(wideW, curH, true);
      mainWindow.setPosition(newX, curY, true);
      expandedSide = side;
      console.log(`[main] Window expanded ${side} to ${wideW}px`);
    }
  }

  globalShortcut.register('CommandOrControl+Right', () => expandWindow('right'));
  globalShortcut.register('CommandOrControl+Left',  () => expandWindow('left'));
  console.log('[main] Global shortcuts registered: Ctrl+Left / Ctrl+Right (expand window)');


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit on window close - keep in tray
  if (process.platform !== 'darwin' && !app.isQuitting) {
    // Keep running in tray
  } else if (app.isQuitting) {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
  console.log('[main] Global shortcuts unregistered');
});
