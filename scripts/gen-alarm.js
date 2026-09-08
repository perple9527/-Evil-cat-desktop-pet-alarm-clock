const fs = require('fs');
const path = require('path');

const SR = 44100;
const DUR = 4.0;
const n = Math.floor(SR * DUR);
const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25, 523.25, 659.25];
const SPACING = 0.45;
const TAIL = 0.62;

const samples = new Float64Array(n);

function addNote(f, startSec) {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(TAIL * SR);
  for (let i = 0; i < len && start + i < n; i++) {
    const t = i / SR;
    const body = Math.exp(-t / 0.55);
    const h2 = Math.exp(-t / 0.25);
    const h3 = Math.exp(-t / 0.18);
    const v = Math.sin(2 * Math.PI * f * t)
      + 0.45 * Math.sin(2 * Math.PI * f * 2.01 * t) * h2
      + 0.25 * Math.sin(2 * Math.PI * f * 2.73 * t) * h3;
    samples[start + i] += v * body * 0.28;
  }
}

notes.forEach((f, i) => addNote(f, i * SPACING));

const buf = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  let v = samples[i];
  if (v > 1) v = 1;
  if (v < -1) v = -1;
  buf.writeInt16LE(Math.round(v * 32767), i * 2);
}

const fade = Math.floor(SR * 0.06);
for (let i = 0; i < fade; i++) {
  const g = i / fade;
  buf.writeInt16LE(Math.round(buf.readInt16LE(i * 2) * g), i * 2);
  buf.writeInt16LE(Math.round(buf.readInt16LE((n - 1 - i) * 2) * g), (n - 1 - i) * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + n * 2, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(n * 2, 40);

fs.writeFileSync(path.join(__dirname, '..', 'assets', 'alarm.wav'), Buffer.concat([header, buf]));
console.log('assets/alarm.wav generated');
