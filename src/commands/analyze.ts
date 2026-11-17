import { existsSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { Args } from "../args";
import type { Config } from "../config";
import { run } from "../ffmpeg";
import { CliError, fmtTime } from "../time";
import type { Result } from "./lookup";

const BEATS_PY = `
import sys, json
import numpy as np, librosa
y, sr = librosa.load(sys.argv[1], sr=None, mono=True)
tempo, frames = librosa.beat.beat_track(y=y, sr=sr)
times = librosa.frames_to_time(frames, sr=sr)
json.dump({"tempo": float(np.atleast_1d(tempo)[0]), "beats": [round(float(t), 4) for t in times]}, sys.stdout)
`;

/** The constant grid closest to measured beats: a least-squares line through (beat number, time). */
export function fitGrid(beats: number[]): { first: number; interval: number; worst: number } {
  const n = beats.length;
  const meanI = (n - 1) / 2;
  const meanT = beats.reduce((a, b) => a + b, 0) / n;
  const interval = beats.reduce((sum, t, i) => sum + (i - meanI) * (t - meanT), 0) / beats.reduce((sum, _, i) => sum + (i - meanI) ** 2, 0);
  const first = meanT - interval * meanI;
  return { first, interval, worst: Math.max(...beats.map((t, i) => Math.abs(t - (first + i * interval)))) };
}

/**
 * `analyze beats [audio]`: tracks the beats of an audio file with librosa and writes a beats file.
 * Needs a Python with librosa (--python, or "python" in the config); nothing else in beatclip needs Python.
 */
export async function analyze(cfg: Config | null, args: Args, cwd: string): Promise<Result> {
  const what = args.take("what to analyze (beatclip analyze beats <audio>)");
  if (what !== "beats") throw new CliError(`cannot analyze "${what}" (only: beats)`);
  const audio = args.rest[0] ? resolve(cwd, args.rest[0]) : cfg?.audio;
  if (!audio) throw new CliError("missing the audio file (beatclip analyze beats <audio>)");
  if (!existsSync(audio)) throw new CliError(`no such audio file: ${audio}`);
  const python = args.str("python") ?? cfg?.python ?? "python3";
  const configured = cfg && "file" in cfg.beats ? cfg.beats.file : undefined;
  const out = args.str("out") ? resolve(cwd, args.str("out")!) : (configured ?? resolve(cfg?.root ?? cwd, `${basename(audio, extname(audio))}.beats.json`));

  const r = await run([python, "-c", BEATS_PY, audio]);
  if (r.code !== 0) {
    const last = r.stderr.trim().split("\n").at(-1);
    throw new CliError(`beat tracking failed with ${python}: ${last}${/No module named/.test(r.stderr) ? " (install librosa into that Python, or pass --python <path>)" : ""}`);
  }
  const { tempo, beats } = JSON.parse(r.stdout) as { tempo: number; beats: number[] };
  if (beats.length < 2) throw new CliError(`librosa found ${beats.length} beats in ${audio}; not enough for a grid`);

  const g = fitGrid(beats);
  const fit = { first: Math.round(g.first * 1000) / 1000, interval: Math.round(g.interval * 10000) / 10000, worstMs: Math.round(g.worst * 1000) };

  writeFileSync(out, JSON.stringify({ source: basename(audio), tempo: Math.round(tempo * 100) / 100, beats }, null, 1));
  return {
    data: { file: out, tempo, beats: beats.length, firstBeat: beats[0], lastBeat: beats.at(-1), constantFit: fit },
    text: [
      `${beats.length} beats, ${tempo.toFixed(1)} BPM, first at ${fmtTime(beats[0])}, last at ${fmtTime(beats.at(-1)!)}`,
      `constant grid that fits best: first ${fit.first} s, interval ${fit.interval} s; the worst beat is ${fit.worstMs} ms off it`,
      `wrote ${out}`,
      `use it with  "beats": { "file": "<path to it>" }  in the config`,
    ].join("\n"),
  };
}
