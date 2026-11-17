// Generator nada WAV untuk harness spike S3/S5/S9 Laras Web.
//
// Nada sinus murni dipakai sebagai kontrol positif: file lokal same-origin
// yang PASTI bisa diputar, sehingga kegagalan pada jalur googlevideo bisa
// dibedakan dari kegagalan mekanisme pemutar itu sendiri.
//
// Jalankan sekali:  node fixtures/generate-tones.mjs
// Output: tone-10s.wav (nada 440 Hz, 10 detik) dan tone-60s.wav
// (nada 440 Hz, 60 detik), 8 kHz mono 16-bit PCM.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

function makeWav(seconds, freq = 440, rate = 8000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

for (const seconds of [10, 60]) {
  const path = join(dir, `tone-${seconds}s.wav`);
  writeFileSync(path, makeWav(seconds));
  console.log(`tulis ${path} (${44 + seconds * 8000 * 2} byte)`);
}
