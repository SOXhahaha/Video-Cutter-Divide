// Electron main process — window creation + IPC handlers
import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import { join } from 'path';
import { readdirSync, statSync } from 'fs';
import { IPC, ProjectIndex, CutterConfig } from '../shared/types';
import { scanDirectory } from './scanner';
import { loadIndex, saveIndex } from './indexIO';
import { addCategory, removeCategory } from './categoryManager';
import { extractWaveformPeaks, exportSubclip, probeVideo } from './ffmpeg';
import { runSubtitleScan } from './ocr';
import { loadConfig } from './config';
import { loadAppState, saveAppState } from './appState';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    title: '视频片段分类工作台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: '#f8f9fa',
  });

  mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// =========================================================================
// IPC Handlers
// =========================================================================

ipcMain.handle(IPC.CHOOSE_DIRECTORY, async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle(IPC.SCAN_DIRECTORY, async (_event, rootDir: string, outputDir: string) => {
  return await scanDirectory(rootDir, outputDir);
});

ipcMain.handle(IPC.SAVE_INDEX, (_event, index: ProjectIndex) => {
  saveIndex(index);
});

ipcMain.handle(IPC.LOAD_INDEX, (_event, rootDir: string) => {
  return loadIndex(rootDir);
});

ipcMain.handle(IPC.ADD_CATEGORY, (_event, index: ProjectIndex, name: string) => {
  return addCategory(index, name);
});

ipcMain.handle(IPC.REMOVE_CATEGORY, (_event, index: ProjectIndex, name: string) => {
  removeCategory(index, name);
});

ipcMain.handle(IPC.EXPORT_SUBCLIP, async (
  _event, sourcePath: string, start: number, end: number, outputPath: string,
) => {
  return await exportSubclip(sourcePath, start, end, outputPath);
});

ipcMain.handle(IPC.EXTRACT_WAVEFORM, async (_event, videoPath: string) => {
  return await extractWaveformPeaks(videoPath);
});

ipcMain.handle(IPC.PROBE_VIDEO, async (_event, videoPath: string) => {
  return await probeVideo(videoPath);
});

ipcMain.handle(IPC.RUN_SUBTITLE_SCAN, async (_event, videoPath: string, config: CutterConfig) => {
  return await runSubtitleScan(videoPath, config);
});

ipcMain.handle(IPC.LOAD_CONFIG, (_event, configPath: string) => {
  return loadConfig(configPath);
});

ipcMain.handle(IPC.LOAD_APP_STATE, () => {
  return loadAppState();
});

ipcMain.handle(IPC.SAVE_APP_STATE, (_event, state: Record<string, unknown>) => {
  saveAppState(state);
});

ipcMain.handle(IPC.LIST_OUTPUT_SUBFOLDERS, (_event, outputDir: string) => {
  try {
    return readdirSync(outputDir)
      .filter(name => {
        try { return statSync(join(outputDir, name)).isDirectory(); } catch { return false; }
      });
  } catch { return []; }
});
