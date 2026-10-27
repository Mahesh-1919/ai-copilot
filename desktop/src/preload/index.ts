import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron';
import {
  type ElectronAPI,
  type EventChannel,
  type IpcEventContract,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
  type Unsubscribe,
  IpcChannel,
  IpcEvent,
} from '../shared/ipc';

function invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<InvokeResult<C>>;
}

function subscribe<C extends EventChannel>(channel: C, callback: (payload: IpcEventContract[C]) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: IpcEventContract[C]) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ElectronAPI = {
  platform: process.platform,
  version: process.versions.electron ?? '',

  loadConfig: () => invoke(IpcChannel.LoadConfig),

  startSession: () => invoke(IpcChannel.StartSession),
  stopSession: () => invoke(IpcChannel.StopSession),
  pauseSession: () => invoke(IpcChannel.PauseSession),
  resumeSession: () => invoke(IpcChannel.ResumeSession),

  addTranscript: (text) => invoke(IpcChannel.AddTranscript, text),
  clearTranscript: () => invoke(IpcChannel.ClearTranscript),

  generateAnswer: (override) =>
    override === undefined ? invoke(IpcChannel.GenerateAnswer) : invoke(IpcChannel.GenerateAnswer, override),
  abortAnswer: () => invoke(IpcChannel.AbortAnswer),
  analyseScreen: () => invoke(IpcChannel.AnalyseScreen),

  transcribeAudio: (base64Wav) => invoke(IpcChannel.TranscribeAudio, base64Wav),

  hideWindow: () => invoke(IpcChannel.HideWindow),

  onSessionState: (callback) => subscribe(IpcEvent.SessionState, callback),
  onTranscriptUpdate: (callback) => subscribe(IpcEvent.TranscriptUpdate, callback),
  onAnswerChunk: (callback) => subscribe(IpcEvent.AnswerChunk, callback),
  onAnswerDone: (callback) => subscribe(IpcEvent.AnswerDone, () => callback()),
  onError: (callback) => subscribe(IpcEvent.Error, callback),
};

contextBridge.exposeInMainWorld('electronAPI', api);
