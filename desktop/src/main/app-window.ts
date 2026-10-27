import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { createLogger } from './logger';

const log = createLogger('window');

export const APP_TITLE = 'System Monitor';
export const NORMAL_WIDTH = 420;
export const WIDE_WIDTH = 800;

let isQuitting = false;

export interface MainWindowOptions {
  startHidden: boolean;
  openDevTools: boolean;
}

export function createMainWindow({ startHidden, openDevTools }: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: NORMAL_WIDTH,
    height: 680,
    minWidth: 350,
    minHeight: 500,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: true,
    title: APP_TITLE,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Excludes the window from screen capture / screen sharing.
  window.setContentProtection(true);

  void window.loadFile(path.join(__dirname, '../renderer/index.html'));

  window.once('ready-to-show', () => {
    if (!startHidden) {
      window.show();
      window.focus();
    }
  });

  if (openDevTools) window.webContents.openDevTools({ mode: 'detach' });

  // The renderer is a local single page: never navigate away or open new windows in-app.
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing hides to the tray; only an explicit Quit exits.
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  log.info('Window created with content protection enabled');
  return window;
}

/** Lets the close handler distinguish "hide to tray" from a real quit. */
export function quitApp(): void {
  isQuitting = true;
  app.quit();
}

export function markQuitting(): void {
  isQuitting = true;
}

export function showWindow(window: BrowserWindow): void {
  window.show();
  window.focus();
}
