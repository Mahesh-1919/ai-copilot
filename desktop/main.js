const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, desktopCapturer, session } = require('electron');
const path = require('path');
const { Backend } = require('./backend');

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
