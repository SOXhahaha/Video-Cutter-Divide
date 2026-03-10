// Index I/O — atomic JSON persistence of clip_index.json
import { readFileSync, writeFileSync, unlinkSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { ProjectIndex, projectIndexFromJson, projectIndexToJson } from '../shared/types';

const INDEX_FILENAME = 'clip_index.json';

export function loadIndex(rootDir: string): ProjectIndex | null {
  const indexPath = join(rootDir, INDEX_FILENAME);
  if (!existsSync(indexPath)) return null;
  const raw = readFileSync(indexPath, 'utf-8');
  const data = JSON.parse(raw);
  return projectIndexFromJson(data);
}

export function saveIndex(index: ProjectIndex): string {
  const rootDir = index.rootDir;
  mkdirSync(rootDir, { recursive: true });
  const target = join(rootDir, INDEX_FILENAME);
  const payload = JSON.stringify(projectIndexToJson(index), null, 2);

  // Atomic write: temp file → rename
  const tmpPath = join(rootDir, `.clip_index_${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, target);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  return target;
}
