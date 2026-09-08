const $ = (id) => document.getElementById(id);

const WD_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

function newAlarm() {
  return {
    id: `alarm_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    enabled: true,
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
}

(async () => {
const assets = await api.getAssets();
const s = await api.getSettings();

let alarms = (s.alarms && s.alarms.length ? s.alarms : [newAlarm()]).map((a) => ({
  ...a,
  weekdays: Array.isArray(a.weekdays) ? [...a.weekdays] : [1, 2, 3, 4, 5],
  ramp: { enabled: true, seconds: 60, ...(a.ramp || {}) },
  challenge: { enabled: false, slaps: 5, ...(a.challenge || {}) },
}));
let selectedId = alarms[0] ? alarms[0].id : null;

let library = [];
let durations = {};
let testAudio = null;
let nowPlaying = null;
let previewKey = null;

$('headerIcon').src = assets.icon;
const petScaleVal = Math.min(350, Math.max(45, Math.round((s.scale || 1) * 100)));
$('petScale').value = petScaleVal;
$('petScaleVal').textContent = `${petScaleVal}%`;
$('autoStart').checked = await api.getAutoStart();

const selected = () => alarms.find((a) => a.id === selectedId) || null;

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function repeatSummary(a) {
  if (a.repeat === 'weekly') {
    const wd = [...(a.weekdays || [])].filter((d) => d >= 1 && d <= 7).sort((x, y) => x - y);
    if (!wd.length) return '未选星期';
    if (wd.length === 7) return '每天';
    return '周' + wd.map((d) => WD_NAMES[d - 1]).join('、');
  }
  return a.repeat === 'once' ? '仅一次' : '每天';
}

function renderAlarmList() {
  const list = $('alarmList');
  list.innerHTML = '';
  if (!alarms.length) {
    const empty = document.createElement('div');
    empty.className = 'emptyAlarms';
    empty.textContent = '还没有闹钟，点击下方按钮新增';
    list.appendChild(empty);
    return;
  }
  alarms.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'alarmRow' + (a.id === selectedId ? ' selected' : '') + (a.enabled ? '' : ' off');

    const sw = document.createElement('label');
    sw.className = 'switch small';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = a.enabled;
    cb.addEventListener('click', (ev) => ev.stopPropagation());
    cb.addEventListener('change', () => {
      a.enabled = cb.checked;
      renderAlarmList();
    });
    const slider = document.createElement('span');
    slider.className = 'slider';
    sw.appendChild(cb);
    sw.appendChild(slider);

    const info = document.createElement('div');
    info.className = 'info';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = a.time || '08:00';
    const sub = document.createElement('div');
    sub.className = 's';
    sub.textContent = repeatSummary(a) + ((a.purpose || '').trim() ? ` · ${a.purpose.trim()}` : '');
    info.appendChild(t);
    info.appendChild(sub);

    const del = document.createElement('button');
    del.className = 'delBtn';
    del.textContent = '✕';
    del.title = '删除闹钟';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = alarms.findIndex((x) => x.id === a.id);
      if (idx < 0) return;
      alarms.splice(idx, 1);
      if (selectedId === a.id) {
        selectedId = alarms.length ? alarms[0].id : null;
        fillEditor();
      }
      renderAlarmList();
    });

    row.addEventListener('click', () => {
      if (selectedId === a.id) return;
      selectedId = a.id;
      renderAlarmList();
      fillEditor();
    });

    row.appendChild(sw);
    row.appendChild(info);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function currentMusicMode() {
  return document.querySelector('input[name="music"]:checked').value;
}

function refreshLibraryPanel() {
  $('libPanel').classList.toggle('hidden', currentMusicMode() !== 'library');
  renderLibrary();
}

function stopAudio() {
  if (testAudio) {
    try { testAudio.pause(); } catch (e) {}
    testAudio = null;
  }
  nowPlaying = null;
  previewKey = null;
  updatePlayButtons();
  $('btnPreview').classList.remove('playing');
  $('btnPreview').textContent = '▶ 试听当前铃声';
}

function playUrl(url, key) {
  if (nowPlaying === key) {
    stopAudio();
    return;
  }
  stopAudio();
  testAudio = new Audio(url);
  testAudio.volume = Number($('volume').value || 90) / 100;
  testAudio.onended = () => { stopAudio(); };
  testAudio.play().then(() => {
    nowPlaying = key;
    previewKey = key === 'current' ? key : null;
    updatePlayButtons();
    if (key === 'current') {
      $('btnPreview').classList.add('playing');
      $('btnPreview').textContent = '⏸ 停止试听';
    }
  }).catch(() => {
    stopAudio();
  });
}

function updatePlayButtons() {
  document.querySelectorAll('.libBtn.play').forEach((b) => {
    b.textContent = b.dataset.name === nowPlaying ? '⏸' : '▶';
    b.classList.toggle('playing', b.dataset.name === nowPlaying);
  });
}

function fmtDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const ss = Math.floor(sec % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

async function getDuration(url) {
  if (durations[url]) return durations[url];
  const d = await new Promise((res) => {
    const au = new Audio();
    const done = (v) => { au.src = ''; res(v); };
    au.onloadedmetadata = () => done(au.duration);
    au.onerror = () => done(null);
    au.src = url;
    setTimeout(() => done(null), 4000);
  });
  durations[url] = d || null;
  return durations[url];
}

function makeRow(item) {
  const a = selected();
  const isSelected = !!(a && a.musicName === item.name);
  const row = document.createElement('div');
  row.className = 'libRow' + (isSelected ? ' selected' : '');

  const name = document.createElement('span');
  name.className = 'libName';
  name.textContent = item.name;
  name.title = item.name;

  const dur = document.createElement('span');
  dur.className = 'libDur';
  getDuration(item.url).then((d) => {
    if (dur.isConnected) dur.textContent = fmtDuration(d);
  });

  const play = document.createElement('button');
  play.className = 'libBtn play';
  play.dataset.name = item.name;
  play.textContent = item.name === nowPlaying ? '⏸' : '▶';
  play.title = '试听';
  play.onclick = (ev) => {
    ev.stopPropagation();
    playUrl(item.url, item.name);
  };

  const rename = document.createElement('button');
  rename.className = 'libBtn';
  rename.textContent = '✎';
  rename.title = '重命名';
  rename.onclick = (ev) => {
    ev.stopPropagation();
    startRename(row, item);
  };

  const del = document.createElement('button');
  del.className = 'libBtn del';
  del.textContent = '✕';
  del.title = '从库中删除';
  del.onclick = async (ev) => {
    ev.stopPropagation();
    if (nowPlaying === item.name) stopAudio();
    const ok = await api.deleteMusic(item.name);
    if (!ok) return;
    library = await api.getMusicLibrary();
    for (const al of alarms) {
      if (al.musicName === item.name) {
        al.musicName = null;
        al.music = 'builtin';
      }
    }
    setRadio('music', selected() && selected().music === 'library' ? 'library' : 'builtin');
    refreshLibraryPanel();
  };

  row.onclick = () => {
    const al = selected();
    if (!al) return;
    al.music = 'library';
    al.musicName = item.name;
    setRadio('music', 'library');
    renderLibrary();
  };

  row.appendChild(name);
  if (isSelected) {
    const badge = document.createElement('span');
    badge.className = 'libBadge';
    badge.textContent = '当前铃声';
    row.appendChild(badge);
  }
  row.appendChild(dur);
  row.appendChild(play);
  row.appendChild(rename);
  row.appendChild(del);
  return row;
}

function startRename(row, item) {
  if (row.querySelector('.libNameInput')) return;
  const nameEl = row.querySelector('.libName');
  const ext = item.name.slice(item.name.lastIndexOf('.'));
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'libNameInput';
  input.maxLength = 80;
  input.value = item.name.slice(0, item.name.lastIndexOf('.'));
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async (cancel) => {
    if (done) return;
    done = true;
    if (cancel || !input.value.trim() || input.value.trim() + ext === item.name) {
      renderLibrary();
      return;
    }
    const res = await api.renameMusic(item.name, input.value.trim() + ext);
    library = await api.getMusicLibrary();
    if (res) {
      for (const al of alarms) {
        if (al.musicName === item.name) al.musicName = res.name;
      }
    }
    delete durations[item.url];
    renderLibrary();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') commit(false);
    if (ev.key === 'Escape') commit(true);
    ev.stopPropagation();
  });
  input.addEventListener('blur', () => commit(false));
}

function renderLibrary() {
  const list = $('musicList');
  list.innerHTML = '';
  if (!library.length) {
    const empty = document.createElement('div');
    empty.className = 'libEmpty';
    empty.textContent = '还没有导入的音频，点击下方按钮导入';
    list.appendChild(empty);
    return;
  }
  library.forEach((item) => list.appendChild(makeRow(item)));
}

function fillEditor() {
  const a = selected();
  $('editor').classList.toggle('hidden', !a);
  if (!a) return;
  $('time').value = a.time || '08:00';
  $('purpose').value = a.purpose || '';
  setRadio('repeat', a.repeat);
  const wd = a.weekdays || [];
  document.querySelectorAll('#weekdayChips input').forEach((cb) => {
    cb.checked = wd.includes(Number(cb.value));
  });
  $('weekdayRow').classList.toggle('hidden', a.repeat !== 'weekly');
  setRadio('music', a.music === 'library' ? 'library' : 'builtin');
  $('volume').value = a.volume ?? 90;
  $('volumeVal').textContent = `${a.volume ?? 90}%`;
  setRadio('snooze', String(a.snoozeMin || 5));
  $('rampEnabled').checked = !!a.ramp.enabled;
  setRadio('rampSeconds', String(a.ramp.seconds || 60));
  $('rampRow').classList.toggle('hidden', !a.ramp.enabled);
  $('challengeEnabled').checked = !!a.challenge.enabled;
  setRadio('challengeSlaps', String(a.challenge.slaps || 5));
  $('challengeRow').classList.toggle('hidden', !a.challenge.enabled);
  refreshLibraryPanel();
}

$('time').addEventListener('input', () => {
  const a = selected();
  if (!a) return;
  a.time = $('time').value || '08:00';
  renderAlarmList();
});

$('purpose').addEventListener('input', () => {
  const a = selected();
  if (!a) return;
  a.purpose = $('purpose').value;
  renderAlarmList();
});

document.querySelectorAll('input[name="repeat"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    const a = selected();
    if (!a) return;
    a.repeat = r.value;
    $('weekdayRow').classList.toggle('hidden', a.repeat !== 'weekly');
    renderAlarmList();
  });
});

document.querySelectorAll('#weekdayChips input').forEach((cb) => {
  cb.addEventListener('change', () => {
    const a = selected();
    if (!a) return;
    a.weekdays = [...document.querySelectorAll('#weekdayChips input')]
      .filter((x) => x.checked)
      .map((x) => Number(x.value))
      .sort((x, y) => x - y);
    renderAlarmList();
  });
});

document.querySelectorAll('input[name="music"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    const a = selected();
    if (!a) return;
    a.music = r.value;
    refreshLibraryPanel();
  });
});

$('volume').addEventListener('input', () => {
  const a = selected();
  $('volumeVal').textContent = `${$('volume').value}%`;
  if (a) a.volume = Number($('volume').value || 90);
  if (testAudio) testAudio.volume = Number($('volume').value || 90) / 100;
});

document.querySelectorAll('input[name="snooze"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    const a = selected();
    if (a) a.snoozeMin = Number(r.value);
  });
});

$('rampEnabled').addEventListener('change', () => {
  const a = selected();
  if (!a) return;
  a.ramp.enabled = $('rampEnabled').checked;
  $('rampRow').classList.toggle('hidden', !a.ramp.enabled);
});

document.querySelectorAll('input[name="rampSeconds"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    const a = selected();
    if (a) a.ramp.seconds = Number(r.value);
  });
});

$('challengeEnabled').addEventListener('change', () => {
  const a = selected();
  if (!a) return;
  a.challenge.enabled = $('challengeEnabled').checked;
  $('challengeRow').classList.toggle('hidden', !a.challenge.enabled);
});

document.querySelectorAll('input[name="challengeSlaps"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    const a = selected();
    if (a) a.challenge.slaps = Number(r.value);
  });
});

$('petScale').addEventListener('input', () => {
  $('petScaleVal').textContent = `${$('petScale').value}%`;
});

$('btnAdd').onclick = () => {
  const a = newAlarm();
  alarms.push(a);
  selectedId = a.id;
  renderAlarmList();
  fillEditor();
};

$('btnPreview').onclick = async () => {
  const a = selected();
  if (!a) return;
  let url = null;
  if (a.music === 'library' && a.musicName) {
    const item = library.find((i) => i.name === a.musicName);
    if (item) url = item.url;
  }
  if (!url) url = a.music === 'library' ? await api.getAlarmMusicUrl(a.id) : assets.alarm;
  playUrl(url, 'current');
};

$('btnImport').onclick = async () => {
  const res = await api.importMusic();
  if (res) {
    library = await api.getMusicLibrary();
    const a = selected();
    if (a) {
      a.music = 'library';
      a.musicName = res.name;
      setRadio('music', 'library');
    }
    refreshLibraryPanel();
  }
};

$('btnClose').onclick = () => api.closeWindow();
$('btnCancel').onclick = () => api.closeWindow();
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.closeWindow();
});

$('btnSave').onclick = async () => {
  stopAudio();
  await api.saveSettings({
    scale: Math.max(0.4, Number($('petScale').value || 100) / 100),
    alarms,
  });
  api.setAutoStart($('autoStart').checked);
  api.closeWindow();
};

library = await api.getMusicLibrary();
renderAlarmList();
fillEditor();
})();
