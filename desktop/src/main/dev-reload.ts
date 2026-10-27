import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { markQuitting } from './app-window';

/**
 * Development helper: when the build output changes while the window is hidden,
 * showing it again (via the hotkey) relaunches the app so the latest code runs.
 */
const BUILD_ROOT = path.join(__dirname, '..');

function latestMtime(dir: string): number {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? latestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return latest;
}

function buildVersion(): number {
  try {
    return latestMtime(BUILD_ROOT);
  } catch {
    return 0;
  }
}

const startupVersion = app.isPackaged ? 0 : buildVersion();

export function hasNewerBuild(): boolean {
  return !app.isPackaged && buildVersion() > startupVersion;
}

export function relaunchWithLatestBuild(): void {
  // Drop --hidden so the relaunched window opens visibly.
  const args = process.argv.slice(1).filter((arg) => arg !== '--hidden');
  app.relaunch({ args });
  markQuitting();
  app.quit();
}
