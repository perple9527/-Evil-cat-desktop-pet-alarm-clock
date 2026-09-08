const $ = (id) => document.getElementById(id);

const BASE_H = 240;
const STRIDE = 2;
const ALPHA_MIN = 40;
const HIT_ALPHA = 110;

let assets, wa, settings;
let idlePose, hissPose;
let scale = 1;
let k = 1;
let layout = null;
let hissing = false;
let hissTimer = null;
let cdHideTimer = null;
let cdTick = null;
let ringLoop = null;
let dragging = false;
let dragInfo = null;
let overInteractive = false;
let state = { ringing: false, alarm: null, next: null, count: 0 };

const hissAudio = new Audio();
hissAudio.preload = 'auto';

async function loadPose(src) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const gw = Math.ceil(img.width / STRIDE);
  const gh = Math.ceil(img.height / STRIDE);
  const grid = new Uint8Array(gw * gh);
  let bx = gw, by = gh, ex = -1, ey = -1;
  for (let gy = 0; gy < gh; gy++) {
    const rowBase = gy * STRIDE * img.width;
    for (let gx = 0; gx < gw; gx++) {
      const a = data[(rowBase + gx * STRIDE) * 4 + 3];
      grid[gy * gw + gx] = a;
      if (a > ALPHA_MIN) {
        if (gx < bx) bx = gx;
        if (gy < by) by = gy;
        if (gx > ex) ex = gx;
        if (gy > ey) ey = gy;
      }
    }
  }
  let headTopRow = by;
  for (let gy = by; gy <= ey; gy++) {
    let cnt = 0;
    for (let gx = bx; gx <= ex; gx++) {
      if (grid[gy * gw + gx] > ALPHA_MIN) cnt++;
    }
    if (cnt >= 3) { headTopRow = gy; break; }
  }
  const headEndRow = headTopRow + Math.floor((ey - by) * 0.28);
  let cSum = 0, cN = 0;
  for (let gy = headTopRow; gy <= headEndRow; gy++) {
    for (let gx = bx; gx <= ex; gx++) {
      if (grid[gy * gw + gx] > ALPHA_MIN) {
        cSum += gx;
        cN++;
      }
    }
  }
  const fallbackHeadCx = cN ? (cSum / cN) * STRIDE + STRIDE / 2 : (bx + ex + 1) * STRIDE / 2;
  // 眼睛定位：在头部区域找深色像素（眼睛/耳内阴影）的质心，比"整条头带平均"更贴近脸的中心；
  // 找不到深色像素时退回上面的头带平均（换素材后仍可用）
  let eyeSum = 0, eyeN = 0, eyeTop = -1;
  const cropX = bx * STRIDE, cropY = by * STRIDE;
  const cropW = (ex - bx + 1) * STRIDE, cropH = (ey - by + 1) * STRIDE;
  for (let py = cropY; py < cropY + cropH * 0.35; py++) {
    for (let px = cropX; px < cropX + cropW; px++) {
      const o = (py * img.width + px) * 4;
      if (data[o + 3] > 200 && data[o] < 90 && data[o + 1] < 90 && data[o + 2] < 90) {
        eyeSum += px;
        eyeN++;
        if (eyeTop < 0) eyeTop = py;
      }
    }
  }
  // 裁掉透明边，生成只含猫咪本体的图：避免整图被压进 bbox 比例导致画面变形、
  // 位置错位（气泡"歪"、点击/拖拽命中不准的根源）
  const cropped = document.createElement('canvas');
  cropped.width = cropW;
  cropped.height = cropH;
  cropped.getContext('2d').drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return {
    iw: img.width,
    ih: img.height,
    gw,
    gh,
    grid,
    bx: cropX,
    by: cropY,
    bw: cropW,
    bh: cropH,
    headTop: headTopRow * STRIDE,
    headCx: eyeN ? eyeSum / eyeN : fallbackHeadCx,
    croppedUrl: cropped.toDataURL('image/png'),
  };
}

function computeMaxScale() {
  // 窗口总高 = 底垫(8s) + 猫咪(240s) + 顶部空间，随 scale 线性增长。
  // 顶部空间 = 两个气泡(各 40s) + 倒计时多预留一行(22.88s) + 间距(6s、9) + 头顶偏移(240*headRatio*s)。
  // 解出窗口整体不超过工作区 92% 的最大倍数，保证放大后猫咪和气泡都不超出屏幕。
  const headRatio = (idlePose.headTop - idlePose.by) / idlePose.bh; // 头顶在素材裁切框中的相对位置
  const hFactor = 356.88 - 240 * headRatio;
  const byH = (wa.height * 0.92 - 18) / hFactor;
  const unionW = Math.max(idlePose.bw, hissPose.bw * (idlePose.bh / hissPose.bh));
  const wFactor = Math.max((unionW / idlePose.bh) * 240 + 20, 240);
  const byW = (wa.width * 0.92) / wFactor;
  return Math.min(byH, byW);
}

function clampScale(s) {
  return Math.max(0.45, Math.min(s, computeMaxScale()));
}

function placeImg(el, w, h, catW, catH) {
  el.style.width = w + 'px';
  el.style.height = h + 'px';
  el.style.left = ((catW - w) / 2) + 'px';
  el.style.top = (catH - h) + 'px';
}

function layoutAll() {
  k = (BASE_H * scale) / idlePose.bh;
  const kh = k * (idlePose.bh / hissPose.bh);
  const idleW = idlePose.bw * k;
  const idleH = idlePose.bh * k;
  const hissW = hissPose.bw * kh;
  const hissH = idleH;
  const catW = Math.max(idleW, hissW);
  const catH = idleH;
  const bf = 20 * scale;
  const padX = Math.max(12, 10 * scale);
  const bottomPad = Math.max(10, 8 * scale);
  const bubbleH = bf * 2.0;
  const gap = 6 * scale;
  // 最小宽度按倒计时气泡两行完整显示计算（bf*12 约 240px@1x），避免文本折行/跳动
  const winW = Math.ceil(Math.max(catW + padX * 2, bf * 12));

  const headTopOff = (idlePose.headTop - idlePose.by) * k;
  // 气泡底部贴在头顶上方 headGap 处：headTopOff 只用于定位头顶，不能再叠进间距
  // （旧公式把 headTopOff 算了两次，放大后气泡离头顶越来越远）
  const headGap = 9;
  const clockTopRel = headTopOff - headGap - bubbleH;
  // 倒计时气泡可能换行成两行：多预留一行的高度
  const cdLineH = bf * 0.88 * 1.3;
  const countTopRel = clockTopRel - gap - 9 - bubbleH - cdLineH;
  const topSpace = -countTopRel;
  const winH = Math.ceil(bottomPad + catH + topSpace);

  const cx = winW / 2;
  const bottomY = winH - bottomPad;
  const contentTop = bottomY - catH;

  let headCx = cx - idleW / 2 + (idlePose.headCx - idlePose.bx) * k;
  headCx = Math.min(Math.max(headCx, padX + 30), winW - padX - 30);

  layout = {
    k, kh, catW, catH, bf, padX, bottomPad, bubbleH, gap,
    winW, winH, cx, bottomY, contentTop, headCx,
    idleW, idleH, hissW, hissH,
    idleRect: { x: cx - idleW / 2, y: bottomY - idleH, w: idleW, h: idleH },
    hissRect: { x: cx - hissW / 2, y: bottomY - hissH, w: hissW, h: hissH },
  };

  const wrap = $('catWrap');
  wrap.style.width = catW + 'px';
  wrap.style.height = catH + 'px';
  wrap.style.left = (cx - catW / 2) + 'px';
  wrap.style.top = contentTop + 'px';
  wrap.style.setProperty('--rise', Math.round(catH * 0.06) + 'px');

  placeImg($('imgIdle'), idleW, idleH, catW, catH);
  placeImg($('imgHiss'), hissW, hissH, catW, catH);

  const cb = $('clockBubble');
  cb.style.fontSize = bf + 'px';
  cb.style.left = headCx + 'px';
  cb.style.top = (contentTop + clockTopRel) + 'px';

  const cdb = $('countdownBubble');
  cdb.style.fontSize = (bf * 0.88) + 'px';
  cdb.style.maxWidth = Math.max(120, winW - padX * 2 - 4) + 'px';
  // 固定宽度槽：内容每秒变化时气泡宽度不变，文本不跳动
  cdb.style.width = cdb.style.maxWidth;
  cdb.style.left = headCx + 'px';
  cdb.style.top = (contentTop + countTopRel) + 'px';
  clampCountdownX(); // 若气泡正显示着，缩放后也保持在窗口内

  const r = Math.max(9, 7.5 * scale);
  const hdl = $('handle');
  hdl.style.width = hdl.style.height = (r * 2) + 'px';
  hdl.style.left = 3 + 'px';
  hdl.style.top = 3 + 'px';
  layout.handle = { x: 3, y: 3, r };

  api.resizeWindow(winW, winH);
}

function refreshWorkArea() {
  // 移动/缩放结束后刷新所在屏幕的工作区，保证多显示器下缩放上限与钳制都正确
  api.getWorkArea().then((w) => { if (w) wa = w; });
}

function alphaAt(x, y) {
  if (!layout) return false;
  const hd = layout.handle;
  const dx = x - (hd.x + hd.r);
  const dy = y - (hd.y + hd.r);
  const rr = hd.r + 5;
  if (dx * dx + dy * dy <= rr * rr) return true;
  const pose = hissing ? hissPose : idlePose;
  const rect = hissing ? layout.hissRect : layout.idleRect;
  const kk = hissing ? layout.kh : layout.k;
  const m = 0.06;
  if (x < rect.x + rect.w * m || x > rect.x + rect.w * (1 - m)) return false;
  if (y < rect.y + rect.h * m || y > rect.y + rect.h * (1 - m)) return false;
  const ix = (x - rect.x) / kk;
  const iy = (y - rect.y) / kk;
  if (ix < 0 || iy < 0 || ix > rect.w / kk || iy > rect.h / kk) return false;
  const gx = Math.floor((pose.bx + ix) / STRIDE);
  const gy = Math.floor((pose.by + iy) / STRIDE);
  if (gx < 0 || gy < 0 || gx >= pose.gw || gy >= pose.gh) return false;
  return pose.grid[gy * pose.gw + gx] > HIT_ALPHA;
}

function hiss(silent) {
  if (hissTimer) clearTimeout(hissTimer);
  hissing = true;
  $('imgHiss').classList.remove('hidden');
  $('imgIdle').classList.add('hidden');
  if (!silent) {
    // silent=true 时只做哈气动作不出声（闹钟响铃期间用户只要音乐）
    try {
      hissAudio.currentTime = 0;
      const p = hissAudio.play();
      if (p) p.catch(() => {});
    } catch (e) {}
  }
  $('catWrap').classList.add('up');
  hissTimer = setTimeout(() => {
    $('catWrap').classList.remove('up');
    setTimeout(() => {
      $('imgHiss').classList.add('hidden');
      $('imgIdle').classList.remove('hidden');
      hissing = false;
    }, 150);
  }, 330);
}

function buildCountdownText() {
  // 目的文案过长时截短（4 字），保证倒计时气泡两行内完整显示
  const label = (purpose) => {
    const p = (purpose || '').trim();
    if (!p) return '闹钟';
    return `「${p.length > 4 ? p.slice(0, 4) + '…' : p}」`;
  };
  // 所有分支都固定两行：时间每秒变化时气泡尺寸不变，文本不跳动
  if (state.ringing && state.alarm) return `${label(state.alarm.purpose)}\n正在响铃！`;
  if (!state.next) return '还没有闹钟\n先去设置一个吧';
  const diff = state.next.at - Date.now();
  if (diff <= 0) return `${label(state.next.purpose)}\n时间到啦！`;
  const s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  // 第一行"距离…还有"，第二行剩余时间，两行固定排版完整展示
  const head = `距离${label(state.next.purpose)}还有`;
  if (d > 0) return `${head}\n${d} 天 ${h} 小时`;
  if (h > 0) return `${head}\n${h} 小时 ${m} 分钟`;
  if (m > 0) return `${head}\n${m} 分 ${sec} 秒`;
  return `${head}\n${sec} 秒`;
}

function stopCdTick() {
  if (cdTick) {
    clearInterval(cdTick);
    cdTick = null;
  }
}

function clampCountdownX() {
  // 倒计时气泡按内容变宽，居中后可能伸出窗口左/右缘；按实际宽度钳制回窗口内
  const el = $('countdownBubble');
  if (!layout) return;
  const w = el.offsetWidth || 0;
  if (!w) return;
  const half = w / 2;
  const x = Math.min(Math.max(layout.headCx, half + 2), layout.winW - half - 2);
  el.style.left = x + 'px';
}

function showCountdown() {
  if (!(state.next || state.ringing)) return;
  const el = $('countdownBubble');
  $('countdownText').textContent = buildCountdownText();
  el.classList.remove('hidden', 'fadeout', 'pop');
  void el.offsetWidth;
  el.classList.add('pop');
  clampCountdownX();
  if (cdHideTimer) clearTimeout(cdHideTimer);
  // 响铃状态持续显示；普通状态 4.6 秒后自动隐藏
  if (!state.ringing) {
    cdHideTimer = setTimeout(() => {
      el.classList.add('fadeout');
      setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('fadeout');
        stopCdTick();
      }, 350);
    }, 4600);
  }
  if (!cdTick) {
    cdTick = setInterval(() => {
      if ($('countdownBubble').classList.contains('hidden')) {
        stopCdTick();
        return;
      }
      $('countdownText').textContent = buildCountdownText();
      clampCountdownX();
    }, 1000);
  }
}

function tickClock() {
  const d = new Date();
  $('clockText').textContent =
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

document.addEventListener('mousemove', (e) => {
  if (dragging && dragInfo) {
    if (!(e.buttons & 1)) {
      dragging = false;
      dragInfo = null;
      api.saveScale(scale);
      refreshWorkArea();
      return;
    }
    const d = Math.hypot(e.screenX - dragInfo.ax, e.screenY - dragInfo.ay);
    const ns = clampScale(dragInfo.scale + (d - dragInfo.d0) * 0.004);
    if (Math.abs(ns - scale) > 0.002) {
      scale = ns;
      layoutAll();
    }
    return;
  }
  if (moving || pressing || dragging) {
    overInteractive = true;
    api.setIgnoreMouse(false);
    return;
  }
  const it = alphaAt(e.clientX, e.clientY);
  if (it !== overInteractive) {
    overInteractive = it;
    api.setIgnoreMouse(!it);
    if (it) showCountdown(); // 鼠标刚移到猫身上时，展示定时内容
  }
  $('handle').classList.toggle('show', it);
});

document.addEventListener('mouseleave', () => {
  if (moving || pressing || dragging) return;
  overInteractive = false;
  api.setIgnoreMouse(true);
  $('handle').classList.remove('show');
});

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (alphaAt(e.clientX, e.clientY)) api.openMenu();
});

function overHandle(x, y) {
  if (!layout) return false;
  const hd = layout.handle;
  const dx = x - (hd.x + hd.r);
  const dy = y - (hd.y + hd.r);
  const rr = hd.r + 5;
  return dx * dx + dy * dy <= rr * rr;
}

let pressTimer = null;
let moving = false;
let dragBeat = null;
let pressPoint = null;
let lastScreen = null;
let pressing = false;

const stage = $('stage');

function stopMoving(savePos) {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  // 兜底：任何结束路径都清掉缩放手柄状态，防止残留的 dragging 让后续拖动/移动失控
  dragging = false;
  dragInfo = null;
  pressPoint = null;
  if (moving) {
    moving = false;
    if (dragBeat) {
      clearInterval(dragBeat);
      dragBeat = null;
    }
    api.endDrag(); // 通知主进程停止"光标跟随"拖拽
    $('catWrap').classList.remove('grabbed');
    if (savePos !== false) {
      api.getBounds().then((b) => {
        if (b) api.savePos(b.x + b.width, b.y + b.height);
      });
    }
  }
  lastScreen = null;
  overInteractive = false;
  api.setIgnoreMouse(true);
  $('handle').classList.remove('show');
  refreshWorkArea();
}

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (overHandle(e.clientX, e.clientY)) return;
  if (!alphaAt(e.clientX, e.clientY)) return;
  // 开始新的按压前，先清掉可能残留的缩放手柄状态
  dragging = false;
  dragInfo = null;
  try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  pressing = true;
  // 记录"按住瞬间"的光标位置：拖动开始后窗口以它为锚，让猫追到光标下，光标始终贴在猫上
  pressPoint = { x: e.screenX, y: e.screenY };
  lastScreen = { x: e.screenX, y: e.screenY };
  hiss();
  showCountdown();
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = setTimeout(async () => {
    if (!pressing || !pressPoint) return;
    const b = await api.getBounds();
    if (!b) return;
    moving = true;
    // 交给主进程做"光标跟随"：主进程每 16ms 读系统光标位置移动窗口，
    // 光标永远贴在按下点，快速移动也不会脱轨（渲染进程事件滞后是脱轨的根源）
    const offX = Math.min(Math.max(pressPoint.x - b.x, 0), b.width - 1);
    const offY = Math.min(Math.max(pressPoint.y - b.y, 0), b.height - 1);
    api.startDrag(offX, offY);
    // 拖动期间的心跳：主进程 2 秒收不到就自动停止跟随，防止漏松手后窗口一直粘着光标
    dragBeat = setInterval(() => api.dragBeat(), 500);
    $('catWrap').classList.add('grabbed');
  }, 420);
});

stage.addEventListener('pointermove', (e) => {
  lastScreen = { x: e.screenX, y: e.screenY };
  if (moving) {
    if (!(e.buttons & 1)) {
      stopMoving();
      return;
    }
    // 位置由主进程按系统光标实时驱动，渲染进程这里只负责检测松手
  }
});

window.addEventListener('pointerup', () => {
  pressing = false;
  stopMoving();
});

window.addEventListener('pointercancel', () => {
  pressing = false;
  stopMoving();
});

window.addEventListener('blur', () => {
  pressing = false;
  stopMoving();
});

document.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    dragInfo = null;
    api.saveScale(scale);
    refreshWorkArea();
  }
});

$('handle').addEventListener('mousedown', async (e) => {
  e.stopPropagation();
  e.preventDefault();
  dragging = true;
  overInteractive = true;
  api.setIgnoreMouse(false);
  const b = await api.getBounds();
  if (!b) { dragging = false; return; }
  const hd = layout.handle;
  const ax = b.x + hd.x + hd.r;
  const ay = b.y + hd.y + hd.r;
  dragInfo = {
    ax,
    ay,
    scale,
    d0: Math.max(6, Math.hypot(e.screenX - ax, e.screenY - ay)),
  };
});

api.onAlarmState((st) => {
  state = st;
  showCountdown(); // 定时内容变化（新增/开启/响铃）时自动展示
  if (st.ringing && !ringLoop) ringLoop = setInterval(() => hiss(true), 2400); // 响铃期间只做视觉哈气，不出声（用户只要音乐）
  if (!st.ringing && ringLoop) {
    clearInterval(ringLoop);
    ringLoop = null;
  }
});

api.onScaleReset(() => {
  scale = clampScale(1);
  layoutAll();
});

api.onScaleChanged((s) => {
  // 设置窗口保存缩放后实时应用（不用重启）
  if (!idlePose || !hissPose) return; // 素材还没加载完时先忽略
  scale = clampScale(Number(s) || 1);
  layoutAll();
});

async function init() {
  api.setIgnoreMouse(true);
  assets = await api.getAssets();
  wa = await api.getWorkArea();
  settings = await api.getSettings();
  hissAudio.src = assets.hissAudio;
  [idlePose, hissPose] = await Promise.all([loadPose(assets.idle), loadPose(assets.hiss)]);
  // 使用裁掉透明边的图，保证画面比例、气泡位置与命中检测三者一致
  $('imgIdle').src = idlePose.croppedUrl;
  $('imgHiss').src = hissPose.croppedUrl;
  scale = clampScale(Number(settings.scale) || 1);
  layoutAll();
  tickClock();
  setInterval(tickClock, 1000);
  // 有下一次闹钟时，每 12 秒自动弹出一次倒计时（4.6 秒后自动隐藏），平时也能看到定时内容
  setInterval(() => showCountdown(), 12000);
}

init().catch((err) => console.error('init failed', err));
