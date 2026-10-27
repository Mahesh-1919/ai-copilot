import { type BrowserWindow, globalShortcut, screen } from 'electron';
import { NORMAL_WIDTH, WIDE_WIDTH, showWindow } from './app-window';
import { createLogger } from './logger';

const log = createLogger('shortcuts');

export const TOGGLE_SHORTCUT = process.platform === 'darwin' ? 'Command+.' : 'Alt+.';

export interface ShortcutHandlers {
  getWindow: () => BrowserWindow | null;
  /** Called before the window hides (e.g. to stop the session). */
  onHide: () => void;
  /** Return true to cancel showing (e.g. because the app is relaunching). */
  beforeShow?: () => boolean;
}

type Side = 'left' | 'right';

export function registerShortcuts({ getWindow, onHide, beforeShow }: ShortcutHandlers): void {
  const toggled = globalShortcut.register(TOGGLE_SHORTCUT, () => {
    const window = getWindow();
    if (!window) return;
    if (window.isVisible()) {
      onHide();
      window.hide();
    } else if (!beforeShow?.()) {
      showWindow(window);
    }
  });
  if (toggled) log.info(`Registered ${TOGGLE_SHORTCUT} (show/hide)`);
  else log.error(`Failed to register ${TOGGLE_SHORTCUT}`);

  // Ctrl+Left / Ctrl+Right toggle between normal and wide width, growing toward that side.
  let expandedSide: Side | null = null;

  const expand = (side: Side) => {
    const window = getWindow();
    if (!window) return;
    const [x = 0, y = 0] = window.getPosition();
    const [width = NORMAL_WIDTH, height = 0] = window.getSize();
    const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;

    if (expandedSide === side) {
      const normalX = side === 'left' ? Math.min(x + (width - NORMAL_WIDTH), screenWidth - NORMAL_WIDTH) : x;
      window.setSize(NORMAL_WIDTH, height, true);
      window.setPosition(Math.max(0, normalX), y, true);
      expandedSide = null;
    } else {
      const targetX = side === 'left' ? x - (WIDE_WIDTH - width) : x;
      window.setSize(WIDE_WIDTH, height, true);
      window.setPosition(Math.max(0, Math.min(targetX, screenWidth - WIDE_WIDTH)), y, true);
      expandedSide = side;
    }
  };

  globalShortcut.register('CommandOrControl+Right', () => expand('right'));
  globalShortcut.register('CommandOrControl+Left', () => expand('left'));
  log.info('Registered Ctrl+Left / Ctrl+Right (expand window)');
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
