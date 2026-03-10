// Shared type definitions between main and renderer processes

export interface SubtitleCandidate {
  text: string;
  start: number;
  end: number;
  edited: boolean;
  checked?: boolean;
}

export interface SubClip {
  id: string;
  start: number;
  end: number;
  processed: boolean;
}

export interface ClipItem {
  id: string;
  sourcePath: string;
  // Derived at runtime (not saved)
  fileName: string;
  fileExt: string;
  duration: number;
  width: number;
  height: number;
  // Persisted
  processed: boolean;
  subtitleCandidates: SubtitleCandidate[];
  subclips: SubClip[];
  note: string;
}

export interface ProjectIndex {
  rootDir: string;
  outputDir: string;
  configPath: string | null;
  categories: string[];
  items: ClipItem[];
  lastScannedAt: string | null;
}

export interface OCRRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CutterConfig {
  region: OCRRegion;
  sampleInterval: number;
  minConfidence: number;
  minTextLength: number;
}

// IPC channel names
export const IPC = {
  // Directory / scan
  CHOOSE_DIRECTORY: 'choose-directory',
  SCAN_DIRECTORY: 'scan-directory',

  // Index persistence
  SAVE_INDEX: 'save-index',
  LOAD_INDEX: 'load-index',

  // Category management
  ADD_CATEGORY: 'add-category',
  REMOVE_CATEGORY: 'remove-category',

  // Classification / Export
  EXPORT_SUBCLIP: 'export-subclip',

  // Waveform
  EXTRACT_WAVEFORM: 'extract-waveform',

  // Probe video metadata
  PROBE_VIDEO: 'probe-video',

  // OCR subtitle scan
  RUN_SUBTITLE_SCAN: 'run-subtitle-scan',

  // Config
  LOAD_CONFIG: 'load-config',

  // List output subfolders (for category discovery)
  LIST_OUTPUT_SUBFOLDERS: 'list-output-subfolders',

  // App state persistence
  LOAD_APP_STATE: 'load-app-state',
  SAVE_APP_STATE: 'save-app-state',
} as const;

// JSON serialization helpers
export function clipItemToJson(item: ClipItem): Record<string, unknown> {
  return {
    id: item.id,
    source_path: item.sourcePath,
    processed: item.processed,
    subtitle_candidates: item.subtitleCandidates.map(sc => ({
      text: sc.text,
      start: Math.round(sc.start * 1000) / 1000,
      end: Math.round(sc.end * 1000) / 1000,
      edited: sc.edited,
      ...(sc.checked === false ? { checked: false } : {}),
    })),
    subclips: item.subclips.map(sc => ({
      id: sc.id,
      start: Math.round(sc.start * 1000) / 1000,
      end: Math.round(sc.end * 1000) / 1000,
      processed: sc.processed,
    })),
    note: item.note,
  };
}

function deriveFileName(sourcePath: string): string {
  const sep = sourcePath.lastIndexOf('/') >= 0 ? '/' : '\\';
  return sourcePath.split(sep).pop() || '';
}

function deriveFileExt(sourcePath: string): string {
  const name = deriveFileName(sourcePath);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function clipItemFromJson(data: Record<string, unknown>): ClipItem {
  const sourcePath = String(data.source_path || '');

  const candidates = (data.subtitle_candidates as Array<Record<string, unknown>> || []).map(sc => ({
    text: String(sc.text || ''),
    start: Number(sc.start || 0),
    end: Number(sc.end || 0),
    edited: Boolean(sc.edited || false),
    ...(sc.checked === false ? { checked: false as const } : {}),
  }));

  const subclips = (data.subclips as Array<Record<string, unknown>> || []).map(sc => ({
    id: String(sc.id || crypto.randomUUID()),
    start: Number(sc.start || 0),
    end: Number(sc.end || 0),
    processed: Boolean(sc.processed || false),
  }));

  return {
    id: String(data.id || crypto.randomUUID()),
    sourcePath,
    fileName: deriveFileName(sourcePath),
    fileExt: deriveFileExt(sourcePath),
    duration: 0,
    width: 0,
    height: 0,
    processed: Boolean(data.processed || false),
    subtitleCandidates: candidates,
    subclips,
    note: String(data.note || ''),
  };
}

export function projectIndexToJson(index: ProjectIndex): Record<string, unknown> {
  return {
    project_type: 'video_clip_classifier',
    root_dir: index.rootDir,
    output_dir: index.outputDir,
    config_path: index.configPath,
    last_scanned_at: index.lastScannedAt,
    categories: [...index.categories],
    items: index.items.map(clipItemToJson),
  };
}

export function projectIndexFromJson(data: Record<string, unknown>): ProjectIndex {
  return {
    rootDir: String(data.root_dir || ''),
    outputDir: String(data.output_dir || ''),
    configPath: (data.config_path as string | null) || null,
    lastScannedAt: (data.last_scanned_at as string | null) || null,
    categories: (data.categories as string[] || []),
    items: (data.items as Array<Record<string, unknown>> || []).map(clipItemFromJson),
  };
}
