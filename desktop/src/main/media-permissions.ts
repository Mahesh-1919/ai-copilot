import { desktopCapturer, session } from 'electron';
import type { ScreenCapture } from './services/copilot-session';
import { createLogger } from './logger';

const log = createLogger('media');

/**
 * Restricts capture to speaker/system audio (loopback) and screen frames.
 * The microphone is never granted: display media is answered with `audio: 'loopback'`,
 * and the renderer drops any track that looks like a mic.
 */
export function configureMediaPermissions(): void {
  const { defaultSession } = session;

  // WebHID / WebSerial / WebUSB are never needed.
  defaultSession.setDevicePermissionHandler(() => false);

  // getDisplayMedia goes through the `media` / `display-capture` permissions; everything else is denied.
  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });

  defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const [source] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      if (!source) {
        log.error('No screen sources available for audio capture');
        // Electron's typings require a video source, but an empty grant is how a request is rejected.
        callback({} as Parameters<typeof callback>[0]);
        return;
      }
      // 'loopback' is what plays through the speakers. Leaving audio undefined could fall back to the mic.
      callback(request.audioRequested ? { video: source, audio: 'loopback' } : { video: source });
      log.info('Granted speaker loopback (no microphone)');
    } catch (error) {
      log.error('Display media request failed:', error);
      callback({} as Parameters<typeof callback>[0]);
    }
  });
}

/** Grabs the primary screen as a PNG data URL for the vision pipeline. */
export async function capturePrimaryScreen(): Promise<ScreenCapture> {
  const [source] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 960, height: 540 } });
  if (!source) throw new Error('No screens found to capture');

  const { width, height } = source.thumbnail.getSize();
  return { dataUrl: source.thumbnail.toDataURL(), width, height };
}
