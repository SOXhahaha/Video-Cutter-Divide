// Renderer — Mini Video Editor
// Core concepts:
//   - Timeline = waveform + colored slice blocks (no separate seek slider)
//   - Split: cuts current slice in two at playhead
//   - Delete: removes selected slice, remaining auto-fill
//   - Undo stack for delete/split operations
//   - Play/Pause returns to the point where play started

// ================================================================
// State
// ================================================================
/** @type {import('../shared/types').ProjectIndex | null} */
let index = null;
/** @type {import('../shared/types').ClipItem | null} */
let currentItem = null;
let waveformData = null;   // { peaks: number[], duration: number }
let selectedSliceId = null;
let playStartTime = 0;     // time when play was pressed
let roiRect = null;
let roiEditMode = false;

// Settings state
let settings = {
  ocr: { sampleInterval: 0.2, minConfidence: 0.8, minTextLength: 2 },
  mergeSimilarity: 0.5,
};

// Undo stack: each entry = { type, data (snapshot of subclips before action) }
const undoStack = [];
const MAX_UNDO = 50;

// ================================================================
// App state persistence helpers
// ================================================================
function collectAppState() {
  return {
    sourceDir: sourceDir.value.trim(),
    outputDir: outputDir.value.trim(),
    volumeDb: parseInt(volumeDbSlider.value, 10),
    settings: {
      sampleInterval: settings.ocr.sampleInterval,
      minConfidence: settings.ocr.minConfidence,
      minTextLength: settings.ocr.minTextLength,
      mergeSimilarity: settings.mergeSimilarity,
    },
  };
}

function persistAppState() {
  window.api.saveAppState(collectAppState());
}

// ================================================================
// DOM refs
// ================================================================
const $ = (sel) => document.querySelector(sel);
const sourceDir = $('#source-dir');
const outputDir = $('#output-dir');
const browseSourceBtn = $('#browse-source');
const browseOutputBtn = $('#browse-output');
const scanBtn = $('#scan-btn');
const videoListEl = $('#video-list');
const videoCountEl = $('#video-count');
const videoPlayer = $('#video-player');
const roiOverlay = $('#roi-overlay');
const previewPlaceholder = $('#preview-placeholder');
const waveformCanvas = $('#waveform-canvas');
const timelineContainer = $('#timeline-container');
const timelineSlicesEl = $('#timeline-slices');
const playheadEl = $('#playhead');
const playBtn = $('#play-btn');
const splitBtn = $('#split-btn');
const deleteSliceBtn = $('#delete-slice-btn');
const undoBtn = $('#undo-btn');
const resetBtn = $('#reset-btn');
const timeLabel = $('#time-label');
const sliceBody = $('#slice-body');
const infoLabel = $('#info-label');
const newCatInput = $('#new-cat-input');
const addCatBtn = $('#add-cat-btn');
const catListEl = $('#cat-list');
const removeCatBtn = $('#remove-cat-btn');
const catButtonsEl = $('#cat-buttons');
const ocrBtn = $('#ocr-btn');
const roiModeBtn = $('#roi-mode-btn');
const roiClearBtn = $('#roi-clear-btn');
const roiLabelEl = $('#roi-label');
const subtitleListEl = $('#subtitle-list');
const deleteSubtitleBtn = $('#delete-subtitle-btn');
const addSubtitleInput = $('#add-subtitle-input');
const addSubtitleBtn = $('#add-subtitle-btn');
const settingsBtn = $('#settings-btn');
const settingsOverlay = $('#settings-overlay');
const settingsOkBtn = $('#settings-ok');
const settingsCancelBtn = $('#settings-cancel');
const statusMessage = $('#status-message');
const volumeDbSlider = $('#volume-db');
const volumeDbLabel = $('#volume-db-label');
let selectedSubtitleIdx = -1;

// ================================================================
// Helpers
// ================================================================
function fmt(s) {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

function setStatus(msg) { statusMessage.textContent = msg; }
function round3(v) { return Math.round(v * 1000) / 1000; }

// ================================================================
// Directory + Scan
// ================================================================
async function doScan() {
  const src = sourceDir.value.trim();
  const out = outputDir.value.trim();
  if (!src || !out) return;
  scanBtn.disabled = true;
  setStatus('正在扫描目录…');
  try {
    index = await window.api.scanDirectory(src, out);
    refreshVideoList();
    await loadCategoriesFromOutput();
    rebuildCategoryButtons();
    setStatus(`扫描完成，共 ${index.items.length} 个视频。`);
    selectNextUnprocessed();
  } catch (err) {
    alert('扫描失败: ' + err.message);
  } finally {
    scanBtn.disabled = false;
  }
}

browseSourceBtn.addEventListener('click', async () => {
  const dir = await window.api.chooseDirectory();
  if (dir) { sourceDir.value = dir; persistAppState(); await doScan(); }
});
browseOutputBtn.addEventListener('click', async () => {
  const dir = await window.api.chooseDirectory();
  if (dir) { outputDir.value = dir; persistAppState(); await doScan(); }
});

scanBtn.addEventListener('click', () => doScan());

// ================================================================
// Video List
// ================================================================
function refreshVideoList() {
  videoListEl.innerHTML = '';
  if (!index) { videoCountEl.textContent = '共 0 个视频'; return; }
  let shown = 0;
  for (const item of index.items) {
    const el = document.createElement('div');
    el.className = 'tree-item';
    if (currentItem && currentItem.id === item.id) el.classList.add('selected');
    el.dataset.id = item.id;
    const icon = item.processed ? '🟢' : '⬜';
    el.innerHTML = `
      <span class="icon">${icon}</span>
      <span class="name" title="${item.fileName}">${item.fileName}</span>`;
    el.addEventListener('click', () => selectVideo(item.id));
    videoListEl.appendChild(el);
    shown++;
  }
  videoCountEl.textContent = `共 ${shown} 个视频`;
}

function selectNextUnprocessed() {
  if (!index) return;
  const next = index.items.find(i => !i.processed);
  if (next) {
    selectVideo(next.id);
  } else {
    setStatus('所有视频已处理完毕！');
  }
}

function checkAutoAdvance() {
  if (!currentItem) return;
  // Check if all subclips are processed
  const allDone = currentItem.subclips.length > 0 && currentItem.subclips.every(sc => sc.processed);
  if (allDone || currentItem.processed) {
    currentItem.processed = true;
    refreshVideoList();
    selectNextUnprocessed();
  } else {
    refreshSliceList();
    refreshVideoList();
  }
}

async function selectVideo(clipId) {
  if (!index) return;
  const item = index.items.find(i => i.id === clipId);
  if (!item) return;

  currentItem = item;
  selectedSliceId = null;
  selectedSubtitleIdx = -1;
  undoStack.length = 0;

  // Probe video metadata if not yet loaded
  if (!item.duration) {
    try {
      const info = await window.api.probeVideo(item.sourcePath);
      item.duration = info.duration;
      item.width = info.width;
      item.height = info.height;
    } catch {
      item.duration = 0;
      item.width = 0;
      item.height = 0;
    }
  }

  // If no slices yet, create one full-length slice
  if (!item.subclips.length && item.duration > 0) {
    item.subclips = [{
      id: crypto.randomUUID(),
      start: 0,
      end: item.duration,
      processed: false,
    }];
  }

  videoListEl.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === clipId);
  });

  videoPlayer.src = `file:///${item.sourcePath.replace(/\\/g, '/')}`;
  videoPlayer.load();
  previewPlaceholder.style.display = 'none';

  videoPlayer.addEventListener('loadedmetadata', () => {
    videoPlayer.currentTime = 0;
  }, { once: true });

  setStatus('提取音频波形…');
  try {
    waveformData = await window.api.extractWaveform(item.sourcePath);
    drawTimeline();
    setStatus('波形加载完成。');
  } catch {
    waveformData = null;
    drawTimeline();
    setStatus('波形提取失败。');
  }

  refreshSliceList();
  refreshSubtitleList();
  updateInfoLabel();
}

// ================================================================
// Play / Pause — returns to play start point on pause
// ================================================================
playBtn.addEventListener('click', togglePlay);

function togglePlay() {
  if (!currentItem) return;
  if (videoPlayer.paused) {
    // If a slice is selected, constrain playback to it
    const sc = selectedSliceId ? currentItem.subclips.find(s => s.id === selectedSliceId) : null;
    playStartTime = videoPlayer.currentTime;
    videoPlayer.play();
    playBtn.textContent = '⏸';
  } else {
    videoPlayer.pause();
    videoPlayer.currentTime = playStartTime;
    playBtn.textContent = '▶';
  }
}

videoPlayer.addEventListener('ended', () => {
  videoPlayer.currentTime = playStartTime;
  playBtn.textContent = '▶';
});

// Constrain playback to selected slice
videoPlayer.addEventListener('timeupdate', () => {
  const t = videoPlayer.currentTime;
  const d = videoPlayer.duration || 0;
  timeLabel.textContent = `${fmt(t)} / ${fmt(d)}`;
  updatePlayhead();

  // If playing and a slice is selected, stop at slice end
  if (!videoPlayer.paused && selectedSliceId && currentItem) {
    const sc = currentItem.subclips.find(s => s.id === selectedSliceId);
    if (sc && t >= sc.end) {
      videoPlayer.pause();
      videoPlayer.currentTime = playStartTime;
      playBtn.textContent = '▶';
    }
  }
});

function updatePlayhead() {
  if (!currentItem || !waveformData || waveformData.duration <= 0) return;
  const ratio = (videoPlayer.currentTime || 0) / waveformData.duration;
  const rect = timelineContainer.getBoundingClientRect();
  playheadEl.style.left = `${ratio * rect.width}px`;
}

// ================================================================
// Timeline — waveform canvas + direct seeking
// ================================================================
function drawTimeline() {
  drawWaveform();
  drawTimelineSlices();
  updatePlayhead();
}

function drawWaveform() {
  const canvas = waveformCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = timelineContainer.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, w, h);

  if (!waveformData || !waveformData.peaks.length || waveformData.duration <= 0) {
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '12px sans-serif';
    ctx.fillText('加载波形中…', w / 2, h / 2);
    return;
  }

  const { peaks, duration } = waveformData;
  const n = peaks.length;

  // Waveform bars
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 1;
  for (let i = 0; i < Math.min(n, w); i++) {
    const idx = Math.min(Math.floor(i / w * n), n - 1);
    const amp = peaks[idx];
    const barH = amp * h * 0.85;
    const y0 = (h - barH) / 2;
    ctx.beginPath();
    ctx.moveTo(i, y0);
    ctx.lineTo(i, y0 + barH);
    ctx.stroke();
  }
}

function drawTimelineSlices() {
  timelineSlicesEl.innerHTML = '';
  if (!currentItem || !waveformData || waveformData.duration <= 0) return;

  const duration = waveformData.duration;
  const slices = currentItem.subclips;

  slices.forEach((sc, i) => {
    const left = (sc.start / duration) * 100;
    const width = ((sc.end - sc.start) / duration) * 100;

    const el = document.createElement('div');
    el.className = 'timeline-slice';
    if (sc.id === selectedSliceId) el.classList.add('selected');
    el.style.left = `${left}%`;
    el.style.width = `${width}%`;
    el.innerHTML = `<span class="slice-label">${i + 1}</span>`;

    el.addEventListener('click', () => {
      selectSlice(sc.id);
    });

    timelineSlicesEl.appendChild(el);
  });
}

// Click on timeline to seek
timelineContainer.addEventListener('mousedown', (e) => {
  if (roiEditMode) return;
  seekToMouse(e);
  const onMove = (ev) => seekToMouse(ev);
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

function seekToMouse(e) {
  if (!waveformData || waveformData.duration <= 0) return;
  const rect = timelineContainer.getBoundingClientRect();
  const ratio = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
  const t = ratio * waveformData.duration;
  videoPlayer.currentTime = t;
  playStartTime = t;
  updatePlayhead();

  // Auto-select the slice under cursor
  if (currentItem) {
    const sc = currentItem.subclips.find(s => t >= s.start && t < s.end);
    if (sc && sc.id !== selectedSliceId) {
      selectedSliceId = sc.id;
      drawTimelineSlices();
      refreshSliceList();
    }
  }
}

window.addEventListener('resize', drawTimeline);

// ================================================================
// Slice selection
// ================================================================
function selectSlice(id) {
  selectedSliceId = id;
  drawTimelineSlices();
  refreshSliceList();
}

// ================================================================
// Split — cut current slice in two at playhead position
// ================================================================
splitBtn.addEventListener('click', doSplit);

async function doSplit() {
  if (!index || !currentItem || !waveformData) return;
  const t = round3(videoPlayer.currentTime);
  const slices = currentItem.subclips;

  // Find which slice contains the playhead
  const idx = slices.findIndex(sc => t > sc.start + 0.05 && t < sc.end - 0.05);
  if (idx < 0) {
    setStatus('播放头不在任何切片中间，无法切割。');
    return;
  }

  // Save undo
  pushUndo('split');

  const orig = slices[idx];
  const left = {
    id: crypto.randomUUID(),
    start: orig.start,
    end: t,
    processed: false,
  };
  const right = {
    id: crypto.randomUUID(),
    start: t,
    end: orig.end,
    processed: false,
  };

  slices.splice(idx, 1, left, right);
  selectedSliceId = right.id;

  await window.api.saveIndex(index);
  drawTimelineSlices();
  refreshSliceList();
  refreshVideoList();
  setStatus(`已在 ${fmt(t)} 切割为两段`);
}

// ================================================================
// Delete slice — remove selected, keep remaining at original times
// ================================================================
deleteSliceBtn.addEventListener('click', doDeleteSlice);

async function doDeleteSlice() {
  if (!index || !currentItem || !selectedSliceId) {
    setStatus('请先选中切片。');
    return;
  }

  const slices = currentItem.subclips;
  if (slices.length <= 1) {
    setStatus('至少保留一个切片。');
    return;
  }

  pushUndo('delete');

  const idx = slices.findIndex(sc => sc.id === selectedSliceId);
  if (idx < 0) return;

  slices.splice(idx, 1);

  selectedSliceId = slices.length > 0 ? slices[Math.min(idx, slices.length - 1)].id : null;

  await window.api.saveIndex(index);
  drawTimelineSlices();
  refreshSliceList();
  refreshVideoList();
  setStatus('已删除切片。');
}

// ================================================================
// Undo
// ================================================================
function pushUndo(type) {
  if (!currentItem) return;
  const snapshot = JSON.parse(JSON.stringify(currentItem.subclips));
  undoStack.push({ type, snapshot, selectedSliceId });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

undoBtn.addEventListener('click', doUndo);

async function doUndo() {
  if (!index || !currentItem || !undoStack.length) {
    setStatus('没有可撤回的操作。');
    return;
  }

  const entry = undoStack.pop();
  currentItem.subclips = entry.snapshot;
  selectedSliceId = entry.selectedSliceId;

  await window.api.saveIndex(index);
  drawTimelineSlices();
  refreshSliceList();
  refreshVideoList();
  setStatus(`已撤回${entry.type === 'split' ? '切割' : '删除'}操作。`);
}

// ================================================================
// Reset — restore to single full-length slice
// ================================================================
resetBtn.addEventListener('click', doReset);

async function doReset() {
  if (!index || !currentItem) return;
  const dur = currentItem.duration;
  if (dur <= 0) return;

  pushUndo('reset');

  currentItem.subclips = [{
    id: crypto.randomUUID(),
    start: 0,
    end: dur,
    processed: false,
  }];
  currentItem.processed = false;
  selectedSliceId = currentItem.subclips[0].id;

  await window.api.saveIndex(index);
  drawTimelineSlices();
  refreshSliceList();
  refreshVideoList();
  setStatus('已还原为完整切片。');
}

// ================================================================
// Slice list table
// ================================================================
function refreshSliceList() {
  sliceBody.innerHTML = '';
  if (!currentItem) return;
  currentItem.subclips.forEach((sc, i) => {
    const tr = document.createElement('tr');
    if (sc.id === selectedSliceId) tr.classList.add('selected');
    const dur = sc.end - sc.start;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${fmt(sc.start)}</td>
      <td>${fmt(sc.end)}</td>
      <td>${fmt(dur)}</td>
      <td>${sc.processed ? '🟢' : ''}</td>`;
    tr.addEventListener('click', () => selectSlice(sc.id));
    sliceBody.appendChild(tr);
  });
}

// ================================================================
// Category management — read from output subfolders
// ================================================================
async function loadCategoriesFromOutput() {
  if (!index || !index.outputDir) return;
  try {
    const folders = await window.api.listOutputSubfolders(index.outputDir);
    index.categories = folders;
  } catch {}
  refreshCategoryList();
}

function refreshCategoryList() {
  catListEl.innerHTML = '';
  if (!index) return;
  for (let i = 0; i < index.categories.length; i++) {
    const cat = index.categories[i];
    const el = document.createElement('div');
    el.className = 'tree-item';
    el.textContent = cat;
    el.draggable = true;
    el.dataset.idx = String(i);
    el.addEventListener('click', () => {
      catListEl.querySelectorAll('.tree-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
    });
    el.addEventListener('dragstart', (e) => {
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = i;
      if (fromIdx === toIdx) return;
      const [moved] = index.categories.splice(fromIdx, 1);
      index.categories.splice(toIdx, 0, moved);
      refreshCategoryList();
      rebuildCategoryButtons();
      await window.api.saveIndex(index);
    });
    catListEl.appendChild(el);
  }
}

function rebuildCategoryButtons() {
  catButtonsEl.innerHTML = '';
  if (!index) return;
  for (const cat of index.categories) {
    const btn = document.createElement('button');
    btn.className = 'cat-btn';
    btn.textContent = cat;
    btn.addEventListener('click', () => classifyCurrent(cat));
    catButtonsEl.appendChild(btn);
  }
  // "跳过" button — marks current item/slice as processed without exporting
  const skipBtn = document.createElement('button');
  skipBtn.className = 'cat-btn skip-btn';
  skipBtn.textContent = '跳过';
  skipBtn.addEventListener('click', async () => {
    if (!index || !currentItem) { alert('请先选择一个视频。'); return; }
    const sc = selectedSliceId ? currentItem.subclips.find(s => s.id === selectedSliceId) : null;
    if (sc) {
      sc.processed = true;
    } else {
      currentItem.processed = true;
    }
    await window.api.saveIndex(index);
    checkAutoAdvance();
    setStatus('已跳过。');
  });
  catButtonsEl.appendChild(skipBtn);
}

addCatBtn.addEventListener('click', addNewCategory);
newCatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNewCategory(); });

async function addNewCategory() {
  if (!index) { alert('请先扫描目录。'); return; }
  const name = newCatInput.value.trim();
  if (!name) return;
  try {
    await window.api.addCategory(index, name);
    index.categories.push(name.replace(/[<>:"/\\|?*]/g, '').trim());
    newCatInput.value = '';
    refreshCategoryList();
    rebuildCategoryButtons();
  } catch (err) {
    alert('添加失败: ' + err.message);
  }
}

removeCatBtn.addEventListener('click', async () => {
  if (!index) return;
  const selected = catListEl.querySelector('.tree-item.selected');
  if (!selected) return;
  const name = selected.textContent;
  try {
    await window.api.removeCategory(index, name);
    index.categories = index.categories.filter(c => c !== name);
    refreshCategoryList();
    rebuildCategoryButtons();
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
});

async function classifyCurrent(category) {
  if (!index || !currentItem) { alert('请先选择一个视频。'); return; }

  // If there are slices and one is selected, export just that slice
  const sc = selectedSliceId ? currentItem.subclips.find(s => s.id === selectedSliceId) : null;
  const start = sc ? sc.start : 0;
  const end = sc ? sc.end : currentItem.duration;

  // Build subtitle from checked candidates
  const checkedTexts = currentItem.subtitleCandidates
    .filter(c => c.checked !== false && c.text.trim())
    .map(c => c.text);
  const subtitle = checkedTexts.length ? checkedTexts.join(' ') : '';
  const safeCat = category.replace(/[<>:"/\\|?*]/g, '');
  const body = subtitle.trim() ? subtitle.trim().slice(0, 50).replace(/[<>:"/\\|?*]/g, '') : '未识别字幕';
  const filename = `【${safeCat}】${body}${currentItem.fileExt}`;
  const outPath = `${index.outputDir}/${category}/${filename}`;

  setStatus('正在导出…');
  try {
    await window.api.exportSubclip(currentItem.sourcePath, start, end, outPath);
    if (sc) {
      sc.processed = true;
    } else {
      currentItem.processed = true;
    }
    await window.api.saveIndex(index);
    // Refresh categories in case new subfolders were created
    await loadCategoriesFromOutput();
    rebuildCategoryButtons();
    setStatus(`已导出: ${filename}`);
    checkAutoAdvance();
  } catch (err) {
    alert('导出失败: ' + err.message);
  }
}



// ================================================================
// OCR
// ================================================================
ocrBtn.addEventListener('click', async () => {
  if (!currentItem) return;
  const config = getOCRConfig();
  if (!config) {
    alert('请先框选 ROI 区域。');
    return;
  }
  ocrBtn.disabled = true;
  setStatus('正在识别字幕（并行处理）…');
  try {
    const candidates = await window.api.runSubtitleScan(currentItem.sourcePath, config);
    currentItem.subtitleCandidates = candidates;
    // Auto-merge similar subtitles
    const beforeCount = currentItem.subtitleCandidates.length;
    autoMergeSubtitles();
    const afterCount = currentItem.subtitleCandidates.length;
    await window.api.saveIndex(index);
    refreshSubtitleList();
    const mergeInfo = beforeCount > afterCount ? `（自动合并 ${beforeCount} → ${afterCount}）` : '';
    setStatus(`字幕识别完成: ${afterCount} 条${mergeInfo}`);
  } catch (err) {
    alert('字幕识别失败: ' + err.message);
  } finally {
    ocrBtn.disabled = false;
  }
});

function getOCRConfig() {
  if (roiRect) {
    return {
      region: roiRect,
      sampleInterval: settings.ocr.sampleInterval,
      minConfidence: settings.ocr.minConfidence,
      minTextLength: settings.ocr.minTextLength,
    };
  }
  return null;
}

// ================================================================
// ROI selection
// ================================================================
let roiDragStart = null;

roiModeBtn.addEventListener('click', () => {
  roiEditMode = !roiEditMode;
  roiModeBtn.textContent = roiEditMode ? '结束框选' : '框选 ROI';
  roiModeBtn.classList.toggle('active', roiEditMode);
  roiOverlay.classList.toggle('roi-active', roiEditMode);
  if (roiEditMode) setStatus('ROI 框选模式：拖拽设置字幕区域。');
});

roiClearBtn.addEventListener('click', () => {
  roiRect = null;
  updateROILabel();
  drawROIOverlay();
});

roiOverlay.addEventListener('mousedown', (e) => {
  if (!roiEditMode) return;
  const rect = roiOverlay.getBoundingClientRect();
  roiDragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
});

roiOverlay.addEventListener('mousemove', (e) => {
  if (!roiDragStart) return;
  const rect = roiOverlay.getBoundingClientRect();
  drawROIDrag(roiDragStart.x, roiDragStart.y, e.clientX - rect.left, e.clientY - rect.top);
});

roiOverlay.addEventListener('mouseup', (e) => {
  if (!roiDragStart) return;
  const rect = roiOverlay.getBoundingClientRect();
  const dx = e.clientX - rect.left;
  const dy = e.clientY - rect.top;

  const vw = videoPlayer.videoWidth || 1;
  const vh = videoPlayer.videoHeight || 1;
  const cw = rect.width;
  const ch = rect.height;
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const offX = (cw - dw) / 2;
  const offY = (ch - dh) / 2;

  const sx = Math.min(roiDragStart.x, dx);
  const sy = Math.min(roiDragStart.y, dy);
  const sw = Math.abs(dx - roiDragStart.x);
  const sh = Math.abs(dy - roiDragStart.y);

  if (sw < 3 || sh < 3) { roiDragStart = null; drawROIOverlay(); return; }

  const fx = Math.round(Math.max(0, (sx - offX) / dw) * vw);
  const fy = Math.round(Math.max(0, (sy - offY) / dh) * vh);
  const fw = Math.round(Math.min(sw / dw, 1) * vw);
  const fh = Math.round(Math.min(sh / dh, 1) * vh);

  roiRect = {
    x: Math.max(0, Math.min(fx, vw - 1)),
    y: Math.max(0, Math.min(fy, vh - 1)),
    width: Math.max(1, Math.min(fw, vw - fx)),
    height: Math.max(1, Math.min(fh, vh - fy)),
  };

  roiDragStart = null;
  updateROILabel();
  drawROIOverlay();
  setStatus(`ROI: ${roiRect.x},${roiRect.y} ${roiRect.width}×${roiRect.height}`);
});

function updateROILabel() {
  roiLabelEl.textContent = roiRect
    ? `ROI: x=${roiRect.x}, y=${roiRect.y}, w=${roiRect.width}, h=${roiRect.height}`
    : 'ROI: 未设置';
}

function drawROIOverlay() {
  const canvas = roiOverlay;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (!roiRect || !currentItem) return;
  const vw = videoPlayer.videoWidth || 1;
  const vh = videoPlayer.videoHeight || 1;
  const cw = rect.width;
  const ch = rect.height;
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const offX = (cw - dw) / 2;
  const offY = (ch - dh) / 2;

  const rx = offX + roiRect.x / vw * dw;
  const ry = offY + roiRect.y / vh * dh;
  const rw = roiRect.width / vw * dw;
  const rh = roiRect.height / vh * dh;

  ctx.strokeStyle = '#00e676';
  ctx.lineWidth = 2;
  ctx.fillStyle = 'rgba(0, 230, 118, 0.15)';
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeRect(rx, ry, rw, rh);
}

function drawROIDrag(sx, sy, ex, ey) {
  drawROIOverlay();
  const ctx = roiOverlay.getContext('2d');
  const x = Math.min(sx, ex);
  const y = Math.min(sy, ey);
  const w = Math.abs(ex - sx);
  const h = Math.abs(ey - sy);
  ctx.setLineDash([5, 3]);
  ctx.strokeStyle = '#0078d4';
  ctx.lineWidth = 2;
  ctx.fillStyle = 'rgba(0,120,212,0.15)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
}

// ================================================================
// Subtitle list — with delete support
// ================================================================
function refreshSubtitleList() {
  subtitleListEl.innerHTML = '';
  if (!currentItem) return;
  currentItem.subtitleCandidates.forEach((cand, idx) => {
    const el = document.createElement('div');
    el.className = 'subtitle-item';
    if (idx === selectedSubtitleIdx) el.classList.add('selected');
    el.draggable = true;
    el.dataset.idx = String(idx);
    if (cand.checked === undefined) cand.checked = true;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'subtitle-check';
    cb.checked = cand.checked;
    cb.addEventListener('change', async () => {
      cand.checked = cb.checked;
      await window.api.saveIndex(index);
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
    el.appendChild(cb);
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = cand.text;
    el.appendChild(textSpan);
    if (cand.edited) {
      const editedSpan = document.createElement('span');
      editedSpan.className = 'edited';
      editedSpan.textContent = '✏️';
      el.appendChild(editedSpan);
    }
    el.addEventListener('click', () => {
      selectedSubtitleIdx = idx;
      subtitleListEl.querySelectorAll('.subtitle-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      // Already editing?
      if (el.querySelector('.subtitle-edit-input')) return;
      const origText = cand.text;
      textSpan.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'subtitle-edit-input';
      input.value = origText;
      el.insertBefore(input, textSpan.nextSibling);
      input.focus();
      input.select();
      const commit = async () => {
        const newText = input.value.trim();
        if (newText && newText !== origText) {
          cand.text = newText;
          cand.edited = true;
          await window.api.saveIndex(index);
        }
        refreshSubtitleList();
      };
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
        if (ke.key === 'Escape') { refreshSubtitleList(); }
        ke.stopPropagation();
      });
      input.addEventListener('blur', () => commit());
      input.addEventListener('click', (ce) => ce.stopPropagation());
    });
    el.addEventListener('dragstart', (e) => {
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = idx;
      if (fromIdx === toIdx) return;
      const [moved] = currentItem.subtitleCandidates.splice(fromIdx, 1);
      currentItem.subtitleCandidates.splice(toIdx, 0, moved);
      selectedSubtitleIdx = toIdx;
      refreshSubtitleList();
      await window.api.saveIndex(index);
    });
    subtitleListEl.appendChild(el);
  });
}

deleteSubtitleBtn.addEventListener('click', async () => {
  if (!currentItem || selectedSubtitleIdx < 0 || selectedSubtitleIdx >= currentItem.subtitleCandidates.length) {
    setStatus('请先选中一条字幕。');
    return;
  }
  currentItem.subtitleCandidates.splice(selectedSubtitleIdx, 1);
  selectedSubtitleIdx = -1;
  await window.api.saveIndex(index);
  refreshSubtitleList();
  setStatus('已删除字幕。');
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ================================================================
// Info
// ================================================================
function updateInfoLabel() {
  if (!currentItem) { infoLabel.textContent = '未选择视频'; return; }
  const lines = [
    `${currentItem.fileName}  |  ${fmt(currentItem.duration)}  |  ${currentItem.width}×${currentItem.height}  |  ${currentItem.processed ? '已处理' : '未处理'}`,
  ];
  infoLabel.textContent = lines.join('\n');
}

// ================================================================
// Keyboard shortcuts
// ================================================================
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'KeyS' && !e.ctrlKey) {
    e.preventDefault();
    doSplit();
  } else if (e.code === 'Delete' || e.code === 'Backspace') {
    e.preventDefault();
    doDeleteSlice();
  } else if (e.code === 'KeyZ' && e.ctrlKey) {
    e.preventDefault();
    doUndo();
  } else if (e.code === 'ArrowLeft') {
    e.preventDefault();
    videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - (e.shiftKey ? 5 : 1));
    playStartTime = videoPlayer.currentTime;
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    videoPlayer.currentTime = Math.min(videoPlayer.duration || 0, videoPlayer.currentTime + (e.shiftKey ? 5 : 1));
    playStartTime = videoPlayer.currentTime;
  }
});

// ================================================================
// Volume dB slider — playback only, does not affect export
// ================================================================
volumeDbSlider.addEventListener('input', () => {
  const db = parseInt(volumeDbSlider.value, 10);
  volumeDbLabel.textContent = `${db} dB`;
  // Convert dB to linear gain: 10^(dB/20)
  videoPlayer.volume = Math.min(1, Math.max(0, Math.pow(10, db / 20)));
  persistAppState();
});

// ================================================================
// Settings dialog
// ================================================================
settingsBtn.addEventListener('click', () => {
  // Populate inputs from current settings
  $('#set-ocr-interval').value = settings.ocr.sampleInterval;
  $('#set-ocr-confidence').value = settings.ocr.minConfidence;
  $('#set-ocr-min-len').value = settings.ocr.minTextLength;
  $('#set-merge-similarity').value = settings.mergeSimilarity;
  settingsOverlay.style.display = '';
});

settingsOkBtn.addEventListener('click', () => {
  settings.ocr.sampleInterval = parseFloat($('#set-ocr-interval').value) || 0.2;
  settings.ocr.minConfidence = parseFloat($('#set-ocr-confidence').value) || 0.8;
  settings.ocr.minTextLength = parseInt($('#set-ocr-min-len').value, 10) || 2;
  settings.mergeSimilarity = parseFloat($('#set-merge-similarity').value) || 0.5;
  settingsOverlay.style.display = 'none';
  persistAppState();
  setStatus('设置已保存。');
});

settingsCancelBtn.addEventListener('click', () => {
  settingsOverlay.style.display = 'none';
});

settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.style.display = 'none';
});

// ================================================================
// Subtitle similarity & merge
// ================================================================
function textSimilarity(a, b) {
  const sa = a.trim(), sb = b.trim();
  if (sa === sb) return 1;
  if (!sa.length || !sb.length) return 0;
  const lenA = sa.length, lenB = sb.length;
  // Levenshtein distance
  const prev = new Array(lenB + 1);
  for (let j = 0; j <= lenB; j++) prev[j] = j;
  for (let i = 1; i <= lenA; i++) {
    let corner = prev[0];
    prev[0] = i;
    for (let j = 1; j <= lenB; j++) {
      const upper = prev[j];
      prev[j] = sa[i - 1] === sb[j - 1] ? corner : 1 + Math.min(corner, prev[j], prev[j - 1]);
      corner = upper;
    }
  }
  return 1 - prev[lenB] / Math.max(lenA, lenB);
}

function autoMergeSubtitles() {
  if (!currentItem || !currentItem.subtitleCandidates || currentItem.subtitleCandidates.length < 2) return;
  const threshold = settings.mergeSimilarity;
  const subs = currentItem.subtitleCandidates;
  const merged = [];
  let i = 0;

  while (i < subs.length) {
    let farthest = i;
    for (let j = i + 1; j < subs.length; j++) {
      if (textSimilarity(subs[i].text, subs[j].text) >= threshold) {
        farthest = j;
      }
    }

    if (farthest > i) {
      // Collect all entries from i to farthest, pick highest confidence text
      let start = subs[i].start, end = subs[i].end;
      let bestIdx = i;
      for (let k = i + 1; k <= farthest; k++) {
        start = Math.min(start, subs[k].start);
        end = Math.max(end, subs[k].end);
        if ((subs[k].confidence || 0) > (subs[bestIdx].confidence || 0)) bestIdx = k;
      }
      merged.push({ start, end, text: subs[bestIdx].text, confidence: subs[bestIdx].confidence, edited: false });
      i = farthest + 1;
    } else {
      merged.push({ ...subs[i] });
      i++;
    }
  }
  currentItem.subtitleCandidates = merged;
}

// ================================================================
// Manual subtitle add
// ================================================================
addSubtitleBtn.addEventListener('click', async () => {
  if (!currentItem) { setStatus('请先选择视频。'); return; }
  const text = addSubtitleInput.value.trim();
  if (!text) return;
  currentItem.subtitleCandidates.push({ text, start: 0, end: 0, edited: true });
  addSubtitleInput.value = '';
  await window.api.saveIndex(index);
  refreshSubtitleList();
  setStatus('已添加字幕。');
});
addSubtitleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSubtitleBtn.click(); });

// ================================================================
// Init — restore saved app state, then draw timeline
// ================================================================
(async () => {
  try {
    const state = await window.api.loadAppState();
    if (state.sourceDir) sourceDir.value = state.sourceDir;
    if (state.outputDir) outputDir.value = state.outputDir;
    if (state.volumeDb !== undefined) {
      volumeDbSlider.value = state.volumeDb;
      volumeDbLabel.textContent = `${state.volumeDb} dB`;
      videoPlayer.volume = Math.min(1, Math.max(0, Math.pow(10, state.volumeDb / 20)));
    }
    if (state.settings) {
      const s = state.settings;
      if (s.sampleInterval !== undefined) settings.ocr.sampleInterval = s.sampleInterval;
      if (s.minConfidence !== undefined) settings.ocr.minConfidence = s.minConfidence;
      if (s.minTextLength !== undefined) settings.ocr.minTextLength = s.minTextLength;
      if (s.mergeSimilarity !== undefined) settings.mergeSimilarity = s.mergeSimilarity;
    }
  } catch { /* ignore */ }
  drawTimeline();
  await doScan();
})();

// Save state before window closes
window.addEventListener('beforeunload', () => {
  persistAppState();
});
