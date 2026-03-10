// App state persistence — saves/restores user session state (directories, volume, settings)
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

const STATE_FILE = 'app-state.json';

export interface AppState {
  sourceDir?: string;
  outputDir?: string;
  volumeDb?: number;
  settings?: {
    sampleInterval?: number;
    minConfidence?: number;
    minTextLength?: number;
    mergeSimilarity?: number;
  };
}

function getStatePath(): string {
  return join(app.getPath('userData'), STATE_FILE);
}

export function loadAppState(): AppState {
  const p = getStatePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveAppState(state: AppState): void {
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf-8');
}
