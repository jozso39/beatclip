import { existsSync, statSync } from "node:fs";
import { CliError } from "./time";

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program to the end and returns what it printed. A missing program is a CliError. */
export async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<Ran> {
  let proc;
  try {
    proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new CliError(`cannot run "${cmd[0]}": is it installed and on PATH?`);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** Like `run`, but a non-zero exit is an error carrying the program's last lines. */
export async function must(cmd: string[], what: string): Promise<Ran> {
  const r = await run(cmd);
  if (r.code !== 0) throw new CliError(`${what} failed (${cmd[0]} exit ${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return r;
}

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  frames: number;
}

export async function probeVideo(file: string): Promise<VideoInfo> {
  if (!existsSync(file)) throw new CliError(`no such video: ${file}`);
  const r = await must(
    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", file],
    `reading ${file}`,
  );
  const j = JSON.parse(r.stdout);
  const st = j.streams?.[0];
  if (!st) throw new CliError(`${file} has no video stream`);
  const [num, den] = String(st.r_frame_rate).split("/").map(Number);
  const fps = num / (den || 1);
  const duration = Number(j.format.duration);
  return { width: st.width, height: st.height, fps, duration, frames: Number(st.nb_frames) || Math.round(duration * fps) };
}

export async function probeDuration(file: string): Promise<number> {
  if (!existsSync(file)) throw new CliError(`no such file: ${file}`);
  const r = await must(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], `reading ${file}`);
  return Number(r.stdout.trim());
}

/** Writes the frame shown at time `t` of a video as a JPEG scaled to `width`. */
export async function grabFrame(video: string, info: VideoInfo, t: number, width: number, out: string): Promise<void> {
  const frame = Math.round(t * info.fps);
  if (frame < 0 || frame >= info.frames) throw new CliError(`${video} has no frame at ${t.toFixed(2)} s (it is ${info.duration.toFixed(2)} s long)`);
  // Seeking a hair before the frame's timestamp makes ffmpeg return exactly that frame.
  const at = Math.max(0, frame / info.fps - 0.25 / info.fps);
  await must(["ffmpeg", "-y", "-loglevel", "error", "-ss", at.toFixed(5), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", out], `reading a frame of ${video}`);
  if (!existsSync(out) || statSync(out).size === 0) throw new CliError(`ffmpeg wrote no frame for ${t.toFixed(2)} s of ${video}`);
}

/** Similarity of two pictures, 0..1 (SSIM over all channels). */
export async function ssim(a: string, b: string): Promise<number> {
  const r = await must(["ffmpeg", "-loglevel", "info", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"], "comparing two frames");
  const m = r.stderr.match(/All:([\d.]+)/);
  if (!m) throw new CliError("ffmpeg printed no SSIM value");
  return Number(m[1]);
}

/** Runs `fn` over `items` with at most `limit` running at once, keeping order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
