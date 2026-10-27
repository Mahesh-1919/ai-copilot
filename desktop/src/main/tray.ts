import { type BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { APP_TITLE, quitApp, showWindow } from './app-window';
import { createLogger } from './logger';

const log = createLogger('tray');

// 16x16 placeholder icon; replace with a real asset when branding is settled.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAFGSURBVDiNpdM9S8NAGMDx/5WkVRQEP4CDg4uDm4uLODi5ODk5OYmTk5Obk5OIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiKhVq9Xq9Xq9Xq9XT6fT6fR6vV6v1+v1er1er9fr9Xq9Xq9XT6fT6fR6vV4fj8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeJzP5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fT09P/wGXFjYvAAAAAElFTkSuQmCC';

export function createTray(getWindow: () => BrowserWindow | null): Tray {
  const tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));

  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `Show ${APP_TITLE}`,
        click: () => {
          const window = getWindow();
          if (window) showWindow(window);
        },
      },
      { label: 'Hide', click: () => getWindow()?.hide() },
      { type: 'separator' },
      { label: 'Quit', click: quitApp },
    ]),
  );

  tray.on('click', () => {
    const window = getWindow();
    if (!window) return;
    if (window.isVisible()) window.hide();
    else window.show();
  });

  log.info('Tray icon created');
  return tray;
}
