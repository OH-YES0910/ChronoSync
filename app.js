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

// ===== 自动区域（参考FrameSync：右上角 82%×8%） =====
function autoRegion(videoId) {
  const selector = document.getElementById(`selector-${videoId}`);
  const box = document.getElementById(`box-${videoId}`);
  const display = document.getElementById(`display-${videoId}`);
  
  const rect = selector.getBoundingClientRect();
  
  // 参考FrameSync：右上角82%×8%，不框中文
  state.regions[videoId] = { x: 82, y: 8, w: 16, h: 8 };
  
  box.style.left = (rect.width * 0.82) + 'px';
  box.style.top = (rect.height * 0.08) + 'px';
  box.style.width = (rect.width * 0.16) + 'px';
  box.style.height = (rect.height * 0.08) + 'px';
  box.classList.add('active');
  
  display.textContent = 'x=82% y=8% w=16% h=8% (计时器区域)';
  display.style.color = 'var(--success)';
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
  
  const totalSteps = state.videos.length + 1;
  let currentStep = 0;
  
  for (let i = 0; i < state.videos.length; i++) {
    const v = state.videos[i];
    currentStep = i;
    setProgress(container, (currentStep / totalSteps) * 100, `正在识别 ${v.name} (${i+1}/${state.videos.length})`);
    await extractFrames(v.id);
  }
  
  currentStep = state.videos.length;
  setProgress(container, (currentStep / totalSteps) * 100, '正在计算偏移...');
  await calculateBestOffset();
  
  container.innerHTML = `<div class="done">分析完成！最佳偏移: ${state.bestOffset.toFixed(3)}秒</div>`;
  
  initSync();
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
  
  // 构建每个视频的偏移显示信息（不再用 bestOffset 单值）
  const offsetInfo = validVideos.map((v, i) => {
    const offset = state.offsets[v.id] || 0;
    const label = i === 0 ? '基准' : `+${offset.toFixed(3)}s`;
    return `<span class="offset-tag ${i === 0 ? 'base' : ''}">${v.name.replace(/\.[^.]+$/, '')}: ${label}</span>`;
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
        <button class="btn-action" onclick="reselectVideos()">🔄 重新选择</button>
        <button class="btn-action" onclick="recalculate()">🔄 重新计算</button>
      </div>
      <div class="offset-display">${offsetInfo}</div>
    </div>
    
    <div class="sync-videos">
      ${validVideos.map((v, i) => `
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
  
  // 加载视频，保留各自已计算的 offset（不再覆盖）
  validVideos.forEach((v, i) => {
    const video = document.getElementById(`syncvideo-${v.id}`);
    video.src = v.url;
    video.load();
    // 不再覆盖 state.offsets — calculateBestOffset 已经为每个视频独立计算
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
    let frameCount = 0;
    let lastSyncTime = 0;
    
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
        
        // 每秒同步一次（用时间间隔判断，不用帧数）
        if (currentTime - lastSyncTime >= 1.0) {
          lastSyncTime = currentTime;
          
          state.videos.forEach(v => {
            if (v.id === state.videos[0].id) return;
            const video = document.getElementById(`syncvideo-${v.id}`);
            if (video && !video.paused) {
              const offset = state.offsets[v.id] || 0;
              const targetTime = currentTime + offset;
              const drift = video.currentTime - targetTime;
              const absDrift = Math.abs(drift);
              
              if (absDrift > 5.0) {
                // 极大偏移才seek，暂停+seek+恢复
                const wasPlaying = !video.paused;
                video.pause();
                video.currentTime = targetTime;
                video.addEventListener('seeked', () => {
                  if (wasPlaying && state.isPlaying) video.play();
                }, { once: true });
              } else if (absDrift > 0.5) {
                // 中等偏移用极温和的playbackRate微调（±3%）
                const correction = 1.0 - drift * 0.05;
                video.playbackRate = Math.max(0.97, Math.min(1.03, correction));
              } else {
                // 小偏移或无偏移恢复1.0
                if (Math.abs(video.playbackRate - 1.0) > 0.001) {
                  video.playbackRate = 1.0;
                }
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
  document.getElementById('comparisonArea').innerHTML = '';
  document.getElementById('analysisResult').innerHTML = '';
  document.getElementById('videoList').innerHTML = '';
  document.getElementById('nextBtn1').disabled = true;
  goToStep(1);
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
  // selector 是 16:9，视频可能不是，contain 会居中显示
  const SELECTOR_ASPECT = 16/9;
  const videoAspect = vw / vh;
  
  let scaleX, scaleY, offsetX, offsetY;
  if (videoAspect > SELECTOR_ASPECT) {
    // 视频更宽：填满宽度，上下居中
    scaleX = 1;
    scaleY = SELECTOR_ASPECT / videoAspect;
    offsetX = 0;
    offsetY = (1 - scaleY) / 2;
  } else {
    // 视频更窄（如 Asphalt 9 的 3200×2136）：填满高度，左右居中
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
  
  // 裁剪到有效范围
  const rx = Math.max(0, Math.min(videoX, vw));
  const ry = Math.max(0, Math.min(videoY, vh));
  const rw = Math.max(1, Math.min(videoW, vw - rx));
  const rh = Math.max(1, Math.min(videoH, vh - ry));
  
  // 参考FrameSync：640x144 画布，不做预处理
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 144;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, rx, ry, rw, rh, 0, 0, 640, 144);
  
  // 参考FrameSync：直接用 worker.recognize
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
async function extractFrames(videoId) {
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
  
  // 参考FrameSync：采样5帧
  const sampleCount = 5;
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
    
    // 更新进度条
    const percent = ((i + 1) / sampleCount) * 80;
    setProgress(container, percent, `正在OCR识别 ${v.name} 帧 ${i+1}/${sampleCount}`);
    
    console.log(`[extractFrames] Frame ${i+1}: time=${time.toFixed(2)}s, text="${result.text}", value=${result.value}`);
    
    if (result.value !== null) {
      calibPoints.push({ videoTime: time, timerValue: result.value });
    }
  }
  
  console.log('[extractFrames] Done for', v.name, `calibPoints=${calibPoints.length}`);
  
  // 存储校准点
  state.frames[videoId] = calibPoints;
}

// ===== 计算最佳偏移（纯OCR + Theil-Sen回归 + 离群值过滤）=====
async function calculateBestOffset() {
  const videos = state.videos.filter(v => state.frames[v.id] && state.frames[v.id].length >= 2);
  if (videos.length < 2) return;
  
  const container = document.getElementById('analysisResult');
  setProgress(container, 85, '正在计算偏移...');
  
  console.log('[calculateBestOffset] Videos with calibration:', videos.length);
  
  const base = videos[0];
  const baseReg = theilSenRegression(state.frames[base.id]);
  
  if (!baseReg) {
    state.bestOffset = 0;
    return;
  }
  
  console.log('[calculateBestOffset] Base reg:', baseReg);
  
  let totalOffset = 0;
  let validCount = 0;
  
  for (let i = 1; i < videos.length; i++) {
    const target = videos[i];
    let points = state.frames[target.id];
    
    // 第一轮：初步回归
    let reg = theilSenRegression(points);
    if (!reg) continue;
    
    // 离群值过滤：移除残差 > 2秒的点
    if (points.length > 3) {
      const residuals = points.map(p => Math.abs(p.videoTime - (reg.slope * p.timerValue + reg.intercept)));
      const median = residuals.slice().sort((a, b) => a - b)[Math.floor(residuals.length / 2)];
      const threshold = Math.max(2.0, median * 3); // 至少2秒或3倍中位数
      const filtered = points.filter((p, idx) => residuals[idx] < threshold);
      
      if (filtered.length >= 2 && filtered.length < points.length) {
        console.log(`[calculateBestOffset] ${target.name}: filtered ${points.length} → ${filtered.length} points (threshold=${threshold.toFixed(2)}s)`);
        points = filtered;
        reg = theilSenRegression(points);
        if (!reg) continue;
      }
    }
    
    // 偏移 = intercept_B - intercept_A
    const offset = reg.intercept - baseReg.intercept;
    
    console.log(`[calculateBestOffset] ${target.name}: offset=${offset.toFixed(3)}s (intercept_B=${reg.intercept.toFixed(3)}, intercept_A=${baseReg.intercept.toFixed(3)})`);
    
    state.offsets[target.id] = offset;
    totalOffset += offset;
    validCount++;
  }
  
  state.bestOffset = validCount > 0 ? totalOffset / validCount : 0;
  console.log('[calculateBestOffset] bestOffset:', state.bestOffset.toFixed(3));
  setProgress(container, 100, '完成');
}

// ===== 工具函数 =====
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', init);
