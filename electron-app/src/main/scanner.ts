// Directory scanner — discover video files and build/update ProjectIndex
import { readdirSync, statSync, existsSync } from 'fs';
import { join, extname, basename, resolve } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ClipItem, ProjectIndex } from '../shared/types';
import { loadIndex, saveIndex } from './indexIO';

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.avi', '.flv', '.m4v', '.mkv', '.mov', '.mp4',
  '.mpeg', '.mpg', '.ts', '.webm', '.wmv',
]);

const CONFIG_FILENAME = 'config.toml';

function isSupportedVideo(filePath: string): boolean {
  return SUPPORTED_VIDEO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function collectVideoFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = join(d, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile() && isSupportedVideo(full)) {
          results.push(full);
        }
      } catch {
        continue;
      }
    }
  };
  walk(dir);
  return results;
}

async function buildClipItem(videoPath: string, rootDir: string): Promise<ClipItem> {
  return {
    id: uuidv4(),
    sourcePath: videoPath,
    fileName: basename(videoPath),
    fileExt: extname(videoPath).toLowerCase(),
    duration: 0,
    width: 0,
    height: 0,
    processed: false,
    subtitleCandidates: [],
    subclips: [],
    note: '',
  };
}

export async function scanDirectory(
  rootDir: string,
  outputDir: string,
): Promise<ProjectIndex> {
  const root = resolve(rootDir);
  const out = resolve(outputDir);

  // Detect config.toml
  const configPath = existsSync(join(root, CONFIG_FILENAME))
    ? join(root, CONFIG_FILENAME) : null;

  // Load or create index
  let index = loadIndex(root);
  if (index) {
    index.outputDir = out;
    if (configPath) index.configPath = configPath;
  } else {
    index = {
      rootDir: root,
      outputDir: out,
      configPath: configPath,
      categories: [],
      items: [],
      lastScannedAt: null,
    };
  }

  // Discover video files
  const discovered = new Set<string>();
  for (const vp of collectVideoFiles(root)) {
    discovered.add(vp);
  }

  // Build lookup of existing items by source path
  const existingByPath = new Map<string, ClipItem>();
  for (const item of index.items) {
    existingByPath.set(item.sourcePath, item);
  }

  // Find new videos
  const newItems: ClipItem[] = [];
  for (const videoPath of discovered) {
    if (!existingByPath.has(videoPath)) {
      newItems.push(await buildClipItem(videoPath, root));
    }
  }

  // Remove items whose files no longer exist
  index.items = index.items.filter(item => existsSync(item.sourcePath));
  index.items.push(...newItems);
  index.lastScannedAt = new Date().toISOString();

  saveIndex(index);
  return index;
}
