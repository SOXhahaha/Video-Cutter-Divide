// Configuration — TOML config parsing
import { readFileSync, existsSync } from 'fs';
import { parse as parseToml } from 'toml';
import { CutterConfig, OCRRegion } from '../shared/types';

const DEFAULT_SAMPLE_INTERVAL = 0.2;
const DEFAULT_MIN_CONFIDENCE = 0.8;
const DEFAULT_MIN_TEXT_LENGTH = 2;

export function loadConfig(configPath: string): CutterConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const data = parseToml(raw);
    return buildCutterConfig(data);
  } catch {
    return null;
  }
}

function buildCutterConfig(raw: Record<string, unknown>): CutterConfig {
  const regionData = (raw.ocr_region || {}) as Record<string, number>;
  const ocrData = (raw.ocr || {}) as Record<string, number>;

  const region: OCRRegion = {
    x: Number(regionData.x || 0),
    y: Number(regionData.y || 0),
    width: Number(regionData.width || 1),
    height: Number(regionData.height || 1),
  };

  return {
    region,
    sampleInterval: Number(ocrData.sample_interval || DEFAULT_SAMPLE_INTERVAL),
    minConfidence: Number(ocrData.min_confidence || DEFAULT_MIN_CONFIDENCE),
    minTextLength: Number(ocrData.min_text_length || DEFAULT_MIN_TEXT_LENGTH),
  };
}
