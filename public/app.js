/**
 * ChronoSync - Asphalt 9 racing video comparison tool
 * OCR + Theil-Sen regression for automatic timer alignment
 */

// ===== 全局状态 =====
const state = {
  videos: [],              // [{id, file, url, name, duration}]
  regions: {},             // {videoId: {x, y, w, h}} 百分比
  frames: {},  // {videoId: [{videoTime, timerValue}]}
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
const MAX_VIDEOS = 4;

function handleFiles(files) {
  const validFiles = Array.from(files).filter(f => f.type.startsWith('video/'));
  
  if (validFiles.length === 0) {
    alert('请选择视频文件');
    return;
  }
  
  if (state.videos.length + validFiles.length > MAX_VIDEOS) {
    alert(`最多只能添加 ${MAX_VIDEOS} 个视频`);
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
  
  // 显示/隐藏头部操作按钮
  document.getElementById('headerActions').style.display = (step >= 2) ? 'flex' : 'none';
  
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
    const left = parseFloat(box.style.left);
    const top = parseFloat(box.style.top);
    const width = parseFloat(box.style.width);
    const height = parseFloat(box.style.height);
    
    if (isNaN(left) || isNaN(top) || isNaN(width) || isNaN(height)) {
      box.classList.remove('active');
      return;
    }
    
    const x = (left / rect.width * 100).toFixed(1);
    const y = (top / rect.height * 100).toFixed(1);
    const w = (width / rect.width * 100).toFixed(1);
    const h = (height / rect.height * 100).toFixed(1);
    
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

// ===== 自动识别计时器区域 =====
// 参考截图分析：
//   黄色背景: x≈80%~95%, y≈13%~18%（橙黄色块，R远大于B）
//   红色背景: x≈82%~96%, y≈13%~18%（粉红色块，R远大于B）
//   注意：顶部中间有橙色氮气条，限制x>72%排除它
// 策略：多帧采样 → 右上角找R>>B色块 → 密度过滤 → 边界框
async function autoDetectRegion(videoId) {
  const video = document.getElementById(`video-${videoId}`);
  const selector = document.getElementById(`selector-${videoId}`);
  const box = document.getElementById(`box-${videoId}`);
  const display = document.getElementById(`display-${videoId}`);
  
  if (!video || !video.videoWidth) return;
  
  display.textContent = '正在自动识别计时器...';
  display.style.color = 'var(--text-muted)';
  updateButtons();
  
  video.pause();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  
  // 调试：存储最后一次采样信息
  let lastDebug = null;
  
  async function sampleFrame(targetTime) {
    if (targetTime < 1) return null;
    video.currentTime = targetTime;
    // 只等 seeked 事件 + 1次 RAF，不 play/pause（节省~1秒/帧）
    await new Promise(resolve => {
      const h = () => { video.removeEventListener('seeked', h); resolve(); };
      video.addEventListener('seeked', h);
      setTimeout(resolve, 2000); // 2秒超时
    });
    if (Math.abs(video.currentTime - targetTime) > 1) { lastDebug = {err:'seek failed', actual: video.currentTime}; return null; }
    await new Promise(r => requestAnimationFrame(r));
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = vw; canvas.height = vh;
    ctx.drawImage(video, 0, 0, vw, vh);
    
    // 快速检查是否黑帧
    const c = ctx.getImageData(Math.floor(vw*0.5), Math.floor(vh*0.5), 1, 1).data;
    const centerAvg = Math.round((c[0]+c[1]+c[2])/3);
    lastDebug = {targetTime, centerAvg, vw, vh};
    if (centerAvg < 10) { lastDebug.err = 'black frame'; return null; }
    return ctx.getImageData(0, 0, vw, vh);
  }
  
  function findTimer(imageData) {
    const data = imageData.data;
    const sx = Math.floor(vw * 0.70);
    const sy = Math.floor(vh * 0.05);
    const ey = Math.floor(vh * 0.25);
    const scanH = ey - sy;
    const scanW = vw - sx;
    
    // 第一步：行直方图 — 每行有多少暖色像素（找横向带）
    const rowHist = new Uint32Array(scanH);
    for (let y = sy; y < ey; y++) {
      for (let x = sx; x < vw; x++) {
        const idx = (y * vw + x) * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        if (r > 120 && (r - b) > 60 && r > g * 0.6) rowHist[y - sy]++;
      }
    }
    
    // 找行直方图的峰值
    let maxRowCount = 0, centerRow = 0;
    for (let i = 0; i < scanH; i++) {
      if (rowHist[i] > maxRowCount) { maxRowCount = rowHist[i]; centerRow = i; }
    }
    if (maxRowCount < 5) { lastDebug = {err:'no warm rows'}; return null; }
    
    // 行方向扩展：取所有>=峰值20%的行
    const rowThresh = maxRowCount * 0.20;
    let top = scanH, bottom = 0;
    for (let i = 0; i < scanH; i++) {
      if (rowHist[i] >= rowThresh) { if (i < top) top = i; if (i > bottom) bottom = i; }
    }
    if (top > bottom) { lastDebug = {err:'no warm rows after thresh'}; return null; }
    
    const minY = sy + top, maxY = sy + bottom;
    const rowH = maxY - minY + 1;
    
    // 第二步：在确定的行范围内，列直方图 — 找宽高比合理的横向矩形
    const colHist = new Uint32Array(scanW);
    for (let y = minY; y <= maxY; y++) {
      for (let x = sx; x < vw; x++) {
        const idx = (y * vw + x) * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        if (r > 120 && (r - b) > 60 && r > g * 0.6) colHist[x - sx]++;
      }
    }
    
    // 列阈值：该列暖色像素 >= 行高25%（排除散点）
    const colThresh = rowH * 0.25;
    
    // 收集所有连续列段
    const segments = [];
    let curRun = 0, curStart = 0;
    for (let i = 0; i < scanW; i++) {
      if (colHist[i] >= colThresh) {
        if (curRun === 0) curStart = i;
        curRun++;
      } else {
        if (curRun > 0) { segments.push({start: curStart, len: curRun}); curRun = 0; }
      }
    }
    if (curRun > 0) segments.push({start: curStart, len: curRun});
    
    // 选暖色像素总量最大的段（矩形块自然得分最高，灯带/散点得分低）
    let bestSeg = null, bestScore = 0;
    for (const seg of segments) {
      // score = 该段列直方图之和（暖色像素总量）
      let sum = 0;
      for (let i = seg.start; i < seg.start + seg.len; i++) sum += colHist[i];
      if (sum > bestScore) { bestScore = sum; bestSeg = seg; }
    }
    
    if (!bestSeg) { lastDebug = {err:'no valid segment', segments: segments.length}; return null; }
    
    const minX = sx + bestSeg.start, maxX = sx + bestSeg.start + bestSeg.len;
    const bW = maxX - minX, bH = maxY - minY;
    
    // 白色文字检查：计时器内有白色数字，灯带没有
    let whiteCount = 0, totalPixels = bW * bH;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const idx = (y * vw + x) * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2];
        // 白色像素：RGB都>200且接近相等
        if (r > 200 && g > 200 && b > 200 && Math.abs(r - g) < 30 && Math.abs(r - b) < 30) {
          whiteCount++;
        }
      }
    }
    const whiteRatio = whiteCount / totalPixels;
    
    
    // 没有白色像素说明不是计时器（是灯带）
    if (whiteCount < 10 || whiteRatio < 0.01) { lastDebug.err = 'no white text'; return null; }
    
    return { minX, maxX, minY, maxY, count: bestScore };
  }
  
  const dur = video.duration;
  // 采样8帧，按位置聚类投票
  const sampleTimes = [];
  for (let i = 0; i < 8; i++) {
    const t = Math.floor(dur * (0.1 + 0.8 * i / 7));
    if (t > 1 && t < dur - 1) sampleTimes.push(t);
  }
  
  const detections = [];
  for (const t of sampleTimes) {
    const imageData = await sampleFrame(t);
    if (!imageData) continue;
    const result = findTimer(imageData);
    if (result) detections.push({...result, seekTime: t});
  }
  
  if (detections.length === 0) {
    const debugStr = lastDebug ? JSON.stringify(lastDebug) : 'no debug';
    display.textContent = `未检测到计时器(${debugStr})`;
    display.style.color = 'var(--warning)';
    updateButtons();
    return;
  }
  
  // 按位置聚类：中心点差距<5%的归为同一类
  const clusters = [];
  for (const d of detections) {
    const cx = (d.minX + d.maxX) / 2 / vw;
    const cy = (d.minY + d.maxY) / 2 / vh;
    let matched = false;
    for (const cl of clusters) {
      if (Math.abs(cx - cl.cx) < 0.05 && Math.abs(cy - cl.cy) < 0.05) {
        cl.items.push(d);
        cl.cx = cl.items.reduce((s, x) => s + (x.minX + x.maxX) / 2 / vw, 0) / cl.items.length;
        cl.cy = cl.items.reduce((s, y) => s + (y.minY + y.maxY) / 2 / vh, 0) / cl.items.length;
        matched = true;
        break;
      }
    }
    if (!matched) clusters.push({cx, cy, items: [d]});
  }
  
  // 选投票最多的簇，取簇内均值
  clusters.sort((a, b) => b.items.length - a.items.length);
  const bestCluster = clusters[0];
  const minX = Math.round(bestCluster.items.reduce((s, x) => s + x.minX, 0) / bestCluster.items.length);
  const maxX = Math.round(bestCluster.items.reduce((s, x) => s + x.maxX, 0) / bestCluster.items.length);
  const minY = Math.round(bestCluster.items.reduce((s, y) => s + y.minY, 0) / bestCluster.items.length);
  const maxY = Math.round(bestCluster.items.reduce((s, y) => s + y.maxY, 0) / bestCluster.items.length);
  const seekTime = bestCluster.items[0].seekTime;
  const count = bestCluster.items.reduce((s, x) => s + x.count, 0);
  
  const tW=maxX-minX, tH=maxY-minY;
  const padX = Math.max(Math.floor(tW*0.15), Math.floor(vw*0.003));
  const padY = Math.max(Math.floor(tH*0.2), Math.floor(vh*0.002));
  const fx=Math.max(0,minX-padX), fy=Math.max(0,minY-padY);
  const fw=Math.min(vw,maxX+padX)-fx, fh=Math.min(vh,maxY+padY)-fy;
  
  // canvas像素坐标 → CSS selector百分比坐标（object-fit:contain映射）
  const SELECTOR_ASPECT = 16/9;
  const videoAspect = vw / vh;
  let scaleX, scaleY, offsetX, offsetY;
  if (videoAspect > SELECTOR_ASPECT) {
    scaleX = 1; scaleY = SELECTOR_ASPECT / videoAspect;
    offsetX = 0; offsetY = (1 - scaleY) / 2;
  } else {
    scaleY = 1; scaleX = videoAspect / SELECTOR_ASPECT;
    offsetX = (1 - scaleX) / 2; offsetY = 0;
  }
  
  // 正确的 object-fit:contain 前向映射：CSS = (offset + pixel/total * scale) * 100
  const xPct = +((offsetX + fx / vw * scaleX) * 100).toFixed(1);
  const yPct = +((offsetY + fy / vh * scaleY) * 100).toFixed(1);
  const wPct = +((fw / vw * scaleX) * 100).toFixed(1);
  const hPct = +((fh / vh * scaleY) * 100).toFixed(1);
  
  state.regions[videoId] = {x:xPct, y:yPct, w:wPct, h:hPct};
  const sr = selector.getBoundingClientRect();
  box.style.left=(sr.width*xPct/100)+'px';
  box.style.top=(sr.height*yPct/100)+'px';
  box.style.width=(sr.width*wPct/100)+'px';
  box.style.height=(sr.height*hPct/100)+'px';
  box.classList.add('active');
  
  display.textContent=`已识别: x=${xPct}% y=${yPct}% w=${wPct}% h=${hPct}% (${count}px @ t=${seekTime}s)`;
  display.style.color='var(--success)';
  updateButtons();
}

// ===== 进度条工具 =====
function setProgress(container, percent, label) {
  container.innerHTML = `
    <div class="progress-container">
      <div class="progress-label">${label}</div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" style="width:${percent}%"></div>
      </div>
    </div>`;
}

// ===== 步骤3: 分析视频 =====
async function analyzeVideos() {
  const container = document.getElementById('analysisResult');
  const compareArea = document.getElementById('comparisonArea');
  compareArea.innerHTML = '';
  
  // 检查所有视频是否都有识别区域
  const missingRegions = state.videos.filter(v => !state.regions[v.id]);
  if (missingRegions.length > 0) {
    container.innerHTML = `<div class="no-match">以下视频未识别到计时器区域，请先手动框选或重新自动识别：${missingRegions.map(v => v.name).join(', ')}</div>`;
    return;
  }
  
  // 计算总帧数
  const totalFrames = state.videos.length * 8; // 每个视频8帧
  let completedFrames = 0;
  
  // 创建固定进度条
  container.innerHTML = `
    <div class="progress-container">
      <div class="progress-label" id="analysisLabel">正在分析... (0/${totalFrames})</div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" id="analysisFill" style="width:5%"></div>
      </div>
    </div>`;
  
  try {
    const fillEl = document.getElementById('analysisFill');
    const labelEl = document.getElementById('analysisLabel');
    
    function onFrameComplete(videoName) {
      completedFrames++;
      const pct = Math.round(5 + (completedFrames / totalFrames) * 85);
      if (fillEl) fillEl.style.width = pct + '%';
      if (labelEl) labelEl.textContent = `正在分析... (${completedFrames}/${totalFrames})`;
    }
    
    // 并行处理所有视频OCR，每帧回调更新进度
    await Promise.all(state.videos.map(v => extractFrames(v.id, onFrameComplete)));
    
    if (fillEl) fillEl.style.width = '95%';
    if (labelEl) labelEl.textContent = '正在计算偏移...';
    
    await calculateBestOffset();
    if (fillEl) fillEl.style.width = '100%';
    
    // 构建各视频偏移显示
    const offsetSummary = state.videos.filter(v => state.frames[v.id] && state.frames[v.id].length >= 2)
      .map((v, i) => {
        const offset = state.offsets[v.id] || 0;
        return i === 0 ? `${v.name.replace(/\.[^.]+$/, '')}: 基准` : `${v.name.replace(/\.[^.]+$/, '')}: +${offset.toFixed(3)}s`;
      }).join(' | ');
    container.innerHTML = `<div class="done">分析完成！${offsetSummary}</div>`;
    
    initSync();
  } catch (err) {
    console.error('分析失败:', err);
    container.innerHTML = `<div class="no-match">分析失败: ${err.message}</div>`;
  }
}

// ===== 步骤3: 同步对比 =====
function initSync() {
  const container = document.getElementById('comparisonArea');
  
  if (state.videos.length < 2) {
    container.innerHTML = '<div class="no-match">没有足够的数据</div>';
    return;
  }
  
  // 使用所有视频，不再过滤
  const allVideos = state.videos;
  
  let maxTime = -Infinity;
  for (const v of allVideos) {
    if (v.duration > maxTime) maxTime = v.duration;
  }
  
  // 构建每个视频的偏移显示信息
  const offsetInfo = allVideos.map((v, i) => {
    const offset = state.offsets[v.id] || 0;
    const hasOCR = state.frames[v.id] && state.frames[v.id].length > 0;
    const label = i === 0 ? '基准' : `+${offset.toFixed(3)}s`;
    const ocrBadge = hasOCR ? '' : ' ⚠️未识别';
    return `<span class="offset-tag ${i === 0 ? 'base' : ''}">${v.name.replace(/\.[^.]+$/, '')}: ${label}${ocrBadge}</span>`;
  }).join(' ');
  
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
      <div class="offset-display">${offsetInfo}</div>
    </div>
    
    <div class="sync-videos">
      ${allVideos.map((v, i) => `
        <div class="sync-video">
          <h3>${v.name}</h3>
          <video id="syncvideo-${v.id}" muted playsinline></video>
          <div class="video-offset-controls">
            <span class="offset-label">偏移: <span id="offset-${v.id}">${(state.offsets[v.id] || 0).toFixed(3)}s</span></span>
            <div class="offset-buttons">
              <button onclick="adjustOffset('${v.id}', -1)">-1s</button>
              <button onclick="adjustOffset('${v.id}', -0.1)">-0.1s</button>
              <button onclick="adjustOffset('${v.id}', -0.01)">-0.01s</button>
              <button onclick="adjustOffset('${v.id}', -0.001)">-0.001s</button>
              <button onclick="adjustOffset('${v.id}', 0.001)">+0.001s</button>
              <button onclick="adjustOffset('${v.id}', 0.01)">+0.01s</button>
              <button onclick="adjustOffset('${v.id}', 0.1)">+0.1s</button>
              <button onclick="adjustOffset('${v.id}', 1)">+1s</button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
    
    <div class="export-section">
      <h3>导出设置</h3>
      
      <div class="export-layout-grid" id="exportLayoutGrid">
        ${generateLayoutThumbnails(allVideos.length)}
      </div>
      
      <div class="export-sliders">
        <div class="slider-row">
          <label>分辨率</label>
          <input type="range" id="exportRes" min="0" max="4" step="1" value="2">
          <span class="slider-val" id="exportResVal">1080p</span>
        </div>
        <div class="slider-row">
          <label>帧率</label>
          <input type="range" id="exportFps" min="0" max="4" step="1" value="1">
          <span class="slider-val" id="exportFpsVal">30fps</span>
        </div>
        <div class="slider-row">
          <label>码率</label>
          <div class="bitrate-btns" id="bitrateBtns">
            <button class="bitrate-btn" data-val="low">较低</button>
            <button class="bitrate-btn active" data-val="normal">正常</button>
            <button class="bitrate-btn" data-val="high">较高</button>
          </div>
        </div>
        <div class="slider-row">
          <label>格式</label>
          <select id="exportFormat">
            <option value="mp4">MP4 (H.264)</option>
            <option value="webm">WebM (VP9)</option>
          </select>
        </div>
      </div>
      
      <button id="exportBtn" onclick="exportVideo()">📹 导出视频</button>
      
      <div class="export-order">
        <label>视频顺序（拖拽调整）:</label>
        <div id="exportOrderList" class="export-order-list">
          ${allVideos.map((v, i) => `
            <div class="export-order-item" draggable="true" data-idx="${i}">
              <span class="drag-handle">⣿</span>
              <span class="order-name">${v.name}</span>
              <span class="order-num">#${i + 1}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div id="exportProgress" class="export-progress" style="display:none;"></div>
    </div>
  `;
  
  // 导出滑块配置
  const RESOPTIONS = [480, 720, 1080, 1440, 2160];
  const FPSOPTIONS = [25, 30, 60, 90, 120];
  const BITRATEMULTI = { low: 0.5, normal: 1, high: 2 };
  
  const resSlider = document.getElementById('exportRes');
  const fpsSlider = document.getElementById('exportFps');
  const resVal = document.getElementById('exportResVal');
  const fpsVal = document.getElementById('exportFpsVal');
  
  resSlider.addEventListener('input', () => {
    resVal.textContent = RESOPTIONS[resSlider.value] + 'p';
  });
  fpsSlider.addEventListener('input', () => {
    fpsVal.textContent = FPSOPTIONS[fpsSlider.value] + 'fps';
  });
  
  // 码率按钮
  document.querySelectorAll('.bitrate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bitrate-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  
  // 默认选中值
  resSlider.value = 2; resVal.textContent = '1080p';
  fpsSlider.value = 1; fpsVal.textContent = '30fps';
  
    const loadPromises = allVideos.map((v, idx) => {
      return new Promise(resolve => {
        const video = document.getElementById(`syncvideo-${v.id}`);
        if (!video) { resolve(); return; }
        video.src = v.url;
        video.preload = 'auto';
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        video.onloadeddata = done;
        video.onerror = () => { console.warn('视频加载失败:', v.name); done(); };
        setTimeout(done, 15000);
        try { video.load(); } catch(e) { console.warn('video.load() 异常:', e); done(); }
      });
    });
  
  Promise.all(loadPromises).then(() => {
    // 全部加载完毕后再设置初始时间
    updateSyncFromSlider();
    initDragAndDrop();
    // 延迟0.5秒再seek一次，确保所有视频都渲染了第一帧
    setTimeout(() => updateSyncFromSlider(), 500);
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
  
  // 同步所有视频
  state.videos.forEach((v, i) => {
    const video = document.getElementById(`syncvideo-${v.id}`);
    if (!video) return;
    const offset = state.offsets[v.id] || 0;
    video.currentTime = Math.max(0, time + (i === 0 ? 0 : offset));
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
  
  // 先设置所有视频到正确位置，然后等seek完成再播放
  const seekPromises = state.videos.map(v => {
    return new Promise(resolve => {
      const video = document.getElementById(`syncvideo-${v.id}`);
      if (!video) { resolve(); return; }
      const offset = state.offsets[v.id] || 0;
      const targetTime = parseFloat(slider.value) + offset;
      const clampedTime = Math.max(0, Math.min(targetTime, video.duration || 0));
      
      // 如果已经在目标位置附近，直接resolve
      if (Math.abs(video.currentTime - clampedTime) < 0.1) {
        resolve();
        return;
      }
      
      // 设置目标位置并等待seek完成
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = clampedTime;
      
      // 3秒超时防卡死
      setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        resolve();
      }, 3000);
    });
  });
  
  Promise.all(seekPromises).then(() => {
    // 所有视频seek到位后统一播放
    const baseOffset = state.offsets[state.videos[0].id] || 0;
    state.videos.forEach((v, i) => {
      const video = document.getElementById(`syncvideo-${v.id}`);
      if (!video) return;
      const offset = state.offsets[v.id] || 0;
      const startDelay = offset - baseOffset; // 相对基准的延迟
      
      if (startDelay < 0) {
        // 负偏移：视频还没到该出现的时间，暂停等syncLoop唤醒
        video.currentTime = 0;
        video.pause();
      } else {
        video.playbackRate = 1.0;
        video.play().catch(() => {});
      }
    });
    
    const baseVideo = document.getElementById(`syncvideo-${state.videos[0].id}`);
    let lastDisplayTime = -1;
    let lastSyncTime = -1;
    
    function syncLoop(timestamp) {
      if (!state.isPlaying) return;
      
      if (baseVideo && !baseVideo.paused) {
        const baseTime = baseVideo.currentTime;
        
        // 更新UI显示（每0.5秒）
        if (Math.abs(baseTime - lastDisplayTime) >= 0.5) {
          lastDisplayTime = baseTime;
          slider.value = baseTime;
          document.getElementById('timeDisplay').textContent = baseTime.toFixed(1) + 's';
        }
        
        // 同步其他视频（每0.3秒检查一次）
        if (Math.abs(baseTime - lastSyncTime) >= 0.3) {
          lastSyncTime = baseTime;
          state.videos.forEach((v, i) => {
            if (i === 0) return;
            const video = document.getElementById(`syncvideo-${v.id}`);
            if (!video) return;
            const offset = state.offsets[v.id] || 0;
            const targetTime = baseTime + offset;
            
            // 负偏移：视频还没到该出现的时间，暂停并归零
            if (targetTime < 0) {
              if (!video.paused) {
                video.pause();
                video.currentTime = 0;
                video.playbackRate = 1.0;
              }
              return;
            }
            
            // 正偏移：如果之前被暂停了，恢复播放
            if (video.paused) {
              video.currentTime = targetTime;
              video.playbackRate = 1.0;
              video.play().catch(() => {});
              return;
            }
            
            const drift = video.currentTime - targetTime;
            const absDrift = Math.abs(drift);
            
            if (absDrift > 2.0) {
              // 大偏差：直接seek
              video.currentTime = targetTime;
              video.playbackRate = 1.0;
            } else if (absDrift > 0.15) {
              // 中等偏差：用playbackRate微调（±5%），平滑无卡顿
              const correction = Math.max(-0.05, Math.min(0.05, -drift * 0.3));
              video.playbackRate = 1.0 + correction;
            } else {
              // 偏差很小：恢复正常速率
              video.playbackRate = 1.0;
            }
          });
        }
        
        if (baseTime >= maxTime) {
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

// ===== 导出视频（v74: ffmpeg.wasm 单线程编码，本地文件）=====
const FFMPEG_LOCAL = '/ffmpeg';

// toBlobURL: fetch→blob→URL，绕过CORS（替代@ffmpeg/util的同名函数）
async function toBlobURL(url, mimeType) {
  const resp = await fetch(url);
  const buf = await resp.arrayBuffer();
  const blob = new Blob([buf], { type: mimeType });
  return URL.createObjectURL(blob);
}

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
    const orderedVideos = getExportVideoOrder();
    const validVideos = orderedVideos.filter(v => state.frames[v.id] && state.frames[v.id].length > 0);
    if (validVideos.length < 2) throw new Error('视频不足');

    const layout = state.selectedLayout || 'vertical';

    // 读取滑块配置
    const RESOPTIONS = [480, 720, 1080, 1440, 2160];
    const FPSOPTIONS = [25, 30, 60, 90, 120];
    const BITRATEMULTI = { low: 0.5, normal: 1, high: 2 };
    const targetRes = RESOPTIONS[document.getElementById('exportRes').value];
    const targetFps = FPSOPTIONS[document.getElementById('exportFps').value];
    const bitrateKey = document.querySelector('.bitrate-btn.active')?.dataset.val || 'normal';
    const bitrateMulti = BITRATEMULTI[bitrateKey];

    // 根据目标分辨率计算缩放比例（基于源视频高度）
    const baseVideoEl = document.getElementById(`syncvideo-${validVideos[0].id}`);
    if (!baseVideoEl || !baseVideoEl.videoWidth) throw new Error('同步视频未加载');
    const rawW = baseVideoEl.videoWidth;
    const rawH = baseVideoEl.videoHeight;
    const scale = Math.min(targetRes / rawH, 1.0);
    const vw = Math.round(rawW * scale);
    const vh = Math.round(rawH * scale);

    // 码率
    const baseBitrate = 8_000_000;
    const bitrate = Math.round(baseBitrate * (vh / 1080) * (targetFps / 30) * bitrateMulti);
    const fps = targetFps;

    const baseOffset = state.offsets[validVideos[0].id] || 0;
    const exportStartTime = Math.max(0, -baseOffset);
    let maxEndTime = 0;
    validVideos.forEach(v => {
      const offset = state.offsets[v.id] || 0;
      const ve = v.duration - offset;
      if (ve > maxEndTime) maxEndTime = ve;
    });
    const totalDuration = maxEndTime - exportStartTime;
    const totalFrames = Math.ceil(totalDuration * fps);
    const frameInterval = 1 / fps;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (layout === 'horizontal') {
      canvas.width = vw * validVideos.length; canvas.height = vh;
    } else if ((layout === 'top1-bottom2' || layout === 'top2-bottom1') && validVideos.length === 3) {
      canvas.width = vw * 2; canvas.height = vh * 2;
    } else if (layout === 'grid-4' && validVideos.length === 4) {
      canvas.width = vw * 2; canvas.height = vh * 2;
    } else {
      canvas.width = vw; canvas.height = vh * validVideos.length;
    }

    const totalPixels = canvas.width * canvas.height;
    if (totalPixels > 8_000_000) {
      throw new Error(`画布太大 (${canvas.width}x${canvas.height} = ${(totalPixels/1000000).toFixed(1)}MP)，请降低分辨率`);
    }

    progressEl.textContent = `画布: ${canvas.width}x${canvas.height} @ ${fps}fps, 加载ffmpeg...`;

    // ===== 加载 ffmpeg.wasm（多线程）=====
    const { FFmpeg } = FFmpegWASM;
    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      if (message.includes('frame=')) progressEl.textContent = `编码: ${message}`;
    });

    await ffmpeg.load({
      coreURL: await toBlobURL(`${FFMPEG_LOCAL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${FFMPEG_LOCAL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    progressEl.textContent = '加载视频...';

    // ===== 并行加载所有视频 =====
    const exportVideos = await Promise.all(validVideos.map(async (v) => {
      const vid = document.createElement('video');
      vid.src = v.url; vid.muted = true; vid.preload = 'auto';
      await new Promise((resolve, reject) => {
        vid.addEventListener('loadeddata', resolve);
        vid.addEventListener('error', () => reject(new Error(`视频加载失败: ${v.name}`)));
        vid.load();
      });
      vid.currentTime = Math.max(0.01, exportStartTime + (state.offsets[v.id] || 0));
      await new Promise(resolve => { vid.addEventListener('seeked', resolve, { once: true }); setTimeout(resolve, 2000); });
      return vid;
    }));

    const renderStart = performance.now();

    // 绘制单帧到canvas
    function drawFrame() {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (layout === 'horizontal') {
        validVideos.forEach((v, i) => ctx.drawImage(exportVideos[i], i * vw, 0, vw, vh));
      } else if (layout === 'top1-bottom2' && validVideos.length === 3) {
        ctx.drawImage(exportVideos[0], vw * 0.5, 0, vw, vh);
        ctx.drawImage(exportVideos[1], 0, vh, vw, vh);
        ctx.drawImage(exportVideos[2], vw, vh, vw, vh);
      } else if (layout === 'top2-bottom1' && validVideos.length === 3) {
        ctx.drawImage(exportVideos[0], 0, 0, vw, vh);
        ctx.drawImage(exportVideos[1], vw, 0, vw, vh);
        ctx.drawImage(exportVideos[2], vw * 0.5, vh, vw, vh);
      } else if (layout === 'grid-4' && validVideos.length === 4) {
        validVideos.forEach((v, i) => ctx.drawImage(exportVideos[i], (i % 2) * vw, Math.floor(i / 2) * vh, vw, vh));
      } else {
        validVideos.forEach((v, i) => ctx.drawImage(exportVideos[i], 0, i * vh, vw, vh));
      }
    }

    // Seek所有视频
    function seekAll(time) {
      const ps = validVideos.map((v, i) => {
        const vid = exportVideos[i];
        const offset = state.offsets[v.id] || 0;
        const target = Math.max(0.01, Math.min(v.duration - 0.01, time + offset));
        if (Math.abs(vid.currentTime - target) < frameInterval * 0.5) return Promise.resolve();
        return new Promise(resolve => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          vid.addEventListener('seeked', finish, { once: true });
          vid.currentTime = target;
          setTimeout(finish, 800);
        });
      });
      return Promise.all(ps);
    }

    function updateProgress(frameIdx, tag) {
      if (frameIdx % Math.max(1, Math.floor(fps * 2)) === 0 || frameIdx === totalFrames - 1) {
        const elapsed = (performance.now() - renderStart) / 1000;
        const speed = frameIdx / Math.max(0.1, elapsed);
        const remaining = (totalFrames - frameIdx) / Math.max(0.1, speed);
        const pct = Math.round((frameIdx / totalFrames) * 100);
        return `${tag} ${pct}% | 帧${frameIdx}/${totalFrames} | ~${speed.toFixed(1)}帧/s | 剩余~${remaining.toFixed(0)}s`;
      }
      return null;
    }

    // ===== 抽帧：批量提取为 JPEG =====
    progressEl.textContent = `抽帧 ${totalFrames} 帧...`;
    const BATCH = 32; // 每批处理帧数
    const frameFiles = [];

    for (let batch = 0; batch < totalFrames; batch += BATCH) {
      if (!state.exporting) break;
      const end = Math.min(batch + BATCH, totalFrames);

      for (let fi = batch; fi < end; fi++) {
        if (!state.exporting) break;
        await seekAll(exportStartTime + fi * frameInterval);
        drawFrame();

        // canvas → JPEG blob
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
        const buf = new Uint8Array(await blob.arrayBuffer());
        const fname = `frame${String(fi).padStart(5, '0')}.jpg`;
        await ffmpeg.writeFile(fname, buf);
        frameFiles.push(fname);
      }

      const pg = updateProgress(end, '抽帧:');
      if (pg) progressEl.textContent = pg;
      if (end % (BATCH * 4) === 0) await new Promise(r => setTimeout(r, 0));
    }

    if (frameFiles.length === 0) throw new Error('未提取到帧');

    // ===== ffmpeg 编码 MP4 =====
    progressEl.textContent = `ffmpeg编码 ${frameFiles.length} 帧 (${fps}fps)...`;
    const kbps = Math.round(bitrate / 1000);

    await ffmpeg.exec([
      '-framerate', String(fps),
      '-i', 'frame%05d.jpg',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',    // 最快编码速度
      '-crf', '18',              // 高质量
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      'output.mp4'
    ]);

    // ===== 读取输出并下载 =====
    const outputData = await ffmpeg.readFile('output.mp4');
    const mp4Blob = new Blob([outputData.buffer], { type: 'video/mp4' });
    downloadBlob(mp4Blob, 'mp4', layout);

    const elapsed = ((performance.now() - renderStart) / 1000).toFixed(0);
    progressEl.textContent = `✅ 导出完成 (${(mp4Blob.size / 1024 / 1024).toFixed(1)}MB MP4, ${canvas.width}x${canvas.height}, ${fps}fps, ${elapsed}s)`;

    // 清理
    exportVideos.forEach(v => { v.src = ''; v.load(); });
    exportBtn.disabled = false;
    exportBtn.textContent = '📹 导出视频';
    state.exporting = false;

  } catch (err) {
    console.error('导出失败:', err);
    progressEl.textContent = '导出失败: ' + err.message;
    exportBtn.disabled = false;
    exportBtn.textContent = '📹 导出视频';
    state.exporting = false;
  }
}

function downloadBlob(blob, ext, layout) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const layoutName = { horizontal: '横向', vertical: '竖向', 'top1-bottom2': '上1下2', 'top2-bottom1': '上2下1' }[layout] || layout;
  a.download = `对比视频_${layoutName}_${new Date().toISOString().slice(0, 10)}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== 全部视频一键自动识别 =====
async function autoDetectAll() {
  // 先设置所有视频的状态为"识别中"
  state.videos.forEach(v => {
    const display = document.getElementById(`display-${v.id}`);
    if (display) {
      display.textContent = '正在自动识别计时器...';
      display.style.color = 'var(--text-muted)';
    }
  });
  updateButtons();
  
  // 并行识别所有视频
  await Promise.all(state.videos.map(v => autoDetectRegion(v.id)));
}

// ===== 重新选择视频（回到步骤1）=====
function reselectVideos() {
  if (state.isPlaying) pauseSyncPlay();
  // 清理旧数据
  state.videos.forEach(v => {
    URL.revokeObjectURL(v.url);
    delete state.regions[v.id];
    delete state.frames[v.id];
    delete state.offsets[v.id];
  });
  state.videos = [];
  state.bestOffset = 0;
  state.exportOrder = [];
  document.getElementById('comparisonArea').innerHTML = '';
  document.getElementById('analysisResult').innerHTML = '';
  document.getElementById('videoList').innerHTML = '';
  document.getElementById('nextBtn1').disabled = true;
  document.getElementById('headerActions').style.display = 'none';
  goToStep(1);
}

// ===== 拖拽排序 =====
function initDragAndDrop() {
  const list = document.getElementById('exportOrderList');
  if (!list) return;
  
  let draggedEl = null;
  let overEl = null;
  
  list.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.export-order-item');
    if (!item) return;
    draggedEl = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => item.classList.add('dragging'), 0);
  });
  
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const items = Array.from(list.querySelectorAll('.export-order-item'));
    let newOverEl = null;
    for (const item of items) {
      if (item === draggedEl) continue;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        newOverEl = item;
        break;
      }
    }
    if (!newOverEl) newOverEl = items.find(i => i !== draggedEl) || null;
    
    if (newOverEl !== overEl) {
      items.forEach(el => el.classList.remove('drag-over'));
      if (newOverEl) newOverEl.classList.add('drag-over');
      overEl = newOverEl;
    }
  });
  
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) {
      list.querySelectorAll('.export-order-item').forEach(el => el.classList.remove('drag-over'));
      overEl = null;
    }
  });
  
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedEl || !overEl || draggedEl === overEl) {
      cleanup();
      return;
    }
    
    // 直接用 DOM 操作确定顺序，再同步到 state
    const items = Array.from(list.querySelectorAll('.export-order-item'));
    const fromIdx = items.indexOf(draggedEl);
    const toIdx = items.indexOf(overEl);
    
    if (fromIdx < 0 || toIdx < 0) {
      cleanup();
      return;
    }
    
    // 重新排列state.videos
    const [moved] = state.videos.splice(fromIdx, 1);
    state.videos.splice(toIdx, 0, moved);
    
    // 重新渲染列表
    list.innerHTML = state.videos.map((v, i) => `
      <div class="export-order-item" draggable="true" data-idx="${i}">
        <span class="drag-handle">⣿</span>
        <span class="order-name">${v.name}</span>
        <span class="order-num">#${i + 1}</span>
      </div>
    `).join('');
    
    // 给目标位置的项加闪烁动画
    const newItems = list.querySelectorAll('.export-order-item');
    if (newItems[toIdx]) {
      newItems[toIdx].classList.add('just-swapped');
      setTimeout(() => newItems[toIdx]?.classList.remove('just-swapped'), 400);
    }
    
    cleanup();
  });
  
  function cleanup() {
    list.querySelectorAll('.export-order-item').forEach(el => {
      el.classList.remove('dragging', 'drag-over');
    });
    draggedEl = null;
    overEl = null;
  }
  
  list.addEventListener('dragend', cleanup);
}

// ===== 获取导出视频顺序 =====
function getExportVideoOrder() {
  const items = document.querySelectorAll('#exportOrderList .export-order-item');
  if (items.length === 0) return state.videos;
  const ids = Array.from(items).map(el => parseInt(el.dataset.idx));
  return ids.map(i => state.videos[i]);
}

// ===== 生成布局缩略图 =====
function generateLayoutThumbnails(count) {
  const layouts = [];
  
  // 竖向排列（所有数量都有）
  layouts.push({ id: 'vertical', label: '竖向', svg: generateLayoutSVG(count, 'vertical') });
  
  // 横向排列（2+个视频）
  if (count >= 2) {
    layouts.push({ id: 'horizontal', label: '横向', svg: generateLayoutSVG(count, 'horizontal') });
  }
  
  // 上1下2 / 上2下1（3个视频）
  if (count === 3) {
    layouts.push({ id: 'top1-bottom2', label: '上1下2', svg: generateLayoutSVG(3, 'top1-bottom2') });
    layouts.push({ id: 'top2-bottom1', label: '上2下1', svg: generateLayoutSVG(3, 'top2-bottom1') });
  }
  
  // 2x2网格（4个视频）
  if (count === 4) {
    layouts.push({ id: 'grid-4', label: '2x2网格', svg: generateLayoutSVG(4, 'grid-4') });
  }
  
  return layouts.map((l, i) => `
    <div class="layout-thumb ${i === 0 ? 'selected' : ''}" data-layout="${l.id}" onclick="selectLayout('${l.id}')">
      <div class="layout-svg">${l.svg}</div>
      <span class="layout-label">${l.label}</span>
    </div>
  `).join('');
}

// ===== 生成布局SVG =====
function generateLayoutSVG(count, layout) {
  const w = 60, h = 40;
  const gap = 2;
  let rects = '';
  
  if (layout === 'vertical') {
    const slotH = (h - gap * (count - 1)) / count;
    for (let i = 0; i < count; i++) {
      const y = i * (slotH + gap);
      rects += `<rect x="2" y="${y}" width="${w - 4}" height="${slotH}" rx="2" fill="#${['ff6b35','4a9eff','2eaa6f','e74c3c'][i]}" opacity="0.8"/>`;
      rects += `<text x="${w/2}" y="${y + slotH/2 + 3}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">${i + 1}</text>`;
    }
  } else if (layout === 'horizontal') {
    const slotW = (w - gap * (count - 1)) / count;
    for (let i = 0; i < count; i++) {
      const x = i * (slotW + gap);
      rects += `<rect x="${x}" y="2" width="${slotW}" height="${h - 4}" rx="2" fill="#${['ff6b35','4a9eff','2eaa6f','e74c3c'][i]}" opacity="0.8"/>`;
      rects += `<text x="${x + slotW/2}" y="${h/2 + 3}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">${i + 1}</text>`;
    }
  } else if (layout === 'top1-bottom2') {
    const slotW = (w - gap) / 2;
    const topSlotH = (h - gap) / 2;
    const botSlotH = topSlotH;
    // 上面1个居中
    rects += `<rect x="${(w - slotW) / 2}" y="2" width="${slotW}" height="${topSlotH}" rx="2" fill="#ff6b35" opacity="0.8"/>`;
    rects += `<text x="${w/2}" y="${topSlotH/2 + 5}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">1</text>`;
    // 下面2个
    rects += `<rect x="2" y="${topSlotH + gap}" width="${slotW}" height="${botSlotH}" rx="2" fill="#4a9eff" opacity="0.8"/>`;
    rects += `<text x="${slotW/2 + 2}" y="${topSlotH + gap + botSlotH/2 + 3}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">2</text>`;
    rects += `<rect x="${slotW + gap + 2}" y="${topSlotH + gap}" width="${slotW}" height="${botSlotH}" rx="2" fill="#2eaa6f" opacity="0.8"/>`;
    rects += `<text x="${slotW + gap + 2 + slotW/2}" y="${topSlotH + gap + botSlotH/2 + 3}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">3</text>`;
  } else if (layout === 'top2-bottom1') {
    const slotW = (w - gap) / 2;
    const halfH = (h - gap) / 2;
    // 上面2个
    rects += `<rect x="2" y="2" width="${slotW}" height="${halfH}" rx="2" fill="#ff6b35" opacity="0.8"/>`;
    rects += `<text x="${slotW/2 + 2}" y="${halfH/2 + 5}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">1</text>`;
    rects += `<rect x="${slotW + gap + 2}" y="2" width="${slotW}" height="${halfH}" rx="2" fill="#4a9eff" opacity="0.8"/>`;
    rects += `<text x="${slotW + gap + 2 + slotW/2}" y="${halfH/2 + 5}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">2</text>`;
    // 下面1个居中
    rects += `<rect x="${(w - slotW) / 2}" y="${halfH + gap}" width="${slotW}" height="${halfH}" rx="2" fill="#2eaa6f" opacity="0.8"/>`;
    rects += `<text x="${w/2}" y="${halfH + gap + halfH/2 + 3}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">3</text>`;
  } else if (layout === 'grid-4') {
    const slotW = (w - gap) / 2;
    const slotH = (h - gap) / 2;
    const colors = ['#ff6b35', '#4a9eff', '#2eaa6f', '#e74c3c'];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const i = r * 2 + c;
        const x = c * (slotW + gap) + 2;
        const y = r * (slotH + gap) + 2;
        rects += `<rect x="${x}" y="${y}" width="${slotW}" height="${slotH}" rx="2" fill="${colors[i]}" opacity="0.8"/>`;
        rects += `<text x="${x + slotW/2}" y="${y + slotH/2 + 3}" text-anchor="middle" fill="#fff" font-size="7" font-weight="bold">${i + 1}</text>`;
      }
    }
  }
  
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

// ===== 选择布局 =====
function selectLayout(layoutId) {
  document.querySelectorAll('.layout-thumb').forEach(el => el.classList.remove('selected'));
  document.querySelector(`.layout-thumb[data-layout="${layoutId}"]`).classList.add('selected');
  // 存到一个隐藏input或者直接存在state里
  state.selectedLayout = layoutId;
}

// ===== 重新计算（保留视频和区域，重新OCR分析）=====
async function recalculate() {
  if (state.isPlaying) pauseSyncPlay();
  // 清除旧的帧数据和偏移
  state.videos.forEach(v => {
    delete state.frames[v.id];
    state.offsets[v.id] = 0;
  });
  state.bestOffset = 0;
  state.selectedLayout = 'vertical';
  document.getElementById('comparisonArea').innerHTML = '';
  goToStep(3);
}

// ===== 偏移调整 =====
function adjustOffset(videoId, delta) {
  state.offsets[videoId] = (state.offsets[videoId] || 0) + delta;
  document.getElementById(`offset-${videoId}`).textContent = state.offsets[videoId].toFixed(3) + 's';
  updateSyncFromSlider();
}

// ===== OCR + Theil-Sen 回归对齐算法 =====

// 从OCR文本解析计时器值（秒）
// 格式: MM:SS.mmm（A9计时器最多04分钟）
// 闹钟图标误读修正: "300:51.941" → 00:51.941, "301:01.941" → 01:01.941
function parseTimerText(text) {
  const cleaned = text.replace(/[^0-9:.,]/g, '').trim();
  
  // 匹配 XX:XX.XXX 格式
  const match = cleaned.match(/(\d+):(\d{1,2})(?:[.,](\d+))?/);
  if (match) {
    let mins = parseInt(match[1]);
    const secs = parseInt(match[2]);
    const ms = match[3] ? parseFloat('0.' + match[3]) : 0;
    
    // 闹钟图标误读: "300"→00, "301"→01 — 去掉百位/十位的干扰数字
    if (mins > 4) mins = mins % 100;
    
    if (mins <= 4 && secs < 60) return mins * 60 + secs + ms;
  }
  
  return null;
}

// ===== Tesseract Worker（参考FrameSync：创建一次，复用）=====
const OCR = {
  worker: null,
  ready: false,
};

async function ocrInit() {
  if (OCR.ready) return true;
  try {
    if (typeof Tesseract === 'undefined') {
      console.warn('[OCR] Tesseract.js 未加载');
      return false;
    }
    OCR.worker = await Tesseract.createWorker('eng', 1, {
      logger: () => {}
    });
    await OCR.worker.setParameters({
      tessedit_char_whitelist: '0123456789.:',  // 数字+小数点+冒号
      tessedit_pageseg_mode: '8',  // PSM_SINGLE_WORD — 适合 MM:SS.mmm 格式
    });
    OCR.ready = true;
    return true;
  } catch (e) {
    console.error('[OCR] 初始化失败:', e);
    return false;
  }
}

// ===== OCR读取单帧计时器值（参考FrameSync：640x144 裸 canvas，不做预处理）=====
async function readTimerValue(video, region) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  
  // 计算 object-fit: contain 在 16:9 selector 中的实际映射
  const SELECTOR_ASPECT = 16/9;
  const videoAspect = vw / vh;
  
  let scaleX, scaleY, offsetX, offsetY;
  if (videoAspect > SELECTOR_ASPECT) {
    scaleX = 1;
    scaleY = SELECTOR_ASPECT / videoAspect;
    offsetX = 0;
    offsetY = (1 - scaleY) / 2;
  } else {
    scaleY = 1;
    scaleX = videoAspect / SELECTOR_ASPECT;
    offsetX = (1 - scaleX) / 2;
    offsetY = 0;
  }
  
  // 将 selector 百分比坐标映射到视频实际像素坐标
  const videoX = (region.x / 100 - offsetX) / scaleX * vw;
  const videoY = (region.y / 100 - offsetY) / scaleY * vh;
  const videoW = (region.w / 100) / scaleX * vw;
  const videoH = (region.h / 100) / scaleY * vh;
  
  const rx = Math.max(0, Math.min(videoX, vw));
  const ry = Math.max(0, Math.min(videoY, vh));
  const rw = Math.max(1, Math.min(videoW, vw - rx));
  const rh = Math.max(1, Math.min(videoH, vh - ry));
  
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 144;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, rx, ry, rw, rh, 0, 0, 640, 144);
  
  try {
    const { data } = await OCR.worker.recognize(canvas);
    // 清理canvas
    canvas.width = 0; canvas.height = 0;
    const text = (data.text || '').trim();
    const value = parseTimerText(text);
    return { text, value, confidence: data.confidence };
  } catch (e) {
    console.error('[OCR Error]', e);
    return { text: '', value: null, confidence: 0 };
  }
}

// Theil-Sen 稳健回归（参考FrameSync：videoTime = slope × timerValue + intercept）
// 注意：回归方向是从计时器值 → 视频时间，不是反向
// 用于给定计时器值 T，计算对应视频时间：videoTime = slope * T + intercept
function theilSenRegression(points) {
  if (points.length < 2) return null;
  
  // 计算所有点对的斜率：ΔvideoTime / ΔtimerValue
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dt = points[j].timerValue - points[i].timerValue;
      if (Math.abs(dt) > 0.001) { // 避免除零
        const dv = points[j].videoTime - points[i].videoTime;
        slopes.push(dv / dt);
      }
    }
  }
  
  if (slopes.length === 0) return null;
  
  // 取中位数斜率
  slopes.sort((a, b) => a - b);
  const medianSlope = slopes[Math.floor(slopes.length / 2)];
  
  // 截距中位数：intercept = videoTime - slope × timerValue
  const intercepts = points.map(p => p.videoTime - medianSlope * p.timerValue);
  intercepts.sort((a, b) => a - b);
  const medianIntercept = intercepts[Math.floor(intercepts.length / 2)];
  
  return { slope: medianSlope, intercept: medianIntercept };
}

// ===== 核心算法：提取帧并OCR读取计时器（完全参考FrameSync）=====
async function extractFrames(videoId, onFrameDone) {
  const v = state.videos.find(v => v.id === videoId);
  const region = state.regions[videoId];
  
  if (!v || !region) {
    console.warn('[extractFrames] Skipping', v?.name || videoId, '- region:', region);
    return;
  }
  
  // 参考FrameSync：先初始化OCR Worker
  const ok = await ocrInit();
  if (!ok) {
    console.error('[extractFrames] OCR初始化失败');
    return;
  }
  
  const video = document.createElement('video');
  video.src = v.url;
  video.muted = true;
  video.preload = 'auto';
  
  // 带超时的 metadata 加载
  await Promise.race([
    new Promise(resolve => {
      video.addEventListener('loadedmetadata', resolve);
      video.load();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('视频加载超时')), 30000))
  ]);
  
  v.duration = video.duration;
  
  const duration = video.duration;
  const usableStart = duration * 0.05;
  const usableEnd = duration * 0.95;
  
  const MIN_CALIB_POINTS = 3;      // 每个视频至少需要的校准点
  const MAX_SAMPLES = 30;          // 最大采样次数（防止无限循环）
  const calibPoints = [];
  const usedTimes = new Set();
  
  const container = document.getElementById('analysisResult');
  
  for (let i = 0; i < MAX_SAMPLES && calibPoints.length < MIN_CALIB_POINTS; i++) {
    // 随机采样
    let time;
    for (let attempt = 0; attempt < 200; attempt++) {
      const t = usableStart + Math.random() * (usableEnd - usableStart);
      const key = Math.round(t * 1000);
      if (!usedTimes.has(key)) {
        usedTimes.add(key);
        time = t;
        break;
      }
    }
    if (time === undefined) continue; // 所有时间点都用过了
    
    // 先暂停，再seek
    video.pause();
    video.currentTime = time;
    
    // 等待seeked + 2次requestAnimationFrame确保渲染
    await new Promise(resolve => {
      const to = setTimeout(resolve, 2000);
      const onSeeked = () => { clearTimeout(to); resolve(); };
      video.addEventListener('seeked', onSeeked, { once: true });
    });
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    
    // 尝试当前帧
    let result = await readTimerValue(video, region);
    
    // 如果失败，重试 time + 0.05s
    if (result.value === null) {
      const retryTime = Math.min(time + 0.05, duration - 0.01);
      video.currentTime = retryTime;
      await new Promise(resolve => {
        const to = setTimeout(resolve, 2000);
        const onSeeked = () => { clearTimeout(to); resolve(); };
        video.addEventListener('seeked', onSeeked, { once: true });
      });
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
      const retry = await readTimerValue(video, region);
      if (retry.value !== null) result = retry;
    }
    
    // 更新进度（回调给 analyzeVideos）
    if (onFrameDone) onFrameDone(i + 1);
    
    if (result.value !== null) {
      calibPoints.push({ videoTime: time, timerValue: result.value });
      console.log(`[extractFrames] ✓ 点${calibPoints.length}: time=${time.toFixed(2)}s, timer=${result.value}s`);
    }
  }
  
  // 校准点不足时发出警告
  if (calibPoints.length < MIN_CALIB_POINTS) {
    console.warn('[extractFrames] Warning:', v.name, `only ${calibPoints.length} calibration points (need ≥${MIN_CALIB_POINTS})`);
  }
  
  // 清理临时video元素，释放内存
  video.src = '';
  video.load();
  
  // 存储校准点
  state.frames[videoId] = calibPoints;
}

// ===== 计算最佳偏移（纯OCR + Theil-Sen回归 + 中位数timer值偏移）=====
async function calculateBestOffset() {
  const videos = state.videos.filter(v => {
    const pts = state.frames[v.id];
    if (!pts || pts.length < 2) {
      if (pts && pts.length > 0) {
        console.warn('[calculateBestOffset] Skipping', v.name, `- only ${pts.length} calibration points`);
      }
      return false;
    }
    return true;
  });
  if (videos.length < 2) {
    // 显示详细诊断信息
    const diag = state.videos.map(v => {
      const pts = state.frames[v.id] || [];
      return `${v.name}: ${pts.length}个校准点`;
    }).join(', ');
    console.warn('[calculateBestOffset] Not enough videos with calibration:', diag);
    return;
  }
  
  const base = videos[0];
  const basePoints = state.frames[base.id];
  const baseReg = theilSenRegression(basePoints);
  
  if (!baseReg) {
    state.bestOffset = 0;
    return;
  }
  
  // 收集所有 timer 值，取中位数作为参考点（避免外推到 T=0）
  const allTimerValues = basePoints.map(p => p.timerValue);
  
  for (let i = 1; i < videos.length; i++) {
    const target = videos[i];
    let points = state.frames[target.id];
    
    // 第一轮：初步回归
    let reg = theilSenRegression(points);
    if (!reg) continue;
    
    // 离群值过滤：移除残差 > 1.5秒的点（更严格）
    if (points.length > 3) {
      const residuals = points.map(p => Math.abs(p.videoTime - (reg.slope * p.timerValue + reg.intercept)));
      const sorted = residuals.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const threshold = Math.max(1.5, median * 2.5);
      const filtered = points.filter((p, idx) => residuals[idx] < threshold);
      
      if (filtered.length >= 2 && filtered.length < points.length) {
        points = filtered;
        reg = theilSenRegression(points);
        if (!reg) continue;
      }
    }
    
    // 收集目标视频的 timer 值取中位数
    allTimerValues.push(...points.map(p => p.timerValue));
    
    // 在中位数 timer 值处计算偏移（而非 T=0 外推）
    // offset(T) = targetReg(T) - baseReg(T)
    allTimerValues.sort((a, b) => a - b);
    const medianTimer = allTimerValues[Math.floor(allTimerValues.length / 2)];
    
    const baseTimeAtMedian = baseReg.slope * medianTimer + baseReg.intercept;
    const targetTimeAtMedian = reg.slope * medianTimer + reg.intercept;
    const offset = targetTimeAtMedian - baseTimeAtMedian;
    
    state.offsets[target.id] = offset;
  }
  
  // 第二轮：对所有已计算偏移做一致性校验
  // 如果某个偏移与其他视频的偏移差异过大，重新基于整体中位数调整
  const allOffsets = Object.values(state.offsets).filter(o => o !== 0);
  if (allOffsets.length > 1) {
    allOffsets.sort((a, b) => a - b);
    const medianOffset = allOffsets[Math.floor(allOffsets.length / 2)];
    const mad = allOffsets.reduce((sum, o) => sum + Math.abs(o - medianOffset), 0) / allOffsets.length;
    
    for (let i = 1; i < videos.length; i++) {
      const vid = videos[i];
      const currentOffset = state.offsets[vid.id];
      if (currentOffset === undefined) continue;
      
      if (Math.abs(currentOffset - medianOffset) > Math.max(2.0, mad * 3)) {
        console.warn(`[calculateBestOffset] ${vid.name}: offset ${currentOffset.toFixed(3)}s is outlier (median=${medianOffset.toFixed(3)}s, mad=${mad.toFixed(3)}s), adjusting...`);
        // 对离群值做加权修正：向中位数靠拢
        state.offsets[vid.id] = currentOffset * 0.3 + medianOffset * 0.7;
      }
    }
  }
}

// ===== 工具函数 =====
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);
