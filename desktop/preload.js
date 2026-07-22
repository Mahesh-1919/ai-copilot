const { contextBridge, ipcRenderer } = require('electron');

// Expose controlled API to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // System info
  platform: process.platform,
  version: process.versions.electron,
  
  // Config
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  
  // Session control
  startSession: () => ipcRenderer.invoke('start-session'),
  stopSession: () => ipcRenderer.invoke('stop-session'),
  pauseSession: () => ipcRenderer.invoke('pause-session'),
  resumeSession: () => ipcRenderer.invoke('resume-session'),
  
  // Transcript
  addTranscript: (text) => ipcRenderer.invoke('add-transcript', text),
  clearTranscript: () => ipcRenderer.invoke('clear-transcript'),
  
  // LLM
  generateAnswer: (override) => ipcRenderer.invoke('generate-answer', override),
  abortAnswer: () => ipcRenderer.invoke('abort-answer'),
  
  // Screen capture
  analyseScreen: () => ipcRenderer.invoke('analyse-screen'),
  
  // Audio transcription
  transcribeAudio: (base64Wav) => ipcRenderer.invoke('transcribe-audio', base64Wav),
  
  // Window control
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  
  // Events from main -> renderer
  onSessionState: (callback) => {
    ipcRenderer.on('session-state', (_event, data) => callback(data));
  },
  onTranscriptUpdate: (callback) => {
    ipcRenderer.on('transcript-update', (_event, data) => callback(data));
  },
  onAnswerChunk: (callback) => {
    ipcRenderer.on('answer-chunk', (_event, text) => callback(text));
  },
  onAnswerDone: (callback) => {
    ipcRenderer.on('answer-done', () => callback());
  },
  onError: (callback) => {
    ipcRenderer.on('error', (_event, error) => callback(error));
  },
});

console.log('[preload] IPC API exposed to renderer');
