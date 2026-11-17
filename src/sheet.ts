import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Browser } from "playwright-core";
import { CliError } from "./time";

export interface Tile {
  /** Picture files inside the work folder, shown side by side (one, or two when comparing drafts). */
  images: string[];
  label: string;
}

export interface SheetSpec {
  title: string;
  tiles: Tile[];
  cols: number;
  /** Width of one picture in pixels. */
  width: number;
  /** Most tiles on one sheet; more tiles make more sheets. */
  perSheet: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function sheetHtml(spec: SheetSpec, tiles: Tile[], title: string): string {
  const figures = tiles
    .map((t) => `<figure><div class="row">${t.images.map((f) => `<img src="${esc(basename(f))}" width="${spec.width}">`).join("")}</div><figcaption>${esc(t.label)}</figcaption></figure>`)
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><style>
body { margin: 0; background: #101014; color: #f2f2f2; font: 13px/1.3 ui-monospace, Menlo, Consolas, monospace; }
header { padding: 8px 8px 0; color: #9aa0aa; }
main { display: grid; grid-template-columns: repeat(${spec.cols}, max-content); gap: 8px; padding: 8px; }
figure { margin: 0; background: #000; }
.row { display: flex; gap: 2px; }
img { display: block; }
figcaption { padding: 4px 6px; background: #1c1c22; white-space: nowrap; overflow: hidden; }
</style><header>${esc(title)}</header><main>${figures}</main>`;
}

/** A path in `dir` that does not exist yet: name.png, name-2.png, name-3.png ... */
export function uniquePath(dir: string, name: string, ext: string): string {
  for (let i = 1; ; i++) {
    const file = resolve(dir, `${name}${i > 1 ? `-${i}` : ""}.${ext}`);
    if (!existsSync(file)) return file;
  }
}

/**
 * Lays the tiles out as labelled contact sheets and returns the files written.
 * Each sheet is drawn in `work` first; nothing appears at the destination unless every sheet succeeded.
 */
export async function composeSheets(browser: Browser, spec: SheetSpec, work: string, dest: (page: number, pages: number) => string): Promise<string[]> {
  const pages = Math.ceil(spec.tiles.length / spec.perSheet);
  const pairs = spec.tiles[0].images.length;
  const drawn: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: spec.cols * (spec.width * pairs + 2 * (pairs - 1) + 8) + 8, height: 200 } });
  try {
    const page = await ctx.newPage();
    for (let n = 0; n < pages; n++) {
      const html = resolve(work, `sheet-${n}.html`);
      const title = pages > 1 ? `${spec.title}  ·  sheet ${n + 1} of ${pages}` : spec.title;
      writeFileSync(html, sheetHtml(spec, spec.tiles.slice(n * spec.perSheet, (n + 1) * spec.perSheet), title));
      await page.goto(`file://${html}`);
      const broken = await page.evaluate(async () => {
        await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
        return [...document.images].filter((i) => !i.naturalWidth).length;
      });
      if (broken) throw new CliError(`${broken} tile picture(s) could not be read while composing the sheet`);
      const png = resolve(work, `sheet-${n}.png`);
      await page.screenshot({ path: png, fullPage: true, type: "png" });
      drawn.push(png);
    }
  } finally {
    await ctx.close();
  }
  return drawn.map((png, n) => {
    const out = dest(n, pages);
    if (existsSync(out)) throw new CliError(`refusing to overwrite ${out}`);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(png, out);
    return out;
  });
}
