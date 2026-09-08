const $ = (id) => document.getElementById(id);

(async () => {
  const assets = await api.getAssets();
  const alarm = await api.getRingingAlarm();
  const musicUrl = await api.getAlarmMusicUrl();
  const baseVolume = ((alarm && alarm.volume) ?? 90) / 100;
  const snoozeMin = [5, 10, 15, 30].includes(alarm && alarm.snoozeMin) ? alarm.snoozeMin : 5;
  const ramp = (alarm && alarm.ramp) || { enabled: true, seconds: 60 };
  const challenge = (alarm && alarm.challenge) || { enabled: false, slaps: 5 };

  $('alarmTimeLabel').textContent = `闹钟时间 ${alarm && alarm.time ? alarm.time : '--:--'}`;
  const purpose = ((alarm && alarm.purpose) || '').trim();
  if (purpose) {
    $('purpose').textContent = `该做：${purpose}`;
    $('purpose').classList.remove('hidden');
  }

  $('catIdle').src = assets.idle;
  $('catHiss').src = assets.hiss;

  setInterval(() => {
    $('catIdle').classList.toggle('hidden');
    $('catHiss').classList.toggle('hidden');
  }, 2000);

  function tick() {
    const d = new Date();
    $('timeBig').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    $('sec').textContent = String(d.getSeconds()).padStart(2, '0');
  }
  tick();
  setInterval(tick, 1000);

  const audio = new Audio(musicUrl);
  audio.loop = true;
  if (ramp.enabled) {
    const startVol = Math.max(0.05, baseVolume * 0.15);
    const rampMs = Math.min(300000, Math.max(10000, ramp.seconds * 1000));
    const step = 250;
    audio.volume = startVol;
    let t = 0;
    setInterval(() => {
      t += step;
      if (t >= rampMs) {
        audio.volume = baseVolume;
        return;
      }
      audio.volume = Math.min(baseVolume, startVol + (baseVolume - startVol) * (t / rampMs));
    }, step);
  } else {
    audio.volume = baseVolume;
  }
  audio.play().catch(() => {});

  const hissAudio = new Audio(assets.hissAudio);
  hissAudio.volume = 1.0;
  // 只在"拍打挑战"时播放哈气声；闹钟显示期间只要音乐，不循环哈气
  function playHiss() {
    try {
      hissAudio.currentTime = 0;
      const p = hissAudio.play();
      if (p) p.catch(() => {});
    } catch (e) {}
  }

  let slapsLeft = challenge.enabled ? challenge.slaps : 0;
  const totalSlaps = slapsLeft;

  function updateChallengeUI() {
    $('slapsLeft').textContent = String(slapsLeft);
    $('chFill').style.width = `${totalSlaps ? ((totalSlaps - slapsLeft) / totalSlaps) * 100 : 0}%`;
    if (slapsLeft <= 0) {
      $('chInfo').innerHTML = '挑战完成！现在可以停止闹钟';
      $('chInfo').classList.add('chDone');
      $('btnStop').disabled = false;
      $('btnStop').classList.add('ready');
      $('btnClose').classList.remove('locked');
      $('catBox').classList.remove('slappable');
    }
  }

  if (challenge.enabled && slapsLeft > 0) {
    $('challengeBox').classList.remove('hidden');
    $('btnStop').disabled = true;
    $('btnClose').classList.add('locked');
    $('catBox').classList.add('slappable');
    updateChallengeUI();
  }

  function slap() {
    if (slapsLeft <= 0) return;
    slapsLeft -= 1;
    playHiss();
    const box = $('catBox');
    box.classList.remove('slap');
    void box.offsetWidth;
    box.classList.add('slap');
    updateChallengeUI();
  }

  $('catBox').addEventListener('pointerdown', (e) => {
    if (challenge.enabled) {
      e.stopPropagation();
      slap();
    }
  });

  $('btnSnooze').textContent = `稍后提醒（${snoozeMin} 分钟）`;
  $('btnStop').onclick = () => api.stopAlarm();
  $('btnSnooze').onclick = () => api.snoozeAlarm();
  $('btnClose').onclick = () => {
    if (slapsLeft > 0) return;
    api.stopAlarm();
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && slapsLeft <= 0) api.stopAlarm();
  });
})();
