import { chromium, type Browser, type Page } from "playwright-core";
import { rmSync } from "node:fs";
import type { Config } from "./config";
import { scalePicture } from "./ffmpeg";
import { CliError } from "./time";

async function reachable(url: string): Promise<boolean> {
  if (!url.startsWith("http")) return true;
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Makes sure the page answers; starts `page.start` when it does not. Returns a function that stops what it started. */
async function ensureServer(cfg: Config): Promise<() => void> {
  if (await reachable(cfg.page.url)) return () => {};
  if (!cfg.page.start) throw new CliError(`the page does not answer at ${cfg.page.url} (start its server, or set "page.start" in the config)`);
  const proc = Bun.spawn(["sh", "-c", cfg.page.start], { cwd: cfg.root, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 150; i++) {
    if (await reachable(cfg.page.url)) return () => proc.kill();
    await Bun.sleep(200);
  }
  proc.kill();
  throw new CliError(`"${cfg.page.start}" did not bring up ${cfg.page.url} within 30 s`);
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
      await page.waitForFunction((name) => (window as any)[name] === true, cfg.page.ready, { timeout: 60000 }).catch(() => {
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

/** Runs `fn` with a browser session and always closes it. */
export async function withSession<T>(cfg: Config, fn: (s: Session) => Promise<T>): Promise<T> {
  const session = await openSession(cfg);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/** Draws time `t` on the page; the seek hook may be synchronous or return a promise. */
export const seek = (page: Page, cfg: Config, t: number) =>
  page.evaluate(async ([name, time]) => void (await (window as any)[name as string](time)), [cfg.page.seek, t] as const);

/** Reads a hook's value from the page (duration, shot list). */
export const readHook = <T>(page: Page, name: string) => page.evaluate((n) => (window as any)[n], name) as Promise<T>;

/**
 * Saves the page's picture of time `t` as a JPEG `width` pixels wide. The page (opened at the render scale) is shot
 * at full size and scaled afterwards: a page drawn small renders text differently from a scaled-down video frame.
 */
export async function shootPicture(page: Page, cfg: Config, t: number, width: number, out: string): Promise<void> {
  await seek(page, cfg, t);
  const full = out.replace(/\.jpg$/, ".full.jpg");
  await page.screenshot({ path: full, type: "jpeg", quality: cfg.render.quality });
  await scalePicture(full, width, out);
  rmSync(full);
}
