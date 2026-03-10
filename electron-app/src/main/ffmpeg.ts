// FFmpeg utility — find binary and execute commands
import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

let _ffmpegPath: string | null = null;
let _ffprobePath: string | null = null;

function findBinary(name: string): string | null {
  // 1. Bundled runtime/ffmpeg/
  const bundled = join(dirname(__dirname), '..', '..', 'runtime', 'ffmpeg', `${name}.exe`);
  if (existsSync(bundled)) return bundled;

  // 2. Project-level runtime
  const projectBundled = join(process.cwd(), 'runtime', 'ffmpeg', `${name}.exe`);
  if (existsSync(projectBundled)) return projectBundled;

  // 3. System PATH (Windows)
  const pathDirs = (process.env.PATH || '').split(';');
  for (const dir of pathDirs) {
    const candidate = join(dir, `${name}.exe`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function getFFmpegPath(): string {
  if (!_ffmpegPath) {
    _ffmpegPath = findBinary('ffmpeg');
    if (!_ffmpegPath) {
      throw new Error('ffmpeg 未找到。请将 ffmpeg.exe 放入 runtime/ffmpeg/ 或确保 ffmpeg 在系统 PATH 中。');
    }
  }
  return _ffmpegPath;
}

export function getFFprobePath(): string {
  if (!_ffprobePath) {
    _ffprobePath = findBinary('ffprobe');
    if (!_ffprobePath) {
      throw new Error('ffprobe 未找到。');
    }
  }
  return _ffprobePath;
}

let _nvencChecked: boolean | null = null;

export async function hasNvenc(): Promise<boolean> {
  if (_nvencChecked !== null) return _nvencChecked;
  try {
    const ffmpeg = getFFmpegPath();
    await execFileAsync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
      '-c:v', 'h264_nvenc', '-f', 'null', '-',
    ], { timeout: 15000 });
    _nvencChecked = true;
  } catch {
    _nvencChecked = false;
  }
  return _nvencChecked;
}

export async function probeVideo(filePath: string): Promise<{ duration: number; width: number; height: number }> {
  const ffprobe = getFFprobePath();
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-select_streams', 'v:0',
    filePath,
  ], { timeout: 30000 });

  const info = JSON.parse(stdout);
  const videoStream = info.streams?.[0];
  const duration = parseFloat(info.format?.duration || '0');
  const width = parseInt(videoStream?.width || '0', 10);
  const height = parseInt(videoStream?.height || '0', 10);
  return { duration, width, height };
}

export async function extractWaveformPeaks(
  videoPath: string,
  sampleRate = 8000,
  bins = 2000,
): Promise<{ peaks: number[]; duration: number }> {
  const ffmpeg = getFFmpegPath();

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-f', 's16le', '-acodec', 'pcm_s16le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    proc.on('close', (code) => {
      const raw = Buffer.concat(chunks);
      if (raw.length === 0) {
        resolve({ peaks: new Array(bins).fill(0), duration: 0 });
        return;
      }

      // Convert to Int16 array
      const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
      const duration = samples.length / sampleRate;

      // Downsample into bins
      const binSize = Math.max(1, Math.floor(samples.length / bins));
      const peaks: number[] = [];
      let maxPeak = 0;

      for (let i = 0; i < bins; i++) {
        const start = i * binSize;
        const end = Math.min(start + binSize, samples.length);
        let peak = 0;
        for (let j = start; j < end; j++) {
          const abs = Math.abs(samples[j]);
          if (abs > peak) peak = abs;
        }
        peaks.push(peak);
        if (peak > maxPeak) maxPeak = peak;
      }

      // Normalize to [0, 1]
      if (maxPeak > 0) {
        for (let i = 0; i < peaks.length; i++) {
          peaks[i] /= maxPeak;
        }
      }

      resolve({ peaks, duration });
    });

    proc.on('error', reject);
  });
}



export async function exportSubclip(
  sourcePath: string,
  start: number,
  end: number,
  outputPath: string,
  useGpu = true,
): Promise<string> {
  const ffmpeg = getFFmpegPath();
  const gpuEncode = useGpu && await hasNvenc();
  const duration = end - start;

  if (duration <= 0) {
    throw new Error(`子切片时长无效: start=${start}, end=${end}`);
  }

  const buildCmd = (gpu: boolean): string[] => {
    const cmd = ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', sourcePath,
      '-ss', start.toFixed(3),
      '-t', duration.toFixed(3),
      '-map', '0:v:0?', '-map', '0:a?'];

    if (gpu) {
      cmd.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '18');
    } else {
      cmd.push('-c:v', 'libx264', '-crf', '18', '-preset', 'fast');
    }

    cmd.push('-force_key_frames', 'expr:eq(n,0)',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
      '-start_at_zero',
      outputPath);
    return cmd;
  };

  try {
    await execFileAsync(ffmpeg, buildCmd(gpuEncode), { timeout: 300000 });
  } catch {
    if (!gpuEncode) throw new Error('ffmpeg 导出失败');
    _nvencChecked = false;
    await execFileAsync(ffmpeg, buildCmd(false), { timeout: 300000 });
  }

  return outputPath;
}
