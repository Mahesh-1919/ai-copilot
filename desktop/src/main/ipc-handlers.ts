import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { IpcChannel, type InvokeArgs, type InvokeChannel, type InvokeResult } from '../shared/ipc';
import type { CopilotSession } from './services/copilot-session';

// Groq's transcription endpoint rejects files over 25 MB; base64 adds ~33%.
const MAX_AUDIO_BASE64_LENGTH = 34 * 1024 * 1024;
const MAX_TEXT_LENGTH = 20_000;

type Handler<C extends InvokeChannel> = (...args: InvokeArgs<C>) => InvokeResult<C> | Promise<InvokeResult<C>>;

/** Registers a handler whose arguments have been validated by `validate` first. */
function handle<C extends InvokeChannel>(
  channel: C,
  validate: (args: unknown[]) => args is InvokeArgs<C>,
  handler: Handler<C>,
): void {
  ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!validate(args)) throw new Error(`Invalid arguments for ${channel}`);
    return handler(...args);
  });
}

const noArgs = (args: unknown[]): args is [] => args.length === 0;

const boundedString =
  (max: number) =>
  (args: unknown[]): args is [string] =>
    args.length === 1 && typeof args[0] === 'string' && args[0].length <= max;

const optionalText = (args: unknown[]): args is [string?] =>
  args.length === 0 || args[0] === undefined || (typeof args[0] === 'string' && args[0].length <= MAX_TEXT_LENGTH);

export interface IpcDeps {
  session: CopilotSession;
  hideWindow: () => void;
}

export function registerIpcHandlers({ session, hideWindow }: IpcDeps): void {
  handle(IpcChannel.LoadConfig, noArgs, () => session.loadConfig());

  handle(IpcChannel.StartSession, noArgs, () => session.startSession());
  handle(IpcChannel.StopSession, noArgs, () => session.stopSession());
  handle(IpcChannel.PauseSession, noArgs, () => session.pauseSession());
  handle(IpcChannel.ResumeSession, noArgs, () => session.resumeSession());

  handle(IpcChannel.AddTranscript, boundedString(MAX_TEXT_LENGTH), (text) => session.addTranscript(text));
  handle(IpcChannel.ClearTranscript, noArgs, () => session.clearTranscript());

  handle(IpcChannel.GenerateAnswer, optionalText, (override) => session.generateAnswer(override));
  handle(IpcChannel.AbortAnswer, noArgs, () => session.abortAnswer());
  handle(IpcChannel.AnalyseScreen, noArgs, () => session.analyseScreen());

  handle(IpcChannel.TranscribeAudio, boundedString(MAX_AUDIO_BASE64_LENGTH), (base64Wav) =>
    session.transcribeAudio(base64Wav),
  );

  handle(IpcChannel.HideWindow, noArgs, () => {
    session.stopSession();
    hideWindow();
  });
}
