import path from 'node:path';
import { BrowserWindow, app } from 'electron';
import type { Tray } from 'electron';
import { createMainWindow, markQuitting, showWindow } from './app-window';
import { hasNewerBuild, relaunchWithLatestBuild } from './dev-reload';
import { registerIpcHandlers } from './ipc-handlers';
import { createLogger, ignoreBrokenPipes } from './logger';
import { capturePrimaryScreen, configureMediaPermissions } from './media-permissions';
import { CopilotSession, type EmitFn } from './services/copilot-session';
import { registerShortcuts, unregisterShortcuts } from './shortcuts';
import { createTray } from './tray';

ignoreBrokenPipes();

const log = createLogger('main');
const launchedHidden = process.argv.includes('--hidden');
const devMode = process.argv.includes('--dev');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/**
 * Where api-keys.json, resume and job description are looked up, in priority order.
 * Packaged: next to the executable, then the per-user data folder, then bundled resources.
 * Development: the desktop/ folder, then the repository root.
 */
function configSearchDirs(): string[] {
  if (!app.isPackaged) {
    const appRoot = app.getAppPath();
    return [appRoot, path.join(appRoot, '..')];
  }
  return [
    process.env.PORTABLE_EXECUTABLE_DIR,
    path.dirname(app.getPath('exe')),
    app.getPath('userData'),
    process.resourcesPath,
  ].filter((dir): dir is string => Boolean(dir));
}

const emit: EmitFn = (channel, ...payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...payload);
  }
};

const session = new CopilotSession({
  emit,
  configDirs: configSearchDirs(),
  captureScreen: capturePrimaryScreen,
});

function hideWindow(): void {
  mainWindow?.hide();
}

/** Start with Windows, hidden in the tray. Dev builds need the app path as an argument. */
function enableLoginLaunch(): void {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
  });
  log.info('Login launch enabled (hidden in tray)');
}

function bootstrap(): void {
  // Only one instance: launching again reveals the existing window.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) showWindow(mainWindow);
  });

  registerIpcHandlers({ session, hideWindow });

  void app.whenReady().then(() => {
    enableLoginLaunch();
    configureMediaPermissions();

    mainWindow = createMainWindow({ startHidden: launchedHidden, openDevTools: devMode });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    tray = createTray(() => mainWindow);

    registerShortcuts({
      getWindow: () => mainWindow,
      onHide: () => session.stopSession(),
      beforeShow: () => {
        if (!hasNewerBuild()) return false;
        log.info('Build output changed; relaunching with latest code');
        relaunchWithLatestBuild();
        return true;
      },
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow({ startHidden: false, openDevTools: devMode });
      }
    });
  });

  // Stay alive in the tray when the window closes; quitting happens via the tray menu.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    markQuitting();
    session.dispose();
  });

  app.on('will-quit', () => {
    unregisterShortcuts();
    tray?.destroy();
    tray = null;
  });
}

bootstrap();
