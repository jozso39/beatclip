// Writes demo/audio/click.wav: twelve seconds of clicks on the demo's beat (first beat 0.5 s, then every 0.5 s).
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const RATE = 22050;
const SECONDS = 12;
const samples = new Int16Array(RATE * SECONDS);
for (let beat = 0; 0.5 + beat * 0.5 < SECONDS; beat++) {
  const start = Math.round((0.5 + beat * 0.5) * RATE);
  const pitch = beat % 4 === 0 ? 1320 : 880;
  for (let i = 0; i < RATE * 0.08; i++) samples[start + i] = Math.round(26000 * Math.exp(-i / (RATE * 0.015)) * Math.sin((2 * Math.PI * pitch * i) / RATE));
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + samples.byteLength, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(samples.byteLength, 40);
const out = resolve(import.meta.dir, "audio", "click.wav");
mkdirSync(resolve(import.meta.dir, "audio"), { recursive: true });
writeFileSync(out, Buffer.concat([header, Buffer.from(samples.buffer)]));
console.log(out);
