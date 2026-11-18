import { chromium, type Browser, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config";
import { atExit, identify, recordAlive, type ProcessId } from "./exit";
import { scalePicture, type Crop } from "./ffmpeg";
import { changedSource, settle, snapshotSources } from "./sources";
import { CliError } from "./time";

async function reachable(url: string): Promise<boolean> {
  if (!url.startsWith("http")) return true;
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/**
 * Makes sure the page answers, starting `page.start` when it does not, and returns the function that lets go of it.
 * Several commands may use one started server at the same time: each registers itself, and the server is stopped
 * by whichever command finishes last. A server beatclip did not start is never stopped.
 */
async function ensureServer(cfg: Config): Promise<() => void> {
  const users = resolve(cfg.root, ".beatclip", "users");
  const serverFile = resolve(cfg.root, ".beatclip", "server.json");
  const me = resolve(users, String(process.pid));
  mkdirSync(users, { recursive: true });
  writeFileSync(me, JSON.stringify(identify(process.pid)));
  const release = atExit(() => {
    rmSync(me, { force: true });
    for (const pid of readdirSync(users)) if (!recordAlive(resolve(users, pid))) rmSync(resolve(users, pid), { force: true });
    if (!existsSync(serverFile) || readdirSync(users).length) return;
    // The whole process group: the start command may be a shell that launched the server as its child.
    if (recordAlive(serverFile)) process.kill(-(JSON.parse(readFileSync(serverFile, "utf8")) as ProcessId).pid);
    rmSync(serverFile, { force: true });
  });
  try {
    // A record whose process is gone (or whose pid now belongs to something else) is forgotten, never acted on.
    // One written in the last two seconds may belong to a command that is starting the server right now.
    const forgetDead = () => {
      if (existsSync(serverFile) && !recordAlive(serverFile) && Date.now() - statSync(serverFile).mtimeMs > 2000) rmSync(serverFile, { force: true });
    };
    // Only the command that manages to create the record starts the server; the others wait for it.
    const start = () => {
      let fd: number;
      try {
        fd = openSync(serverFile, "wx");
      } catch {
        return;
      }
      const child = spawn("sh", ["-c", cfg.page.start!], { cwd: cfg.root, detached: true, stdio: ["ignore", "ignore", "inherit"] });
      child.unref();
      writeSync(fd, JSON.stringify(identify(child.pid!)));
      closeSync(fd);
    };
    forgetDead();
    if (await reachable(cfg.page.url)) return release;
    if (!cfg.page.start) throw new CliError(`the page does not answer at ${cfg.page.url} (start its server, or set "page.start" in the config)`);
    for (let i = 0; i < 150; i++) {
      forgetDead();
      start();
      await Bun.sleep(200);
      if (await reachable(cfg.page.url)) return release;
    }
    throw new CliError(`"${cfg.page.start}" did not bring up ${cfg.page.url} within 30 s`);
  } catch (e) {
    release();
    throw e;
  }
}

export interface Session {
  browser: Browser;
  /** Opens the project page and waits for its ready hook. `scale` is the device scale factor of screenshots. */
  open(scale?: number): Promise<Page>;
  close(): Promise<void>;
}

/** Launches the browser alone (no project page), for composing sheets. */
export async function launchBrowser(cfg: Config): Promise<Browser> {
  try {
    return await chromium.launch({
      channel: cfg.page.channel,
      headless: true,
      args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none", "--hide-scrollbars"],
    });
  } catch (e) {
    throw new CliError(`cannot launch the browser (channel "${cfg.page.channel}"): ${(e as Error).message.split("\n")[0]}`);
  }
}

export async function openSession(cfg: Config): Promise<Session> {
  const stopServer = await ensureServer(cfg);
  const browser = await launchBrowser(cfg).catch((e) => {
    stopServer();
    throw e;
  });
  return {
    browser,
    async open(scale = 1) {
      const ctx = await browser.newContext({ viewport: { width: cfg.page.width, height: cfg.page.height }, deviceScaleFactor: scale });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
      await page.goto(cfg.page.url);
      await page.waitForFunction((name) => (window as any)[name] === true, cfg.page.ready, { timeout: 60000 }).catch((e) => {
        if (isReload(e)) throw e;
        throw new CliError(`window.${cfg.page.ready} did not become true within 60 s at ${cfg.page.url}`);
      });
      return page;
    },
    async close() {
      await browser.close().catch(() => {});
      stopServer();
    },
  };
}

/** Errors a page throws when it reloaded under us. A server that stopped answering (net::ERR_...) is not one of them. */
const RELOAD = /Execution context was destroyed|because of a navigation|frame was detached|Target closed|has been closed/i;
export const isReload = (e: unknown) => RELOAD.test((e as Error).message) && !/net::ERR_/.test((e as Error).message);

/**
 * Runs `fn` with a browser session and always closes it. It first waits for the sources to settle, and when the
 * page reloads under `fn` (a dev server picking up an edit) it runs `fn` again, so `fn` must be safe to repeat.
 * A reload does not always throw: the page may simply carry on as its new version. So a navigation of any page
 * `fn` opened, or a source file that changed meanwhile, counts as one too, whatever `fn` returned or threw.
 */
export async function withSession<T>(cfg: Config, fn: (s: Session) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await settle(cfg);
    const before = snapshotSources(cfg);
    const session = await openSession(cfg);
    let navigated = false;
    const watched: Session = {
      ...session,
      async open(scale) {
        const page = await session.open(scale);
        const main = page.mainFrame();
        page.on("framenavigated", (f) => {
          if (f === main) navigated = true;
        });
        return page;
      },
    };
    const reloaded = () => navigated || changedSource(before, snapshotSources(cfg)) !== null;
    try {
      const result = await fn(watched);
      if (!reloaded()) return result;
    } catch (e) {
      if (!isReload(e) && !reloaded()) throw e;
    } finally {
      await session.close();
    }
    if (attempt >= 3) throw new CliError("the page kept reloading while it was being read; try again when the edits are done");
    console.error("beatclip: the page reloaded while it was being read; trying again");
  }
}

/** Draws time `t` on the page; the seek hook may be synchronous or return a promise. */
export const seek = (page: Page, cfg: Config, t: number) =>
  page.evaluate(async ([name, time]) => void (await (window as any)[name as string](time)), [cfg.page.seek, t] as const);

/** Reads a hook's value from the page (duration, shot list). */
export const readHook = <T>(page: Page, name: string) => page.evaluate((n) => (window as any)[n], name) as Promise<T>;

/** Draws time `t` and returns the page's picture (or a rectangle of it, in page pixels) as a JPEG at the render quality. */
export async function shootJpeg(page: Page, cfg: Config, t: number, crop?: Crop): Promise<Buffer> {
  await seek(page, cfg, t);
  return page.screenshot({ type: "jpeg", quality: cfg.render.quality, ...(crop ? { clip: { x: crop.x, y: crop.y, width: crop.w, height: crop.h } } : {}) });
}

/**
 * Saves the page's picture of time `t` as a JPEG `width` pixels wide. The page (opened at the render scale) is shot
 * at full size and scaled afterwards: a page drawn small renders text differently from a scaled-down video frame.
 */
export async function shootPicture(page: Page, cfg: Config, t: number, width: number, out: string, crop?: Crop): Promise<void> {
  const full = out.replace(/\.jpg$/, ".full.jpg");
  writeFileSync(full, await shootJpeg(page, cfg, t, crop));
  await scalePicture(full, width, out);
  rmSync(full);
}
