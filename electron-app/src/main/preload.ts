// Preload script — expose safe IPC bridge to renderer
// NOTE: In sandboxed mode only require('electron') works.
// IPC channel names are inlined to avoid require('../shared/types').
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  chooseDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('choose-directory'),

  scanDirectory: (rootDir: string, outputDir: string): Promise<unknown> =>
    ipcRenderer.invoke('scan-directory', rootDir, outputDir),

  saveIndex: (index: unknown): Promise<void> =>
    ipcRenderer.invoke('save-index', index),

  loadIndex: (rootDir: string): Promise<unknown> =>
    ipcRenderer.invoke('load-index', rootDir),

  addCategory: (index: unknown, name: string): Promise<string> =>
    ipcRenderer.invoke('add-category', index, name),

  removeCategory: (index: unknown, name: string): Promise<void> =>
    ipcRenderer.invoke('remove-category', index, name),

  exportSubclip: (sourcePath: string, start: number, end: number, outputPath: string): Promise<string> =>
    ipcRenderer.invoke('export-subclip', sourcePath, start, end, outputPath),

  extractWaveform: (videoPath: string): Promise<unknown> =>
    ipcRenderer.invoke('extract-waveform', videoPath),

  probeVideo: (videoPath: string): Promise<{ duration: number; width: number; height: number }> =>
    ipcRenderer.invoke('probe-video', videoPath),

  runSubtitleScan: (videoPath: string, config: unknown): Promise<unknown[]> =>
    ipcRenderer.invoke('run-subtitle-scan', videoPath, config),

  loadConfig: (configPath: string): Promise<unknown> =>
    ipcRenderer.invoke('load-config', configPath),

  listOutputSubfolders: (outputDir: string): Promise<string[]> =>
    ipcRenderer.invoke('list-output-subfolders', outputDir),

  loadAppState: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('load-app-state'),

  saveAppState: (state: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('save-app-state', state),
});
