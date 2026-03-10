// Category management — CRUD
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ProjectIndex } from '../shared/types';
import { saveIndex } from './indexIO';

const ILLEGAL_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;

function sanitizeFilename(text: string): string {
  return text.replace(ILLEGAL_CHARS_RE, '').trim();
}

export function addCategory(index: ProjectIndex, name: string): string {
  const clean = sanitizeFilename(name).trim();
  if (!clean) throw new Error('分类名称不能为空');
  if (index.categories.includes(clean)) throw new Error(`分类 「${clean}」 已存在`);

  const outDir = join(index.outputDir, clean);
  mkdirSync(outDir, { recursive: true });

  index.categories.push(clean);
  saveIndex(index);
  return clean;
}

export function removeCategory(index: ProjectIndex, name: string): void {
  if (!index.categories.includes(name)) throw new Error(`分类 「${name}」 不存在`);
  index.categories = index.categories.filter(c => c !== name);
  saveIndex(index);
}


