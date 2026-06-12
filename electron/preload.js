const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Paths & meta
  getPaths: () => ipcRenderer.invoke('get-paths'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getBackendUrl: () => ipcRenderer.invoke('backend-url'),
  isFirstRun: () => ipcRenderer.invoke('is-first-run'),

  // File dialogs
  selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
  selectAudioFile: () => ipcRenderer.invoke('select-audio-file'),
  selectVideoForVoice: () => ipcRenderer.invoke('select-video-for-voice'),
  selectOutputDirectory: () => ipcRenderer.invoke('select-output-directory'),
  saveGeneratedVideo: (name) => ipcRenderer.invoke('save-generated-video', name),
  openPath: (p) => ipcRenderer.invoke('open-path', p),

  // Audio recording
  saveRecording: (buffer, filename) =>
    ipcRenderer.invoke('save-recording', { buffer, filename }),

  // Project file I/O
  saveProject: (json, defaultName) => ipcRenderer.invoke('save-project', { json, defaultName }),
  openProject: () => ipcRenderer.invoke('open-project'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

  // Setup info (platform + install command)
  getSetupInfo: () => ipcRenderer.invoke('get-setup-info'),
  openTerminal: () => ipcRenderer.invoke('open-terminal'),

  // Provisión del runtime (primer arranque)
  getProvisionState: () => ipcRenderer.invoke('get-provision-state'),
  provisionRuntime: () => ipcRenderer.invoke('provision-runtime'),
  onProvisionProgress: (cb) => ipcRenderer.on('provision-progress', (_, st) => cb(st)),
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // Backend lifecycle events
  onBackendReady: (cb) => ipcRenderer.on('backend-ready', () => cb()),
  onBackendError: (cb) => ipcRenderer.on('backend-error', (_, msg) => cb(msg)),
  onBackendCrashed: (cb) => ipcRenderer.on('backend-crashed', (_, code) => cb(code)),
});
