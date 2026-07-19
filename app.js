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
    
    lastDebug = {minX, maxX, minY, maxY, bW, bH, bestScore, whiteCount, whiteRatio: whiteRatio.toFixed(3)};
    console.log('findTimer debug:', lastDebug);
    
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
    console.log('autoDetectRegion debug:', lastDebug);
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
  
  console.log('autoDetectRegion:', {clusters: clusters.length, bestVotes: bestCluster.items.length, minX, maxX, minY, maxY});
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
  
  // 创建固定进度条
  container.innerHTML = `
    <div class="progress-container">
      <div class="progress-label" id="analysisLabel">正在分析...</div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" id="analysisFill" style="width:0%"></div>
      </div>
    </div>`;
  
  try {
    // 并行处理所有视频OCR
    const fillEl = document.getElementById('analysisFill');
    const labelEl = document.getElementById('analysisLabel');
    
    await Promise.all(state.videos.map(v => extractFrames(v.id)));
    
    if (fillEl) fillEl.style.width = '90%';
    if (labelEl) labelEl.textContent = '正在分析...';
    
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
      
      <div class="export-options">
        <div class="export-option">
          <label>画质:</label>
          <select id="exportQuality">
            <option value="sd">标清 (480p)</option>
            <option value="hd">高清 (720p)</option>
            <option value="original" selected>原画</option>
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
  
  // 加载所有视频并等待 ready（带错误处理，移动端更稳健）
  const loadPromises = allVideos.map((v) => {
    return new Promise(resolve => {
      const video = document.getElementById(`syncvideo-${v.id}`);
      if (!video) { resolve(); return; }
      video.src = v.url;
      video.preload = 'auto';
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      video.onloadeddata = done;
      video.onerror = () => { console.warn('视频加载失败:', v.name); done(); };
      setTimeout(done, 15000); // 15秒超时，移动端网络慢
      try { video.load(); } catch(e) { console.warn('video.load() 异常:', e); done(); }
    });
  });
  
  Promise.all(loadPromises).then(() => {
    // 全部加载完毕后再设置初始时间
    updateSyncFromSlider();
    initDragAndDrop();
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
  
  // 先设置所有视频到正确位置
  updateSyncFromSlider();
  
  // 等所有视频 ready 后再统一播放
  const readyPromises = state.videos.map(v => {
    return new Promise(resolve => {
      const video = document.getElementById(`syncvideo-${v.id}`);
      if (!video) { resolve(); return; }
      if (video.readyState >= 3) { resolve(); return; } // HAVE_FUTURE_DATA
      video.oncanplay = () => resolve();
      video.onerror = () => resolve();
      setTimeout(resolve, 3000); // 3秒超时
    });
  });
  
  Promise.all(readyPromises).then(() => {
    // 同时开始播放所有视频
    state.videos.forEach(v => {
      const video = document.getElementById(`syncvideo-${v.id}`);
      if (video) {
        video.playbackRate = 1.0;
        video.play().catch(() => {});
      }
    });
    
    const baseVideo = document.getElementById(`syncvideo-${state.videos[0].id}`);
    let lastDisplayTime = -1;
    
    function syncLoop(timestamp) {
      if (!state.isPlaying) return;
      
      if (baseVideo && !baseVideo.paused) {
        const baseTime = baseVideo.currentTime;
        
        // 更新UI显示（降低频率：每0.5秒更新一次）
        if (Math.abs(baseTime - lastDisplayTime) >= 0.5) {
          lastDisplayTime = baseTime;
          slider.value = baseTime;
          document.getElementById('timeDisplay').textContent = baseTime.toFixed(1) + 's';
          
          // 同步其他视频到正确位置（只在偏差>1秒时seek，避免频繁seek卡顿）
          state.videos.forEach((v, i) => {
            if (i === 0) return;
            const video = document.getElementById(`syncvideo-${v.id}`);
            if (!video || video.paused) return;
            const offset = state.offsets[v.id] || 0;
            const targetTime = baseTime + offset;
            if (Math.abs(video.currentTime - targetTime) > 1.0) {
              video.currentTime = Math.max(0, targetTime);
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
    const orderedVideos = getExportVideoOrder();
    const validVideos = orderedVideos.filter(v => state.frames[v.id] && state.frames[v.id].length > 0);
    if (validVideos.length < 2) throw new Error('视频不足');
    
    const layout = state.selectedLayout || 'vertical';
    const wantMP4 = document.getElementById('exportFormat').value === 'mp4';
    const quality = document.getElementById('exportQuality').value;
    const fps = quality === 'sd' ? 24 : 30;
    
    // 画质设置
    const qualityMap = {
      sd: { scale: 0.5, bitrate: 2000000, crf: 28 },       // 480p
      hd: { scale: 0.75, bitrate: 5000000, crf: 25 },      // 720p
      original: { scale: 1.0, bitrate: 8000000, crf: 23 }  // 原画
    };
    const q = qualityMap[quality];
    
    // 创建离屏 canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const baseVideoEl = document.getElementById(`syncvideo-${validVideos[0].id}`);
    const rawW = baseVideoEl.videoWidth;
    const rawH = baseVideoEl.videoHeight;
    const vw = Math.round(rawW * q.scale);
    const vh = Math.round(rawH * q.scale);
    
    // 根据布局计算canvas尺寸
    if (layout === 'horizontal') {
      canvas.width = vw * validVideos.length;
      canvas.height = vh;
    } else if (layout === 'top1-bottom2' && validVideos.length === 3) {
      canvas.width = vw * 2;
      canvas.height = vh * 2;
    } else if (layout === 'top2-bottom1' && validVideos.length === 3) {
      canvas.width = vw * 2;
      canvas.height = vh * 2;
    } else if (layout === 'grid-4' && validVideos.length === 4) {
      canvas.width = vw * 2;
      canvas.height = vh * 2;
    } else {
      // vertical 或 2+4视频的默认
      canvas.width = vw;
      canvas.height = vh * validVideos.length;
    }
    
    // 始终用 WebM VP9 录制（浏览器原生支持）
    const stream = canvas.captureStream(0);
    const chunks = [];
    
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: q.bitrate
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
    
    // 逐帧渲染（去掉帧间等待，用requestFrame()快速推送）
    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      if (!state.exporting) break;
      
      const time = exportStartTime + frameIdx * frameInterval;
      
      if (frameIdx % (fps * 2) === 0) {
        const progress = (frameIdx / totalFrames) * 80;
        progressEl.textContent = `录制进度: ${progress.toFixed(0)}% (帧 ${frameIdx}/${totalFrames})`;
      }
      
      // Seek 每个视频到对齐后的时间点
      const seekPromises = validVideos.map((v, i) => {
        const vid = exportVideos[i];
        const offset = state.offsets[v.id] || 0;
        const targetTime = Math.max(0, Math.min(v.duration - 0.01, time + offset));
        
        return new Promise(resolve => {
          if (Math.abs(vid.currentTime - targetTime) < 0.01) {
            resolve();
            return;
          }
          vid.currentTime = targetTime;
          vid.addEventListener('seeked', resolve, { once: true });
          setTimeout(resolve, 200);
        });
      });
      
      await Promise.all(seekPromises);
      
      // 清空canvas
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // 根据布局绘制所有视频帧到 canvas
      if (layout === 'horizontal') {
        validVideos.forEach((v, i) => {
          const vid = exportVideos[i];
          ctx.drawImage(vid, i * vw, 0, vw, vh);
        });
      } else if (layout === 'top1-bottom2' && validVideos.length === 3) {
        ctx.drawImage(exportVideos[0], vw * 0.5, 0, vw, vh);
        ctx.drawImage(exportVideos[1], 0, vh, vw, vh);
        ctx.drawImage(exportVideos[2], vw, vh, vw, vh);
      } else if (layout === 'top2-bottom1' && validVideos.length === 3) {
        ctx.drawImage(exportVideos[0], 0, 0, vw, vh);
        ctx.drawImage(exportVideos[1], vw, 0, vw, vh);
        ctx.drawImage(exportVideos[2], vw * 0.5, vh, vw, vh);
      } else if (layout === 'grid-4' && validVideos.length === 4) {
        validVideos.forEach((v, i) => {
          const vid = exportVideos[i];
          const row = Math.floor(i / 2), col = i % 2;
          ctx.drawImage(vid, col * vw, row * vh, vw, vh);
        });
      } else {
        validVideos.forEach((v, i) => {
          const vid = exportVideos[i];
          ctx.drawImage(vid, 0, i * vh, vw, vh);
        });
      }
      
      if (stream.requestFrame) {
        stream.requestFrame();
      }
      
      // 不再等待，立即推送下一帧
    }
    
    // 停止录制
    recorder.stop();
    await new Promise(resolve => { recorder.onstop = () => resolve(); });
    
    // 清理临时视频元素
    exportVideos.forEach(v => { v.src = ''; });
    
    let finalBlob;
    let finalExt;
    
    if (wantMP4) {
      let mp4Failed = false;
      try {
        progressEl.textContent = '正在转换为 MP4 格式...';
        
        const { FFmpeg } = FFmpegWASM;
        const ffmpeg = new FFmpeg();
        
        ffmpeg.on('progress', ({ progress: p }) => {
          const total = 80 + p * 20;
          progressEl.textContent = `转换进度: ${total.toFixed(0)}%`;
        });
        
        // 尝试本地文件，失败则用CDN
        let loaded = false;
        try {
          await ffmpeg.load({
            coreURL: 'ffmpeg/ffmpeg-core.js',
            wasmURL: 'ffmpeg/ffmpeg-core.wasm',
            workerURL: 'ffmpeg/814.ffmpeg.js',
          });
          loaded = true;
        } catch (localErr) {
          console.warn('本地ffmpeg加载失败，尝试CDN:', localErr);
          progressEl.textContent = '正在从CDN加载转换器...';
          await ffmpeg.load({
            coreURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
            wasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
          });
          loaded = true;
        }
        
        if (loaded) {
          const webmBlob = new Blob(chunks, { type: 'video/webm' });
          const webmData = new Uint8Array(await webmBlob.arrayBuffer());
          
          await ffmpeg.writeFile('input.webm', webmData);
          await ffmpeg.exec(['-i', 'input.webm', '-c:v', 'libx264', '-preset', 'fast', '-crf', q.crf, '-y', 'output.mp4']);
          
          const mp4Data = await ffmpeg.readFile('output.mp4');
          finalBlob = new Blob([mp4Data.buffer], { type: 'video/mp4' });
          finalExt = 'mp4';
          
          await ffmpeg.deleteFile('input.webm');
          await ffmpeg.deleteFile('output.mp4');
          ffmpeg.terminate();
        }
      } catch (ffmpegErr) {
        console.warn('ffmpeg.wasm 转换失败，回退到 WebM:', ffmpegErr);
        mp4Failed = true;
        finalBlob = new Blob(chunks, { type: 'video/webm' });
        finalExt = 'webm';
      }
      
      if (mp4Failed) {
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
    const layoutName = { horizontal: '横向', vertical: '竖向', 'top1-bottom2': '上1下2', 'top2-bottom1': '上2下1' }[layout] || layout;
    a.download = `对比视频_${layoutName}_${new Date().toISOString().slice(0, 10)}.${finalExt}`;
    a.click();
    URL.revokeObjectURL(url);
    
    if (wantMP4 && finalExt !== 'mp4') {
      progressEl.textContent = '✅ 导出完成 (MP4转换失败，已导出为 WebM 格式，可用在线工具转为 MP4)';
    } else {
      progressEl.textContent = `✅ 导出完成 (${finalExt.toUpperCase()} 格式)`;
    }
    
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

// ===== 全部视频一键自动识别 =====
async function autoDetectAll() {
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
  
  let dragIdx = null;
  let lastOverIdx = null;
  
  list.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.export-order-item');
    if (!item) return;
    dragIdx = parseInt(item.dataset.idx);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // 延迟设置透明度，让浏览器截取到正常外观作为拖拽图标
    setTimeout(() => item.classList.add('dragging'), 0);
  });
  
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const items = Array.from(list.querySelectorAll('.export-order-item'));
    // 找到鼠标下方的项（用元素中心点判断）
    let overIdx = null;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        overIdx = parseInt(item.dataset.idx);
        break;
      }
    }
    if (overIdx === null) overIdx = items.length - 1;
    
    // 只在变化时更新样式
    if (overIdx !== lastOverIdx) {
      items.forEach(el => el.classList.remove('drag-over'));
      if (overIdx !== dragIdx && items[overIdx]) {
        items[overIdx].classList.add('drag-over');
      }
      lastOverIdx = overIdx;
    }
  });
  
  list.addEventListener('dragleave', (e) => {
    // 只在真正离开列表时清除
    if (!list.contains(e.relatedTarget)) {
      list.querySelectorAll('.export-order-item').forEach(el => el.classList.remove('drag-over'));
      lastOverIdx = null;
    }
  });
  
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragIdx === null || lastOverIdx === null || dragIdx === lastOverIdx) {
      cleanup();
      return;
    }
    
    // 重新排列state.videos
    const [moved] = state.videos.splice(dragIdx, 1);
    state.videos.splice(lastOverIdx, 0, moved);
    
    // 重新渲染列表
    list.innerHTML = state.videos.map((v, i) => `
      <div class="export-order-item" draggable="true" data-idx="${i}">
        <span class="drag-handle">⣿</span>
        <span class="order-name">${v.name}</span>
        <span class="order-num">#${i + 1}</span>
      </div>
    `).join('');
    
    // 给被交换的项加闪烁动画
    const newItems = list.querySelectorAll('.export-order-item');
    if (newItems[lastOverIdx]) {
      newItems[lastOverIdx].classList.add('just-swapped');
      setTimeout(() => newItems[lastOverIdx]?.classList.remove('just-swapped'), 400);
    }
    
    cleanup();
  });
  
  function cleanup() {
    list.querySelectorAll('.export-order-item').forEach(el => {
      el.classList.remove('dragging', 'drag-over');
    });
    dragIdx = null;
    lastOverIdx = null;
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
function parseTimerText(text) {
  // 清理文本
  const cleaned = text.replace(/[^0-9:.,]/g, '').trim();
  
  // 尝试匹配 MM:SS 或 MM:SS.m 或 MM:S 格式
  let match = cleaned.match(/(\d+):(\d{1,2})(?:[.,](\d+))?/);
  if (match) {
    const mins = parseInt(match[1]);
    const secs = parseInt(match[2]);
    const ms = match[3] ? parseFloat('0.' + match[3]) : 0;
    if (mins <= 30 && secs < 60) return mins * 60 + secs + ms;
  }
  
  // 尝试纯数字（可能是秒数，如 "22." 或 "40,"）
  match = cleaned.match(/^(\d+)(?:[.,](\d+))?$/);
  if (match) {
    const whole = parseInt(match[1]);
    const frac = match[2] ? parseFloat('0.' + match[2]) : 0;
    if (whole <= 30) {
      // 直接当秒数
      return whole + frac;
    }
    if (whole > 100 && whole < 10000) {
      // 可能是 MMSS 格式
      const mins = Math.floor(whole / 100);
      const secs = whole % 100;
      if (mins <= 30 && secs < 60) return mins * 60 + secs + frac;
    }
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
      logger: m => { if (m.status === 'loading tesseract core') console.log('[OCR] 加载内核…'); }
    });
    await OCR.worker.setParameters({
      tessedit_char_whitelist: '0123456789.:',  // 只识别数字和分隔符
      tessedit_pageseg_mode: '8',  // PSM_SINGLE_WORD — 适合 MM:SS.mmm 格式
    });
    OCR.ready = true;
    console.log('[OCR] Tesseract 就绪');
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
    const text = (data.text || '').trim();
    const confidence = (data.confidence || 0) / 100;
    const value = parseTimerText(text);
    console.log('[OCR]', { text, value, confidence: (confidence*100).toFixed(0) + '%' });
    console.log('[OCR] Canvas ROI:', { rx: Math.round(rx), ry: Math.round(ry), rw: Math.round(rw), rh: Math.round(rh), vw, vh });
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
  
  if (!v || !region) return;
  
  // 参考FrameSync：先初始化OCR Worker
  const ok = await ocrInit();
  if (!ok) {
    console.error('[extractFrames] OCR初始化失败');
    return;
  }
  
  console.log('[extractFrames] Starting for', v.name, 'region:', region);
  
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
  console.log('[extractFrames] Video loaded:', v.name, `${video.videoWidth}x${video.videoHeight}`, `duration=${video.duration}s`);
  
  const duration = video.duration;
  const usableStart = duration * 0.05;  // 参考FrameSync：5%~95%
  const usableEnd = duration * 0.95;
  
  // 参考FrameSync：采样8帧（提高回归精度）
  const sampleCount = 8;
  const calibPoints = [];
  const usedTimes = new Set();
  
  const container = document.getElementById('analysisResult');
  
  for (let i = 0; i < sampleCount; i++) {
    // 随机采样
    let time;
    for (let attempt = 0; attempt < 200; attempt++) {  // 参考FrameSync：200次尝试
      const t = usableStart + Math.random() * (usableEnd - usableStart);
      const key = Math.round(t * 1000);
      if (!usedTimes.has(key)) {
        usedTimes.add(key);
        time = t;
        break;
      }
    }
    if (time === undefined) time = usableStart + (usableEnd - usableStart) * i / (sampleCount - 1);
    
    // 参考FrameSync：先暂停，再seek
    video.pause();
    video.currentTime = time;
    
    // 参考FrameSync：等待seeked + 2次requestAnimationFrame确保渲染
    await new Promise(resolve => {
      const to = setTimeout(resolve, 2000);
      const onSeeked = () => { clearTimeout(to); resolve(); };
      video.addEventListener('seeked', onSeeked, { once: true });
    });
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    
    // 参考FrameSync：先尝试当前帧
    let result = await readTimerValue(video, region);
    
    // 参考FrameSync：如果失败，重试 time + 0.05s
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
    
    console.log(`[extractFrames] Frame ${i+1}: time=${time.toFixed(2)}s, text="${result.text}", value=${result.value}`);
    
    if (result.value !== null) {
      calibPoints.push({ videoTime: time, timerValue: result.value });
    }
  }
  
  console.log('[extractFrames] Done for', v.name, `calibPoints=${calibPoints.length}`);
  
  // 存储校准点
  state.frames[videoId] = calibPoints;
}

// ===== 计算最佳偏移（纯OCR + Theil-Sen回归 + 中位数timer值偏移）=====
async function calculateBestOffset() {
  const videos = state.videos.filter(v => state.frames[v.id] && state.frames[v.id].length >= 2);
  if (videos.length < 2) return;
  
  console.log('[calculateBestOffset] Videos with calibration:', videos.length);
  
  const base = videos[0];
  const basePoints = state.frames[base.id];
  const baseReg = theilSenRegression(basePoints);
  
  if (!baseReg) {
    state.bestOffset = 0;
    return;
  }
  
  console.log('[calculateBestOffset] Base reg:', baseReg);
  
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
        console.log(`[calculateBestOffset] ${target.name}: filtered ${points.length} → ${filtered.length} points (threshold=${threshold.toFixed(2)}s)`);
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
    
    console.log(`[calculateBestOffset] ${target.name}: offset=${offset.toFixed(3)}s at timer=${medianTimer.toFixed(1)}s (targetSlope=${reg.slope.toFixed(4)}, baseSlope=${baseReg.slope.toFixed(4)})`);
    
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
  
  console.log('[calculateBestOffset] Done');
}

// ===== 工具函数 =====
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);
