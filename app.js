/**
 * 狂野飙车9 - 跑图视频对比工具
 * 基于帧特征签名余弦距离自动对齐
 */

// ===== 全局状态 =====
const state = {
  videos: [],              // [{id, file, url, name, duration}]
  regions: {},             // {videoId: {x, y, w, h}} 百分比
  frames: {},              // {videoId: [{time, signature}]}
  offsets: {},             // {videoId: offsetSeconds}
  bestOffset: 0,           // 最佳偏移量
  isPlaying: false,
  syncRAF: null,
  exporting: false
};

// ===== 初始化 =====
function init() {
  setupUpload();
}

// ===== 上传设置 =====
function setupUpload() {
  const area = document.getElementById('uploadArea');
  const input = document.getElementById('fileInput');
  
  area.addEventListener('dragover', e => {
    e.preventDefault();
    area.classList.add('dragover');
  });
  
  area.addEventListener('dragleave', () => {
    area.classList.remove('dragover');
  });
  
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  
  area.addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') input.click();
  });
  
  input.addEventListener('change', e => {
    handleFiles(e.target.files);
  });
}

// ===== 处理文件 =====
function handleFiles(files) {
  const validFiles = Array.from(files).filter(f => f.type.startsWith('video/'));
  
  if (validFiles.length === 0) {
    alert('请选择视频文件');
    return;
  }
  
  for (const file of validFiles) {
    const id = generateId();
    state.videos.push({
      id,
      file,
      url: URL.createObjectURL(file),
      name: file.name,
      duration: 0
    });
  }
  
  renderVideoList();
}

// ===== 渲染视频列表 =====
function renderVideoList() {
  const container = document.getElementById('videoList');
  const nextBtn1 = document.getElementById('nextBtn1');
  
  container.innerHTML = state.videos.map((v, i) => `
    <div class="video-item">
      <span class="video-icon">🎬</span>
      <span class="video-name">${v.name}</span>
      <button class="remove-btn" onclick="removeVideo('${v.id}')">✕</button>
    </div>
  `).join('');
  
  nextBtn1.disabled = state.videos.length < 2;
}

// ===== 移除视频 =====
function removeVideo(id) {
  const index = state.videos.findIndex(v => v.id === id);
  if (index >= 0) {
    URL.revokeObjectURL(state.videos[index].url);
    state.videos.splice(index, 1);
    delete state.regions[id];
    delete state.frames[id];
    delete state.offsets[id];
  }
  renderVideoList();
}

// ===== 步骤切换 =====
function goToStep(step) {
  document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'));
  document.getElementById(`step${step}`).classList.remove('hidden');
  
  if (step === 2) initRegionSelection();
  if (step === 3) analyzeVideos();
}

// ===== 按钮状态更新 =====
function updateButtons() {
  const step1Ready = state.videos.length >= 2;
  const step2Ready = state.videos.every(v => state.regions[v.id]);
  
  document.getElementById('nextBtn1').disabled = !step1Ready;
  document.getElementById('nextBtn2').disabled = !step2Ready;
}

// ===== 步骤2: 区域选择 =====
function initRegionSelection() {
  const container = document.getElementById('regionPanels');
  
  container.innerHTML = state.videos.map(v => `
    <div class="region-panel" id="panel-${v.id}">
      <h3>${v.name}</h3>
      <div class="region-selector" id="selector-${v.id}">
        <video id="video-${v.id}" muted></video>
        <div class="region-box" id="box-${v.id}"></div>
      </div>
      <div class="region-controls">
        <input type="range" id="seek-${v.id}" min="0" max="100" value="10">
        <button onclick="randomSeek('${v.id}')">🎲 随机</button>
        <button onclick="autoRegion('${v.id}')">🎯 右上角</button>
      </div>
      <div class="region-display" id="display-${v.id}">未选择区域</div>
    </div>
  `).join('');
  
  state.videos.forEach(v => {
    const video = document.getElementById(`video-${v.id}`);
    video.src = v.url;
    video.addEventListener('loadedmetadata', () => {
      v.duration = video.duration;
    });
    
    const slider = document.getElementById(`seek-${v.id}`);
    slider.addEventListener('input', () => {
      video.currentTime = (slider.value / 100) * video.duration;
    });
    
    setupRegionDrag(v.id);
  });
  
  updateButtons();
}

// ===== 拖拽框选（支持鼠标+触屏）=====
function setupRegionDrag(videoId) {
  const selector = document.getElementById(`selector-${videoId}`);
  const box = document.getElementById(`box-${videoId}`);
  const display = document.getElementById(`display-${videoId}`);
  
  let isDragging = false;
  let startX, startY;
  
  function getPos(e) {
    const rect = selector.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    };
  }
  
  function onStart(e) {
    e.preventDefault();
    const pos = getPos(e);
    startX = pos.x;
    startY = pos.y;
    isDragging = true;
    
    box.style.left = startX + 'px';
    box.style.top = startY + 'px';
    box.style.width = '0px';
    box.style.height = '0px';
    box.classList.add('active');
  }
  
  function onMove(e) {
    if (!isDragging) return;
    e.preventDefault();
    
    const pos = getPos(e);
    box.style.left = Math.min(startX, pos.x) + 'px';
    box.style.top = Math.min(startY, pos.y) + 'px';
    box.style.width = Math.abs(pos.x - startX) + 'px';
    box.style.height = Math.abs(pos.y - startY) + 'px';
  }
  
  function onEnd(e) {
    if (!isDragging) return;
    isDragging = false;
    
    const rect = selector.getBoundingClientRect();
    const x = (parseFloat(box.style.left) / rect.width * 100).toFixed(1);
    const y = (parseFloat(box.style.top) / rect.height * 100).toFixed(1);
    const w = (parseFloat(box.style.width) / rect.width * 100).toFixed(1);
    const h = (parseFloat(box.style.height) / rect.height * 100).toFixed(1);
    
    if (+w < 2 || +h < 2) {
      box.classList.remove('active');
      return;
    }
    
    state.regions[videoId] = { x: +x, y: +y, w: +w, h: +h };
    display.textContent = `x=${x}% y=${y}% w=${w}% h=${h}%`;
    display.style.color = 'var(--success)';
    updateButtons();
  }
  
  selector.addEventListener('mousedown', onStart);
  selector.addEventListener('mousemove', onMove);
  selector.addEventListener('mouseup', onEnd);
  selector.addEventListener('mouseleave', () => { isDragging = false; });
  
  selector.addEventListener('touchstart', onStart, { passive: false });
  selector.addEventListener('touchmove', onMove, { passive: false });
  selector.addEventListener('touchend', onEnd);
}

// ===== 随机跳转 =====
function randomSeek(videoId) {
  const video = document.getElementById(`video-${videoId}`);
  const slider = document.getElementById(`seek-${videoId}`);
  
  if (!video.duration) return;
  
  const time = Math.random() * video.duration * 0.8 + video.duration * 0.1;
  video.currentTime = time;
  slider.value = (time / video.duration) * 100;
}

// ===== 自动区域（避开速度表） =====
function autoRegion(videoId) {
  const selector = document.getElementById(`selector-${videoId}`);
  const box = document.getElementById(`box-${videoId}`);
  const display = document.getElementById(`display-${videoId}`);
  
  const rect = selector.getBoundingClientRect();
  
  state.regions[videoId] = { x: 78, y: 8, w: 18, h: 6 };
  
  box.style.left = (rect.width * 0.78) + 'px';
  box.style.top = (rect.height * 0.08) + 'px';
  box.style.width = (rect.width * 0.18) + 'px';
  box.style.height = (rect.height * 0.06) + 'px';
  box.classList.add('active');
  
  display.textContent = 'x=78% y=8% w=18% h=6% (已避开速度表)';
  display.style.color = 'var(--success)';
  updateButtons();
}

// ===== 步骤3: 分析视频 =====
async function analyzeVideos() {
  const container = document.getElementById('analysisResult');
  const compareArea = document.getElementById('comparisonArea');
  container.innerHTML = '<div class="loading">正在分析视频...</div>';
  compareArea.innerHTML = '';
  
  for (let i = 0; i < state.videos.length; i++) {
    const v = state.videos[i];
    container.innerHTML = `<div class="loading">正在提取 ${v.name} 的帧 (${i+1}/${state.videos.length})...</div>`;
    await extractFrames(v.id);
  }
  
  await calculateBestOffset();
  
  container.innerHTML = `<div class="done">分析完成！最佳偏移: ${state.bestOffset.toFixed(3)}秒</div>`;
  
  initSync();
}

// ===== 提取帧（稀疏采样：3帧用于粗匹配）=====
async function extractFrames(videoId) {
  const v = state.videos.find(v => v.id === videoId);
  const region = state.regions[videoId];
  
  if (!v || !region) return;
  
  const video = document.createElement('video');
  video.src = v.url;
  video.muted = true;
  
  await new Promise(resolve => {
    video.addEventListener('loadedmetadata', resolve);
    video.load();
  });
  
  v.duration = video.duration;
  
  const duration = video.duration;
  // 稀疏采样：在第5秒、第15秒、第25秒取3帧（避开开头倒计时）
  const sampleTimes = [5, 15, 25].filter(t => t < duration - 1).map(t => Math.min(t, duration - 0.5));
  const frames = [];
  
  for (const time of sampleTimes) {
    video.currentTime = time;
    await new Promise(resolve => {
      video.addEventListener('seeked', resolve, { once: true });
    });
    
    const signature = extractTimerSignature(video, region);
    frames.push({ time, signature });
  }
  
  state.frames[videoId] = frames;
}

// ===== 在指定时间范围内密集提取帧（复用已有video元素）=====
async function extractFramesInRange(videoId, startTime, endTime, step) {
  const v = state.videos.find(v => v.id === videoId);
  const region = state.regions[videoId];
  
  if (!v || !region) return [];
  
  // 复用已有的video元素（如果有）
  let video = document.getElementById(`video-${videoId}`);
  if (!video) {
    video = document.createElement('video');
    video.src = v.url;
    video.muted = true;
    await new Promise(resolve => {
      video.addEventListener('loadedmetadata', resolve);
      video.load();
    });
  }
  
  const duration = video.duration;
  const frames = [];
  
  for (let time = startTime; time <= endTime; time = Math.round((time + step) * 100) / 100) {
    if (time < 0 || time >= duration - 0.1) continue;
    
    video.currentTime = time;
    await new Promise(resolve => {
      video.addEventListener('seeked', resolve, { once: true });
    });
    
    const signature = extractTimerSignature(video, region);
    frames.push({ time, signature });
  }
  
  return frames;
}

// ===== 提取计时器特征签名（白色像素垂直投影）=====
function extractTimerSignature(video, region) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sx = region.x / 100 * vw;
  const sy = region.y / 100 * vh;
  const sw = region.w / 100 * vw;
  const sh = region.h / 100 * vh;
  
  const w = 128;
  const h = 32;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  
  const imageData = ctx.getImageData(0, 0, w, h);
  const { data } = imageData;
  
  const projection = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let whiteCount = 0;
    for (let y = 0; y < h; y++) {
      const idx = (y * w + x) * 4;
      const gray = data[idx] * 0.299 + data[idx+1] * 0.587 + data[idx+2] * 0.114;
      if (gray > 160) whiteCount++;
    }
    projection[x] = whiteCount / h;
  }
  
  return projection;
}

// ===== 计算最佳偏移（两阶段：3帧粗搜 + 局部密集帧精搜）=====
async function calculateBestOffset() {
  const videos = state.videos.filter(v => state.frames[v.id] && state.frames[v.id].length > 0);
  if (videos.length < 2) return;
  
  const base = videos[0];
  const baseFrames = state.frames[base.id];
  
  // 在排序帧列表中找最接近 targetTime 的签名
  function findClosest(frameList, targetTime) {
    let lo = 0, hi = frameList.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frameList[mid].time < targetTime) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(frameList[lo - 1].time - targetTime) < Math.abs(frameList[lo].time - targetTime)) {
      return frameList[lo - 1];
    }
    return frameList[lo];
  }
  
  // 用给定帧列表计算某个偏移的得分
  function scoreAtOffset(offset, baseFrameList, targetFrameList) {
    let total = 0, count = 0;
    for (const bf of baseFrameList) {
      const targetTime = bf.time + offset;
      const closest = findClosest(targetFrameList, targetTime);
      if (closest) {
        total += cosineDistance(bf.signature, closest.signature);
        count++;
      }
    }
    return count > 0 ? total / count : Infinity;
  }
  
  // ===== 第一阶段：用3帧稀疏采样做粗搜 =====
  const container = document.getElementById('analysisResult');
  container.innerHTML = '<div class="loading">第一阶段：粗略搜索（3帧）...</div>';
  
  let bestCoarseOffset = 0;
  let bestCoarseScore = Infinity;
  
  // 粗搜：用base的3帧，和每个target的3帧比较
  for (let offset = -30; offset <= 30; offset = Math.round((offset + 0.1) * 100) / 100) {
    let totalScore = 0;
    for (let i = 1; i < videos.length; i++) {
      totalScore += scoreAtOffset(offset, baseFrames, state.frames[videos[i].id]);
    }
    const avgScore = totalScore / (videos.length - 1);
    if (avgScore < bestCoarseScore) { bestCoarseScore = avgScore; bestCoarseOffset = offset; }
  }
  
  container.innerHTML = `<div class="loading">粗略结果: ${bestCoarseOffset.toFixed(2)}s，正在精细搜索...</div>`;
  
  // ===== 第二阶段：在粗偏移附近密集提取帧做精搜 =====
  const searchMargin = 0.2;
  const searchStart = Math.max(0, bestCoarseOffset - searchMargin);
  const searchEnd = bestCoarseOffset + searchMargin;
  const fineStep = 0.02; // 0.02秒步长，提取约20帧
  
  // 提取base在局部范围的密集帧
  const baseFineFrames = await extractFramesInRange(base.id, searchStart, searchEnd, fineStep);
  
  let bestFineOffset = bestCoarseOffset;
  let bestFineScore = Infinity;
  
  // 为每个非base视频提取局部密集帧并搜索
  for (let i = 1; i < videos.length; i++) {
    const target = videos[i];
    const targetFineFrames = await extractFramesInRange(target.id, searchStart, searchEnd, fineStep);
    
    // 在粗偏移附近±0.05s范围内，以0.001s步长精细搜索
    const fineSearchStart = Math.round((bestCoarseOffset - 0.05) * 1000) / 1000;
    const fineSearchEnd = Math.round((bestCoarseOffset + 0.05) * 1000) / 1000;
    
    for (let offset = fineSearchStart; offset <= fineSearchEnd; offset = Math.round((offset + 0.001) * 1000) / 1000) {
      const s = scoreAtOffset(offset, baseFineFrames, targetFineFrames);
      if (s < bestFineScore) { bestFineScore = s; bestFineOffset = offset; }
    }
  }
  
  state.bestOffset = bestFineOffset;
}

// ===== 余弦距离 =====
function cosineDistance(a, b) {
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  const denom = Math.sqrt(nA) * Math.sqrt(nB);
  return denom > 0 ? 1 - dot / denom : 1;
}

// ===== 步骤3: 同步对比 =====
function initSync() {
  const container = document.getElementById('comparisonArea');
  
  const validVideos = state.videos.filter(v => state.frames[v.id] && state.frames[v.id].length > 0);
  if (validVideos.length < 2) {
    container.innerHTML = '<div class="no-match">没有足够的数据</div>';
    return;
  }
  
  let maxTime = -Infinity;
  for (const v of validVideos) {
    if (v.duration > maxTime) maxTime = v.duration;
  }
  
  container.innerHTML = `
    <div class="sync-controls">
      <div class="timer-control">
        <label>时间:</label>
        <input type="range" id="timeSlider" min="0" max="${maxTime}" value="0" step="0.1">
        <span class="timer-display" id="timeDisplay">0.0s</span>
      </div>
      <div class="play-control">
        <button id="playBtn" onclick="toggleSyncPlay()">▶ 同步播放</button>
      </div>
      <div class="offset-display">
        <span>自动偏移: ${state.bestOffset.toFixed(3)}s</span>
      </div>
    </div>
    
    <div class="offset-controls">
      ${validVideos.slice(1).map(v => `
        <div class="offset-item">
          <span>${v.name} 微调:</span>
          <button onclick="adjustOffset('${v.id}', -0.001)">-0.001s</button>
          <button onclick="adjustOffset('${v.id}', -0.01)">-0.01s</button>
          <button onclick="adjustOffset('${v.id}', -0.1)">-0.1s</button>
          <button onclick="adjustOffset('${v.id}', -1)">-1s</button>
          <span id="offset-${v.id}">${(state.offsets[v.id] || 0).toFixed(3)}s</span>
          <button onclick="adjustOffset('${v.id}', 1)">+1s</button>
          <button onclick="adjustOffset('${v.id}', 0.1)">+0.1s</button>
          <button onclick="adjustOffset('${v.id}', 0.01)">+0.01s</button>
          <button onclick="adjustOffset('${v.id}', 0.001)">+0.001s</button>
        </div>
      `).join('')}
    </div>
    
    <div class="sync-videos">
      ${validVideos.map((v, i) => `
        <div class="sync-video">
          <h3>${v.name}</h3>
          <video id="syncvideo-${v.id}" muted playsinline></video>
        </div>
      `).join('')}
    </div>
    
    <div class="export-section">
      <h3>导出设置</h3>
      <div class="export-options">
        <div class="export-option">
          <label>布局:</label>
          <select id="exportLayout">
            <option value="horizontal">横向排列</option>
            <option value="vertical">竖向排列</option>
          </select>
        </div>
        <div class="export-option">
          <label>格式:</label>
          <select id="exportFormat">
            <option value="mp4">MP4 (H.264)</option>
            <option value="webm">WebM (VP9)</option>
          </select>
        </div>
        <button id="exportBtn" onclick="exportVideo()">📹 导出视频</button>
      </div>
      <div id="exportProgress" class="export-progress" style="display:none;"></div>
    </div>
  `;
  
  validVideos.forEach((v, i) => {
    const video = document.getElementById(`syncvideo-${v.id}`);
    video.src = v.url;
    video.load();
    state.offsets[v.id] = i === 0 ? 0 : state.bestOffset;
  });
  
  const slider = document.getElementById('timeSlider');
  slider.addEventListener('input', () => {
    if (state.isPlaying) pauseSyncPlay();
    updateSyncFromSlider();
  });
  
  updateSyncFromSlider();
}

// ===== 从滑块更新同步 =====
function updateSyncFromSlider() {
  const slider = document.getElementById('timeSlider');
  const time = parseFloat(slider.value);
  
  document.getElementById('timeDisplay').textContent = time.toFixed(1) + 's';
  
  const firstVideo = document.getElementById(`syncvideo-${state.videos[0].id}`);
  if (firstVideo) firstVideo.currentTime = time;
  
  state.videos.forEach(v => {
    if (v.id === state.videos[0].id) return;
    const video = document.getElementById(`syncvideo-${v.id}`);
    const offset = state.offsets[v.id] || 0;
    if (video) video.currentTime = Math.max(0, time + offset);
  });
}

// ===== 同步播放（纯playbackRate同步，不seek）=====
function toggleSyncPlay() {
  if (state.isPlaying) {
    pauseSyncPlay();
  } else {
    startSyncPlay();
  }
}

function startSyncPlay() {
  state.isPlaying = true;
  document.getElementById('playBtn').textContent = '⏸ 暂停';
  
  const slider = document.getElementById('timeSlider');
  const maxTime = parseFloat(slider.max);
  
  // 先设置所有视频到正确位置
  updateSyncFromSlider();
  
  // 同时开始播放所有视频
  const playPromises = [];
  state.videos.forEach(v => {
    const video = document.getElementById(`syncvideo-${v.id}`);
    if (video) {
      video.playbackRate = 1.0;
      playPromises.push(video.play().catch(() => {}));
    }
  });
  
  // 等待所有视频开始播放后再启动同步循环
  Promise.all(playPromises).then(() => {
    // 重置所有视频的播放速率
    state.videos.forEach(v => {
      const video = document.getElementById(`syncvideo-${v.id}`);
      if (video) video.playbackRate = 1.0;
    });
    
    const baseVideo = document.getElementById(`syncvideo-${state.videos[0].id}`);
    let lastBaseTime = baseVideo ? baseVideo.currentTime : 0;
    let frameCount = 0;
    
    function syncLoop() {
      if (!state.isPlaying) return;
      
      if (baseVideo && !baseVideo.paused) {
        const currentTime = baseVideo.currentTime;
        frameCount++;
        
        // 每10帧更新一次UI
        if (frameCount % 10 === 0) {
          slider.value = currentTime;
          document.getElementById('timeDisplay').textContent = currentTime.toFixed(1) + 's';
        }
        
        // 每30帧（约0.5秒）同步一次其他视频的播放速率
        if (frameCount % 30 === 0) {
          state.videos.forEach(v => {
            if (v.id === state.videos[0].id) return;
            const video = document.getElementById(`syncvideo-${v.id}`);
            if (video && !video.paused) {
              const offset = state.offsets[v.id] || 0;
              const targetTime = currentTime + offset;
              const drift = video.currentTime - targetTime;
              const absDrift = Math.abs(drift);
              
              if (absDrift > 1.0) {
                // 大偏移直接seek（暂停播放再恢复，避免卡顿）
                video.currentTime = targetTime;
              } else if (absDrift > 0.1) {
                // 中等偏移用playbackRate微调
                video.playbackRate = 1.0 - drift * 0.3;
                video.playbackRate = Math.max(0.85, Math.min(1.15, video.playbackRate));
              } else {
                video.playbackRate = 1.0;
              }
            }
          });
        }
        
        if (currentTime >= maxTime) {
          pauseSyncPlay();
          return;
        }
      }
      
      state.syncRAF = requestAnimationFrame(syncLoop);
    }
    
    state.syncRAF = requestAnimationFrame(syncLoop);
  });
}

function pauseSyncPlay() {
  state.isPlaying = false;
  document.getElementById('playBtn').textContent = '▶ 同步播放';
  
  state.videos.forEach(v => {
    const video = document.getElementById(`syncvideo-${v.id}`);
    if (video) {
      video.pause();
      video.playbackRate = 1.0;
    }
  });
  
  if (state.syncRAF) {
    cancelAnimationFrame(state.syncRAF);
    state.syncRAF = null;
  }
}

// ===== 导出视频（逐帧渲染 + ffmpeg.wasm 转 MP4）=====
async function exportVideo() {
  if (state.exporting) return;
  state.exporting = true;
  
  const exportBtn = document.getElementById('exportBtn');
  const progressEl = document.getElementById('exportProgress');
  exportBtn.disabled = true;
  exportBtn.textContent = '⏳ 导出中...';
  progressEl.style.display = 'block';
  progressEl.textContent = '准备导出...';
  
  if (state.isPlaying) pauseSyncPlay();
  
  try {
    const validVideos = state.videos.filter(v => state.frames[v.id] && state.frames[v.id].length > 0);
    if (validVideos.length < 2) throw new Error('视频不足');
    
    const layout = document.getElementById('exportLayout').value;
    const wantMP4 = document.getElementById('exportFormat').value === 'mp4';
    const fps = 30;
    
    // 创建离屏 canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const baseVideoEl = document.getElementById(`syncvideo-${validVideos[0].id}`);
    const vw = baseVideoEl.videoWidth;
    const vh = baseVideoEl.videoHeight;
    
    if (layout === 'horizontal') {
      canvas.width = vw * validVideos.length;
      canvas.height = vh;
    } else {
      canvas.width = vw;
      canvas.height = vh * validVideos.length;
    }
    
    // 始终用 WebM VP9 录制（浏览器原生支持）
    const stream = canvas.captureStream(0);
    const chunks = [];
    
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 8000000
    });
    
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    
    // 计算时间范围
    const baseOffset = state.offsets[validVideos[0].id] || 0;
    const exportStartTime = Math.max(0, -baseOffset);
    
    let maxEndTime = 0;
    validVideos.forEach(v => {
      const offset = state.offsets[v.id] || 0;
      const videoEndTime = v.duration - offset;
      if (videoEndTime > maxEndTime) maxEndTime = videoEndTime;
    });
    
    const totalDuration = maxEndTime - exportStartTime;
    const totalFrames = Math.ceil(totalDuration * fps);
    const frameInterval = 1 / fps;
    
    // 创建独立的视频元素用于逐帧渲染
    const exportVideos = [];
    for (const v of validVideos) {
      const vid = document.createElement('video');
      vid.src = v.url;
      vid.muted = true;
      vid.preload = 'auto';
      await new Promise(resolve => {
        vid.addEventListener('loadedmetadata', resolve);
        vid.load();
      });
      exportVideos.push(vid);
    }
    
    // 开始录制
    recorder.start();
    
    // 逐帧渲染
    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      if (!state.exporting) break;
      
      const time = exportStartTime + frameIdx * frameInterval;
      
      if (frameIdx % 10 === 0) {
        const progress = (frameIdx / totalFrames) * 80; // 录制占80%
        progressEl.textContent = `录制进度: ${progress.toFixed(0)}% (帧 ${frameIdx}/${totalFrames})`;
      }
      
      // Seek 每个视频到对齐后的时间点
      const seekPromises = validVideos.map((v, i) => {
        const vid = exportVideos[i];
        const offset = state.offsets[v.id] || 0;
        const targetTime = Math.max(0, Math.min(v.duration - 0.01, time + offset));
        
        return new Promise(resolve => {
          if (Math.abs(vid.currentTime - targetTime) < 0.001) {
            resolve();
            return;
          }
          vid.currentTime = targetTime;
          vid.addEventListener('seeked', resolve, { once: true });
          setTimeout(resolve, 200);
        });
      });
      
      await Promise.all(seekPromises);
      
      // 绘制所有视频帧到 canvas
      validVideos.forEach((v, i) => {
        const vid = exportVideos[i];
        if (layout === 'horizontal') {
          ctx.drawImage(vid, i * vw, 0, vw, vh);
        } else {
          ctx.drawImage(vid, 0, i * vh, vw, vh);
        }
      });
      
      if (stream.requestFrame) {
        stream.requestFrame();
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000 / fps));
    }
    
    // 停止录制
    recorder.stop();
    await new Promise(resolve => { recorder.onstop = () => resolve(); });
    
    // 清理临时视频元素
    exportVideos.forEach(v => { v.src = ''; });
    
    let finalBlob;
    let finalExt;
    
    if (wantMP4) {
      // 尝试用 ffmpeg.wasm 将 WebM 转为 MP4
      // file:// 下 Worker 被浏览器拦截，自动回退到 WebM
      let mp4Failed = false;
      try {
        progressEl.textContent = '正在转换为 MP4 格式... (ffmpeg.wasm)';
        
        const { FFmpeg } = FFmpegWASM;
        const ffmpeg = new FFmpeg();
        
        ffmpeg.on('progress', ({ progress: p }) => {
          const total = 80 + p * 20;
          progressEl.textContent = `转换进度: ${total.toFixed(0)}%`;
        });
        
        await ffmpeg.load({
          coreURL: 'ffmpeg/ffmpeg-core.js',
          wasmURL: 'ffmpeg/ffmpeg-core.wasm',
          workerURL: 'ffmpeg/814.ffmpeg.js',
        });
        
        const webmBlob = new Blob(chunks, { type: 'video/webm' });
        const webmData = new Uint8Array(await webmBlob.arrayBuffer());
        
        await ffmpeg.writeFile('input.webm', webmData);
        await ffmpeg.exec(['-i', 'input.webm', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-y', 'output.mp4']);
        
        const mp4Data = await ffmpeg.readFile('output.mp4');
        finalBlob = new Blob([mp4Data.buffer], { type: 'video/mp4' });
        finalExt = 'mp4';
        
        await ffmpeg.deleteFile('input.webm');
        await ffmpeg.deleteFile('output.mp4');
        ffmpeg.terminate();
      } catch (ffmpegErr) {
        console.warn('ffmpeg.wasm 转换失败，回退到 WebM:', ffmpegErr);
        mp4Failed = true;
        finalBlob = new Blob(chunks, { type: 'video/webm' });
        finalExt = 'webm';
      }
    } else {
      finalBlob = new Blob(chunks, { type: 'video/webm' });
      finalExt = 'webm';
    }
    
    // 下载
    const url = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `对比视频_${layout === 'horizontal' ? '横向' : '竖向'}_${new Date().toISOString().slice(0, 10)}.${finalExt}`;
    a.click();
    URL.revokeObjectURL(url);
    
    if (wantMP4 && mp4Failed) {
      progressEl.textContent = '✅ 导出完成 (WebM 格式，file:// 下无法转 MP4，部署到 GitHub Pages 后可导出 MP4)';
    } else {
      progressEl.textContent = `✅ 导出完成 (${finalExt.toUpperCase()} 格式)`;
    }
    
    exportBtn.disabled = false;
    exportBtn.textContent = '📹 导出视频';
    state.exporting = false;
    
  } catch (err) {
    console.error('导出失败:', err);
    let errMsg = err.message;
    if (err.message.includes('Worker') || err.message.includes('null')) {
      errMsg = '需要通过HTTP服务器访问本页面才能使用MP4导出。\n\n本地运行方法:\n1. 安装 Node.js 后运行: npx serve public\n2. 或 Python: cd public && python -m http.server 8000\n3. 然后访问 http://localhost:8000';
    }
    progressEl.textContent = '导出失败: ' + errMsg;
    exportBtn.disabled = false;
    exportBtn.textContent = '📹 导出视频';
    state.exporting = false;
  }
}

// ===== 偏移调整 =====
function adjustOffset(videoId, delta) {
  state.offsets[videoId] = (state.offsets[videoId] || 0) + delta;
  document.getElementById(`offset-${videoId}`).textContent = state.offsets[videoId].toFixed(3) + 's';
  updateSyncFromSlider();
}

// ===== 工具函数 =====
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function formatTime(seconds) {
  if (seconds < 0 || isNaN(seconds)) return '0:00.0';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds * 10) % 10);
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);
