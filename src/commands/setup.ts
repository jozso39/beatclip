import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Args } from "../args";
import { readHook, withSession } from "../browser";
import { CONFIG_NAME, findConfig, loadConfig, type Config } from "../config";
import { run } from "../ffmpeg";
import { loadGrid, loadLines, sourceFiles } from "../project";
import { CliError } from "../time";
import type { Result } from "./lookup";

/** The folder beatclip is installed in (where its README and skill live). */
const HOME = resolve(import.meta.dir, "../..");

const STARTER = (o: { url: string; fps: number; width: number; height: number }) => ({
  page: { url: o.url, width: o.width, height: o.height, shots: "__shots" },
  fps: o.fps,
  audio: "audio/track.wav",
  lyrics: "lyrics.json",
  sources: ["src/**/*", "index.html", "lyrics.json"],
  cues: [],
  beats: { first: 0, interval: 0.5, perBar: 4 },
  out: { dir: "out", video: "out/draft-{n}.mp4" },
  check: { selector: '[data-word="{line}:{word}"]', allow: "beatclip.allow.json" },
});

/** `init`: writes a starter config into the current folder and says what is left to do. */
export function init(args: Args, cwd: string): Result {
  args.allow(["url", "fps", "width", "height"]);
  args.noMore();
  const file = resolve(cwd, CONFIG_NAME);
  if (existsSync(file)) throw new CliError(`${file} already exists`);
  const config = STARTER({ url: args.str("url") ?? "http://localhost:5173/?render=1", fps: args.num("fps") ?? 60, width: args.num("width") ?? 1920, height: args.num("height") ?? 1080 });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  const text = [
    `wrote ${file}`,
    "next:",
    '  1. set "page.url" to the page that draws the video, "audio" and "lyrics" to your files, "sources" to the files the picture depends on',
    '  2. set "beats": first beat and seconds per beat, or run `beatclip analyze beats` and use { "file": ... }',
    "  3. make the page expose window.__seek(t), window.__duration, window.__ready and window.__shots (see `beatclip docs`)",
    "  4. add out/, .beatclip/ to .gitignore, then run `beatclip doctor`",
  ].join("\n");
  return { data: { file, config }, text };
}

/** `docs`: the full manual (the README of the installed version). */
export function docs(): Result {
  const text = readFileSync(resolve(HOME, "README.md"), "utf8");
  return { data: { home: HOME, readme: text }, text };
}

interface Finding {
  level: "ok" | "warn" | "FAIL";
  what: string;
  detail: string;
}

async function toolVersion(cmd: string, arg: string): Promise<string | null> {
  try {
    const r = await run([cmd, arg]);
    return r.code === 0 ? (r.stdout || r.stderr).split("\n")[0].trim() : null;
  } catch {
    return null;
  }
}

/** Checks of the project behind a config: its files, its page and the hooks the page must expose. */
async function checkProject(cfg: Config, say: (level: Finding["level"], what: string, detail: string) => void) {
  const file = (what: string, path: string | undefined, need: boolean) => {
    if (!path) say(need ? "FAIL" : "warn", what, "not set in the config");
    else say(existsSync(path) ? "ok" : "FAIL", what, existsSync(path) ? path : `missing: ${path}`);
  };
  file("audio", cfg.audio, false);
  file("lyrics", cfg.lyrics, false);
  try {
    const lines = loadLines(cfg.lyrics && existsSync(cfg.lyrics) ? cfg.lyrics : undefined);
    if (cfg.lyrics) say(lines.length ? "ok" : "warn", "lyrics content", `${lines.length} lines, ${lines.reduce((n, l) => n + l.words.length, 0)} words`);
    loadGrid(cfg);
    say("ok", "beats", "file" in cfg.beats ? cfg.beats.file : `first beat ${cfg.beats.first} s, every ${cfg.beats.interval} s`);
  } catch (e) {
    say("FAIL", "lyrics or beats", (e as Error).message);
  }
  const sources = sourceFiles(cfg).length;
  say(sources ? "ok" : "warn", "sources", sources ? `${sources} files watched` : 'no "sources": a render cannot tell when the code changed under it');

  try {
    await withSession(cfg, async (s) => {
      const page = await s.open();
      say("ok", "page", `${cfg.page.url} answered and window.${cfg.page.ready} is true`);
      const duration = await readHook<unknown>(page, cfg.page.duration);
      say(typeof duration === "number" && duration > 0 ? "ok" : "FAIL", `window.${cfg.page.duration}`, typeof duration === "number" ? `${duration} s` : `is ${typeof duration}, must be the length in seconds`);
      const seekType = await page.evaluate((n) => typeof (window as any)[n], cfg.page.seek);
      say(seekType === "function" ? "ok" : "FAIL", `window.${cfg.page.seek}`, seekType === "function" ? "is a function" : `is ${seekType}, must be a function of the time in seconds`);
      if (cfg.shots) say("ok", "shots", `${cfg.shots.length} listed in the config`);
      else if (!cfg.page.shots) say("FAIL", "shots", 'set "page.shots" to the name of a window hook, or list "shots" in the config');
      else {
        const shots = await readHook<unknown>(page, cfg.page.shots);
        const good = Array.isArray(shots) && shots.length > 0 && shots.every((x) => typeof x?.id === "string" && typeof x?.s === "number");
        say(good ? "ok" : "FAIL", `window.${cfg.page.shots}`, good ? `${(shots as unknown[]).length} shots` : "must be a list of { id, s }");
      }
    });
  } catch (e) {
    say("FAIL", "page", (e as Error).message.split("\n")[0]);
  }
}

/**
 * `doctor`: checks everything beatclip needs, on this machine and in this project, and says how to fix what is missing.
 * Exit code 1 when something required is missing.
 */
export async function doctor(args: Args, cwd: string, explicit: string | undefined): Promise<Result> {
  args.allow([]);
  args.noMore();
  const found: Finding[] = [];
  const say = (level: Finding["level"], what: string, detail: string) => void found.push({ level, what, detail });

  say("ok", "bun", Bun.version);
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const v = await toolVersion(tool, "-version");
    say(v ? "ok" : "FAIL", tool, v ?? "not found on PATH (macOS: brew install ffmpeg; Debian/Ubuntu: apt install ffmpeg)");
  }
  const skill = resolve(homedir(), ".claude/skills/beatclip/SKILL.md");
  say(existsSync(skill) ? "ok" : "warn", "Claude Code skill", existsSync(skill) ? skill : `not installed (run: sh ${resolve(HOME, "install.sh")})`);

  let cfg: Config | null = null;
  try {
    cfg = loadConfig(findConfig(explicit, cwd));
    say("ok", "config", cfg.file);
  } catch (e) {
    say("warn", "config", `${(e as Error).message}; run \`beatclip init\` in the project folder`);
  }
  if (cfg) await checkProject(cfg, say);
  else {
    // Without a project the browser can still be tried on its own.
    const { launchBrowser } = await import("../browser");
    try {
      await (await launchBrowser({ page: { channel: "chrome" } } as Config)).close();
      say("ok", "Chrome", "launches");
    } catch (e) {
      say("FAIL", "Chrome", `${(e as Error).message} (install Google Chrome)`);
    }
  }

  const failed = found.filter((f) => f.level === "FAIL").length;
  const text = [...found.map((f) => `${f.level.padEnd(4)}  ${f.what.padEnd(20)} ${f.detail}`), failed ? `${failed} problem(s) to fix` : "ready"].join("\n");
  return { data: { ready: !failed, checks: found }, text, exit: failed ? 1 : 0 };
}
