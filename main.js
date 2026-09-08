const { app, BrowserWindow, ipcMain, Menu, dialog, screen, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.maodie.cathissalarm');

if (!app.requestSingleInstanceLock()) {
  // 已有实例在运行：直接结束本进程（app.quit() 在 ready 前可能不生效，导致重复开猫/托盘）
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.show();
    }
  });
}

const ASSETS = path.join(__dirname, 'assets');
const asset = (name) => path.join(ASSETS, name);
const assetUrl = (name) => pathToFileURL(asset(name)).href;

const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

function libraryDir() {
  const d = path.join(app.getPath('userData'), 'library');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function listLibrary() {
  return fs
    .readdirSync(libraryDir())
    .filter((f) => AUDIO_EXTS.includes(path.extname(f).toLowerCase()))
    .map((f) => ({ name: f, url: pathToFileURL(path.join(libraryDir(), f)).href }));
}

function copyIntoLibrary(srcPath) {
  const name = path.basename(srcPath);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let dest = path.join(libraryDir(), name);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(libraryDir(), `${base} (${i})${ext}`);
    i++;
  }
  fs.copyFileSync(srcPath, dest);
  return path.basename(dest);
}

const DEFAULT_ALARM = {
  id: null,
  enabled: false,
  time: '08:00',
  purpose: '',
  repeat: 'daily',
  weekdays: [1, 2, 3, 4, 5],
  music: 'builtin',
  musicName: null,
  volume: 90,
  snoozeMin: 5,
  ramp: { enabled: true, seconds: 60 },
  challenge: { enabled: false, slaps: 5 },
};

const DEFAULT_SETTINGS = {
  scale: 1,
  winPos: null,
  autoStart: false,
  alarms: [],
};

function sanitizeAlarm(raw) {
  const a = { ...DEFAULT_ALARM, ...(raw && typeof raw === 'object' ? raw : {}) };
  a.id = typeof a.id === 'string' && a.id ? a.id : `alarm_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  a.time = /^\d{2}:\d{2}$/.test(a.time) ? a.time : '08:00';
  a.purpose = String(a.purpose || '').slice(0, 20);
  a.repeat = ['daily', 'once', 'weekly'].includes(a.repeat) ? a.repeat : 'daily';
  const wd = Array.isArray(a.weekdays)
    ? a.weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).slice(0, 7)
    : [1, 2, 3, 4, 5];
  a.weekdays = wd.length ? wd : [1, 2, 3, 4, 5];
  if (a.music === 'library' && a.musicName) {
    a.musicName = path.basename(a.musicName);
  } else {
    a.music = 'builtin';
    a.musicName = null;
  }
  a.musicPath = undefined;
  const vol = Number(a.volume);
  a.volume = Number.isFinite(vol) ? Math.min(100, Math.max(0, Math.round(vol))) : 90;
  const sm = Number(a.snoozeMin);
  a.snoozeMin = [5, 10, 15, 30].includes(sm) ? sm : 5;
  a.ramp = { ...DEFAULT_ALARM.ramp, ...(a.ramp || {}) };
  a.ramp.enabled = !!a.ramp.enabled;
  const rsec = Number(a.ramp.seconds);
  a.ramp.seconds = Number.isFinite(rsec) ? Math.min(300, Math.max(10, Math.round(rsec))) : 60;
  a.challenge = { ...DEFAULT_ALARM.challenge, ...(a.challenge || {}) };
  a.challenge.enabled = !!a.challenge.enabled;
  const slaps = Number(a.challenge.slaps);
  a.challenge.slaps = Number.isFinite(slaps) ? Math.min(20, Math.max(1, Math.round(slaps))) : 5;
  return a;
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const s = JSON.parse(raw);
    const out = { ...DEFAULT_SETTINGS, ...s };
    let alarms = Array.isArray(s.alarms) ? s.alarms : [];
    if (!alarms.length && s.alarm && typeof s.alarm === 'object') {
      alarms = [{ ...s.alarm }];
    }
    out.alarms = alarms.map(sanitizeAlarm);
    for (const a of out.alarms) {
      if (a.music === 'library' && a.musicName && !fs.existsSync(path.join(libraryDir(), a.musicName))) {
        a.music = 'builtin';
        a.musicName = null;
      }
    }
    delete out.alarm;
    return out;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

let settings = loadSettings();
let petWin = null;
let alarmWin = null;
let settingsWin = null;
let ringingAlarmId = null;
let snoozeUntil = {};
let firedToday = {};

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('save settings failed', e);
  }
}

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function weekdayOf(d) {
  return (d.getDay() + 6) % 7 + 1;
}

function nextOccurrence(a, now = new Date()) {
  const [h, m] = a.time.split(':').map(Number);
  const cand = new Date(now);
  cand.setHours(h, m, 0, 0);
  if (a.repeat === 'weekly') {
    const days = a.weekdays.slice().sort((x, y) => x - y);
    for (let step = 0; step < 7; step++) {
      const t = new Date(cand.getTime() + step * 86400000);
      if (days.includes(weekdayOf(t)) && t.getTime() > now.getTime()) return t;
    }
    return null;
  }
  if (cand.getTime() <= now.getTime()) {
    if (a.repeat === 'once') return null;
    cand.setDate(cand.getDate() + 1);
  }
  return cand;
}

function ringingAlarm() {
  if (!ringingAlarmId) return null;
  return settings.alarms.find((a) => a.id === ringingAlarmId) || null;
}

function alarmState() {
  let next = null;
  for (const a of settings.alarms) {
    if (!a.enabled) continue;
    let t = snoozeUntil[a.id];
    if (!t) {
      const occ = nextOccurrence(a);
      t = occ ? occ.getTime() : null;
    }
    if (t && (!next || t < next.at)) next = { at: t, time: a.time, purpose: a.purpose };
  }
  const ring = ringingAlarm();
  return {
    ringing: !!ring,
    alarm: ring ? { time: ring.time, purpose: ring.purpose } : null,
    next,
    count: settings.alarms.filter((a) => a.enabled).length,
  };
}

let lastStateJson = '';
function broadcastState() {
  if (!petWin || petWin.isDestroyed()) return;
  const st = alarmState();
  const js = JSON.stringify(st);
  if (js === lastStateJson) return;
  lastStateJson = js;
  petWin.webContents.send('alarm:state', st);
}

function alarmMatchesNow(a, now) {
  const [h, m] = a.time.split(':').map(Number);
  if (now.getHours() !== h || now.getMinutes() !== m) return false;
  if (a.repeat === 'weekly' && !(a.weekdays || []).includes(weekdayOf(now))) return false;
  return true;
}

function dueAlarms() {
  const now = new Date();
  const out = [];
  for (const a of settings.alarms) {
    if (!a.enabled) continue;
    const snoozeAt = snoozeUntil[a.id];
    if (snoozeAt) {
      if (now.getTime() >= snoozeAt) {
        delete snoozeUntil[a.id];
        out.push(a);
      }
      continue;
    }
    if (alarmMatchesNow(a, now) && firedToday[a.id] !== dateKey()) out.push(a);
  }
  return out;
}

function fireAlarm(a) {
  if (ringingAlarmId || alarmWin) return;
  ringingAlarmId = a.id;
  firedToday[a.id] = dateKey();
  if (a.repeat === 'once') {
    a.enabled = false;
    saveSettings();
  }
  createAlarmWindow();
  broadcastState();
}

function createPetWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const defaultRight = wa.x + wa.width - 12;
  const defaultBottom = wa.y + wa.height - 12;
  let right = settings.winPos ? Number(settings.winPos.right) : defaultRight;
  let bottom = settings.winPos ? Number(settings.winPos.bottom) : defaultBottom;
  if (!right || !bottom) {
    right = defaultRight;
    bottom = defaultBottom;
  }
  right = Math.min(Math.max(right, wa.x + 60), wa.x + wa.width - 12);
  bottom = Math.min(Math.max(bottom, wa.y + 60), wa.y + wa.height - 12);
  petWin = new BrowserWindow({
    width: 320,
    height: 430,
    x: Math.round(right - 320),
    y: Math.round(bottom - 430),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setMenuBarVisibility(false);
  petWin.loadFile('index.html');
  petWin.webContents.on('console-message', (_e, _l, msg) => console.log('[pet]', msg));
  petWin.webContents.on('did-finish-load', () => broadcastState());
  petWin.on('closed', () => { petWin = null; });
}

function createAlarmWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 480;
  const h = 420;
  alarmWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  alarmWin.setAlwaysOnTop(true, 'screen-saver');
  alarmWin.loadFile('alarm.html');
  alarmWin.webContents.on('console-message', (_e, _l, msg) => console.log('[alarm]', msg));
  alarmWin.on('closed', () => {
    alarmWin = null;
    ringingAlarmId = null;
    broadcastState();
  });
}

function createSettingsWindow() {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 420;
  const h = 800;
  settingsWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.loadFile('settings.html');
  settingsWin.webContents.on('console-message', (_e, _l, msg) => console.log('[settings]', msg));
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('settings:get', () => settings);

function togglePet() {
  if (!petWin || petWin.isDestroyed()) {
    createPetWindow();
    return;
  }
  if (petWin.isVisible()) petWin.hide();
  else petWin.show();
}

let tray = null;

function buildTrayMenu() {
  const petVisible = !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
  return Menu.buildFromTemplate([
    { label: petVisible ? '隐藏猫咪' : '显示猫咪', click: () => togglePet() },
    { label: '设置闹钟…', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

// 内置兜底托盘图标（16×16 橙色猫头 PNG）：两个素材 PNG 都加载失败时使用，防止托盘图标静默消失
const FALLBACK_TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAR0lEQVR4nGNgGFTg/9qE/8iYWDmsCojBw80AUg0hGAtuuiL/8fEJaoZhbHyiDSHJBbjCAF0jbQ0gNiZwaibGEIKasRmGTx4ACxGnDzjLdawAAAAASUVORK5CYII=';

function loadTrayIcon() {
  // Windows 托盘建议使用 ICO（含多尺寸）；PNG 在部分系统上缩放后会显示空白甚至看不到
  const candidates = [asset('tray.ico'), asset('图标.png'), path.join(__dirname, 'build', 'icon.png')];
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) continue;
    // ICO 自带多尺寸直接使用；PNG 则缩放到 16×16
    return path.extname(p).toLowerCase() === '.ico' ? img : img.resize({ width: 16, height: 16 });
  }
  console.error('[tray] 素材图标都加载失败，使用内置兜底图标');
  return nativeImage.createFromDataURL(FALLBACK_TRAY_ICON);
}

function createTray() {
  let img = loadTrayIcon();
  if (img.isEmpty()) img = nativeImage.createFromDataURL(FALLBACK_TRAY_ICON);
  try {
    tray = new Tray(img);
  } catch (err) {
    console.error('[tray] 托盘创建失败:', err);
    return;
  }
  tray.setToolTip('猫咪哈气闹钟');
  tray.on('click', () => togglePet());
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  // 创建结果日志，便于排查"托盘没图标"的问题（Win11 可能收在任务栏“^”溢出区）
  console.log('[tray] 托盘图标已创建, 图标尺寸:', JSON.stringify(img.getSize()), '空图:', img.isEmpty());
}

ipcMain.handle('settings:getAutoStart', () => settings.autoStart);

ipcMain.handle('settings:setAutoStart', (e, v) => {
  settings.autoStart = !!v;
  saveSettings();
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!v });
  }
  return settings.autoStart;
});

ipcMain.handle('settings:save', (e, s) => {
  let alarms = Array.isArray(s && s.alarms) ? s.alarms.map(sanitizeAlarm) : settings.alarms;
  const seen = new Set();
  alarms = alarms.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  const next = {
    ...settings,
    scale: Math.max(0.4, Number(s && s.scale) || 1),
    alarms,
  };
  settings = next;
  saveSettings();
  const liveIds = new Set(alarms.filter((a) => a.enabled).map((a) => a.id));
  for (const id of Object.keys(firedToday)) {
    if (!liveIds.has(id)) delete firedToday[id];
  }
  for (const id of Object.keys(snoozeUntil)) {
    if (!liveIds.has(id)) delete snoozeUntil[id];
  }
  if (!settings.alarms.some((a) => a.id === ringingAlarmId)) {
    if (alarmWin) alarmWin.close();
    ringingAlarmId = null;
  }
  broadcastState();
  // 设置窗口改过缩放后，实时同步给宠物窗口（原来要重启才生效）
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('scale:changed', settings.scale);
  }
  return true;
});

ipcMain.handle('settings:scale', (e, scale) => {
  settings.scale = Math.max(0.4, Number(scale) || 1);
  saveSettings();
  return settings.scale;
});

ipcMain.handle('settings:pos', (e, { right, bottom }) => {
  settings.winPos = { right: Number(right), bottom: Number(bottom) };
  saveSettings();
  return true;
});

ipcMain.handle('asset:paths', () => ({
  idle: assetUrl('等待.png'),
  hiss: assetUrl('哈气.png'),
  hissAudio: assetUrl('哈气音频.mp3'),
  icon: assetUrl('图标.png'),
  alarm: assetUrl('alarm.wav'),
}));

ipcMain.handle('alarm:music-url', (e, id) => {
  const a = id ? settings.alarms.find((x) => x.id === id) : ringingAlarm();
  if (a && a.music === 'library' && a.musicName) {
    const p = path.join(libraryDir(), path.basename(a.musicName));
    if (fs.existsSync(p)) return pathToFileURL(p).href;
  }
  return assetUrl('alarm.wav');
});

ipcMain.handle('alarm:ringing', () => {
  const a = ringingAlarm();
  return a
    ? {
        time: a.time,
        purpose: a.purpose,
        volume: a.volume,
        snoozeMin: a.snoozeMin,
        ramp: a.ramp,
        challenge: a.challenge,
      }
    : null;
});

ipcMain.handle('music:library', () => listLibrary());

ipcMain.handle('music:import', async () => {
  const r = await dialog.showOpenDialog({
    filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  try {
    const name = copyIntoLibrary(r.filePaths[0]);
    return { name, url: pathToFileURL(path.join(libraryDir(), name)).href };
  } catch (err) {
    console.error('import music failed', err);
    return null;
  }
});

ipcMain.handle('music:delete', (e, name) => {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  const p = path.join(libraryDir(), name);
  if (!fs.existsSync(p)) return false;
  try {
    fs.unlinkSync(p);
    let changed = false;
    for (const a of settings.alarms) {
      if (a.musicName === name) {
        a.musicName = null;
        a.music = 'builtin';
        changed = true;
      }
    }
    if (changed) saveSettings();
    return true;
  } catch (err) {
    return false;
  }
});

function sanitizeMusicName(name) {
  return String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .slice(0, 80);
}

ipcMain.handle('music:rename', (e, { oldName, newName }) => {
  const safeOld = path.basename(String(oldName || ''));
  if (!safeOld || safeOld.includes('..')) return null;
  const src = path.join(libraryDir(), safeOld);
  if (!fs.existsSync(src)) return null;
  const ext = path.extname(safeOld);
  const base = sanitizeMusicName(path.basename(String(newName || ''), ext));
  if (!base) return null;
  if (base + ext === safeOld) {
    return { name: safeOld, url: pathToFileURL(src).href };
  }
  let destName = base + ext;
  let dest = path.join(libraryDir(), destName);
  let i = 1;
  while (fs.existsSync(dest)) {
    destName = `${base} (${i})${ext}`;
    dest = path.join(libraryDir(), destName);
    i++;
  }
  try {
    fs.renameSync(src, dest);
    let changed = false;
    for (const a of settings.alarms) {
      if (a.musicName === safeOld) {
        a.musicName = destName;
        changed = true;
      }
    }
    if (changed) saveSettings();
    return { name: destName, url: pathToFileURL(dest).href };
  } catch (err) {
    console.error('rename music failed', err);
    return null;
  }
});

ipcMain.on('win:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.close();
});

ipcMain.handle('win:workarea', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return screen.getPrimaryDisplay().workArea;
  return screen.getDisplayMatching(win.getBounds()).workArea;
});

ipcMain.handle('win:bounds', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? win.getBounds() : null;
});

ipcMain.on('win:resize', (e, { width, height }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea; // 窗口当前所在屏幕的工作区
  const w = Math.min(Math.round(width), wa.width);
  const h = Math.min(Math.round(height), wa.height);
  // 以窗口中心为锚缩放：中心不动、向四周均匀变化（从中间放大，而不是只从左上角一侧变化）
  let x = Math.round(b.x + b.width / 2 - w / 2);
  let y = Math.round(b.y + b.height / 2 - h / 2);
  // 钳制在工作区内，保证缩放时窗口不会超出屏幕范围
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - w);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
  win.setBounds({ x, y, width: w, height: h });
});

ipcMain.on('win:move', (e, { x, y }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const b = win.getBounds();
  const nx = Math.round(Number(x));
  const ny = Math.round(Number(y));
  // 按目标位置所属屏幕钳制，拖动窗口时也不能超出屏幕工作区
  const wa = screen.getDisplayMatching({ x: nx, y: ny, width: b.width, height: b.height }).workArea;
  const cx = Math.min(Math.max(nx, wa.x), wa.x + Math.max(0, wa.width - b.width));
  const cy = Math.min(Math.max(ny, wa.y), wa.y + Math.max(0, wa.height - b.height));
  // 用 setBounds 显式带上当前尺寸：Windows 上 setPosition 会让无边框窗口每次长高 1px（累积变大）
  win.setBounds({ x: cx, y: cy, width: b.width, height: b.height });
});

// 拖拽跟随：主进程每 16ms 读系统光标位置移动窗口，光标始终贴在按下点，
// 快速移动也不会因渲染进程事件滞后而"脱轨"（渲染进程只负责开始/结束与心跳）
let dragFollow = null;

function stopDragFollow() {
  if (dragFollow) {
    clearInterval(dragFollow.timer);
    dragFollow = null;
  }
}

ipcMain.on('drag:start', (e, { offX, offY }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  stopDragFollow();
  const b = win.getBounds();
  const ox = Math.min(Math.max(Number(offX) || 0, 0), b.width - 1);
  const oy = Math.min(Math.max(Number(offY) || 0, 0), b.height - 1);
  dragFollow = {
    win,
    ox,
    oy,
    w: b.width,
    h: b.height, // 尺寸在拖动开始时固定：每 tick 重读 bounds 会因 DIP 取整慢慢变大
    lastBeat: Date.now(),
    timer: setInterval(() => {
      const d = dragFollow;
      if (!d || d.win.isDestroyed()) {
        stopDragFollow();
        return;
      }
      // 心跳超过 2 秒说明渲染进程已结束拖动（松手/失焦），停止跟随防止窗口粘着光标
      if (Date.now() - d.lastBeat > 2000) {
        stopDragFollow();
        return;
      }
      const p = screen.getCursorScreenPoint();
      // 以"光标 - 抓取偏移"作为窗口新左上角，并钳制在工作区内
      const wa = screen.getDisplayMatching({ x: p.x - d.ox, y: p.y - d.oy, width: d.w, height: d.h }).workArea;
      const x = Math.min(Math.max(Math.round(p.x - d.ox), wa.x), wa.x + Math.max(0, wa.width - d.w));
      const y = Math.min(Math.max(Math.round(p.y - d.oy), wa.y), wa.y + Math.max(0, wa.height - d.h));
      d.win.setBounds({ x, y, width: d.w, height: d.h });
    }, 16),
  };
});

ipcMain.on('drag:beat', () => {
  if (dragFollow) dragFollow.lastBeat = Date.now();
});

ipcMain.on('drag:end', () => stopDragFollow());

ipcMain.on('hit:ignore', (e, ignore) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  try {
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
  } catch (err) {
    console.error(err);
  }
});

ipcMain.on('menu:open', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    { label: '设置闹钟…', click: () => createSettingsWindow() },
    { label: '隐藏猫咪', click: () => {
      if (win && !win.isDestroyed()) win.hide();
    } },
    { label: '重置大小', click: () => { settings.scale = 1; saveSettings(); win.webContents.send('scale:reset'); } },
    { label: '重置位置', click: () => {
      settings.winPos = null;
      saveSettings();
      const wa = screen.getPrimaryDisplay().workArea;
      const b = win.getBounds();
      win.setBounds({
        x: wa.x + wa.width - b.width - 12,
        y: wa.y + wa.height - b.height - 12,
        width: b.width,
        height: b.height,
      });
    } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  menu.popup({ window: win });
});

ipcMain.on('alarm:stop', () => {
  if (alarmWin) alarmWin.close();
  ringingAlarmId = null;
  broadcastState();
});

ipcMain.on('alarm:snooze', () => {
  const a = ringingAlarm();
  if (a) snoozeUntil[a.id] = Date.now() + (a.snoozeMin || 5) * 60 * 1000;
  if (alarmWin) alarmWin.close();
  ringingAlarmId = null;
  broadcastState();
});

setInterval(() => {
  if (app.isReady()) {
    if (!alarmWin) {
      const due = dueAlarms();
      if (due.length) fireAlarm(due[0]);
    }
    broadcastState();
  }
}, 1000);

app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  createPetWindow();
  createTray();
});
