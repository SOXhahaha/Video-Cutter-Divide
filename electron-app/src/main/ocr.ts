// OCR subtitle scan — FFmpeg frame extraction + RapidOCR (Python) recognition
import { spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, existsSync, readdirSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { getFFmpegPath, getFFprobePath } from './ffmpeg';
import { SubtitleCandidate, CutterConfig } from '../shared/types';
import { promisify } from 'util';
import { execFile } from 'child_process';

const execFileAsync = promisify(execFile);

interface FrameInfo {
  path: string;
  timestamp: number;
}

interface OCRResult {
  timestamp: number;
  text: string;
  confidence: number;
}

/**
 * Extract frames from video at regular intervals, crop to ROI, and run OCR in parallel.
 */
export async function runSubtitleScan(
  videoPath: string,
  config: CutterConfig,
): Promise<SubtitleCandidate[]> {
  // 1. Probe duration
  const ffprobe = getFFprobePath();
  const { stdout: probeOut } = await execFileAsync(ffprobe, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', videoPath,
  ], { timeout: 30000 });
  const duration = parseFloat(JSON.parse(probeOut).format?.duration || '0');
  if (duration <= 0) return [];

  // 2. Extract frames into temp dir
  const tmpDir = join(tmpdir(), `ocr_frames_${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const interval = config.sampleInterval || 0.2;
  const { x, y, width, height } = config.region;
  const cropFilter = `crop=${width}:${height}:${x}:${y}`;

  try {
    const frames = await extractFrames(videoPath, tmpDir, interval, cropFilter);
    if (frames.length === 0) return [];

    // 3. Parallel OCR (up to 4 workers)
    const cpuCount = (await import('os')).cpus().length;
    const workerCount = Math.min(cpuCount, 4, frames.length);
    const results = await parallelOCR(frames, workerCount, config);

    // 4. Merge consecutive identical subtitles
    return mergeSubtitles(results);
  } finally {
    cleanupDir(tmpDir);
  }
}

async function extractFrames(
  videoPath: string,
  outDir: string,
  interval: number,
  cropFilter: string,
): Promise<FrameInfo[]> {
  const ffmpeg = getFFmpegPath();

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vf', `fps=1/${interval},${cropFilter}`,
      '-qscale:v', '2',
      join(outDir, 'frame_%06d.jpg'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 && stderr) {
        reject(new Error(`FFmpeg frame extraction failed: ${stderr}`));
        return;
      }
      const files = readdirSync(outDir)
        .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
        .sort();
      const frames: FrameInfo[] = files.map((f, i) => ({
        path: join(outDir, f),
        timestamp: i * interval,
      }));
      resolve(frames);
    });

    proc.on('error', reject);
  });
}

async function parallelOCR(
  frames: FrameInfo[],
  workerCount: number,
  config: CutterConfig,
): Promise<OCRResult[]> {
  // Split frames into chunks for parallel Python workers
  const chunkSize = Math.ceil(frames.length / workerCount);
  const chunks: FrameInfo[][] = [];
  for (let i = 0; i < frames.length; i += chunkSize) {
    chunks.push(frames.slice(i, i + chunkSize));
  }

  const scriptPath = join(__dirname, '..', '..', 'scripts', 'ocr_worker.py');

  const tasks = chunks.map(chunk => runPythonOCR(scriptPath, chunk));
  const chunkResults = await Promise.all(tasks);
  const allResults = chunkResults.flat();

  // Filter by confidence and text length
  const filtered = allResults.filter(
    r => r.text.length >= (config.minTextLength || 2) &&
         r.confidence >= (config.minConfidence || 0.8),
  );
  filtered.sort((a, b) => a.timestamp - b.timestamp);
  return filtered;
}

function runPythonOCR(scriptPath: string, frames: FrameInfo[]): Promise<OCRResult[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const input = JSON.stringify(frames.map(f => ({ path: f.path, timestamp: f.timestamp })));

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`OCR worker failed (code ${code}): ${stderr}`));
        return;
      }
      try {
        const results: OCRResult[] = JSON.parse(stdout);
        resolve(results);
      } catch (e) {
        reject(new Error(`OCR worker returned invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', reject);
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

function mergeSubtitles(results: OCRResult[]): SubtitleCandidate[] {
  if (results.length === 0) return [];

  const merged: SubtitleCandidate[] = [];
  let currentText = results[0].text;
  let startTime = results[0].timestamp;
  let endTime = results[0].timestamp;

  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    if (r.text === currentText) {
      endTime = r.timestamp;
    } else {
      merged.push({
        text: currentText,
        start: startTime,
        end: endTime,
        edited: false,
      });
      currentText = r.text;
      startTime = r.timestamp;
      endTime = r.timestamp;
    }
  }

  merged.push({
    text: currentText,
    start: startTime,
    end: endTime,
    edited: false,
  });

  return merged;
}

function cleanupDir(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      unlinkSync(join(dir, f));
    }
    rmdirSync(dir);
  } catch { /* ignore */ }
}
