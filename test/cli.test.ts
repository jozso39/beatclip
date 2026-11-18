// Runs the real command line against a copy of the demo project: a real page, real screenshots, real ffmpeg.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const PORT = 5300 + (process.pid % 400);
let dir = "";

async function cli(...args: string[]): Promise<{ code: number; json: any; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args, "--json"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, json: out.trim() ? JSON.parse(out) : null, err };
}

/** Rewrites one colour constant of the demo scene, the way an edit round would. */
function recolour(name: string, colour: string) {
  const file = resolve(dir, "scene.js");
  writeFileSync(file, readFileSync(file, "utf8").replace(new RegExp(`const ${name} = "#\\w+"`), `const ${name} = "${colour}"`));
}

const serverUp = () => fetch(`http://localhost:${PORT}/index.html`).then(() => true, () => false);

/** One line of ffprobe output for the video stream of a file. */
const probe = (file: string, entries: string) =>
  Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", `stream=${entries}`, "-of", "csv=p=0", file]).stdout.toString().trim().replace(/,$/, "");

const sheets = () => (existsSync(resolve(dir, "out/sheets")) ? readdirSync(resolve(dir, "out/sheets")) : []);

beforeAll(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "beatclip-test-"));
  cpSync(resolve(import.meta.dir, "../demo"), dir, { recursive: true, filter: (src) => !/\/(out|audio|\.beatclip)$/.test(src) && !src.endsWith("beatclip.notes.json") });
  const config = resolve(dir, "beatclip.config.json");
  // The start command is a shell line whose server is a child of the shell, as "cd app && npm run dev" would be.
  writeFileSync(config, readFileSync(config, "utf8").replaceAll("5210", String(PORT)).replace('"bun serve.ts', '"cd . && bun serve.ts'));
  await Bun.spawn(["bun", resolve(dir, "make-audio.ts")], { stdout: "ignore" }).exited;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("doctor, init and docs", async () => {
  const ok = await cli("doctor");
  expect(ok.code).toBe(0);
  expect(ok.json.ready).toBe(true);
  expect(ok.json.checks.find((c: any) => c.what === "window.__shots").detail).toBe("4 shots");

  // A config pointing at a page without the hooks: doctor says which one is wrong and exits 1.
  const config = resolve(dir, "beatclip.config.json");
  const good = readFileSync(config, "utf8");
  writeFileSync(config, good.replace('"shots": "__shots"', '"shots": "__nothing"'));
  const bad = await cli("doctor");
  writeFileSync(config, good);
  expect(bad.code).toBe(1);
  expect(bad.json.checks.find((c: any) => c.level === "FAIL").what).toBe("window.__nothing");

  const empty = mkdtempSync(resolve(tmpdir(), "beatclip-init-"));
  const init = (...args: string[]) => Bun.spawnSync(["bun", CLI, "init", ...args], { cwd: empty });
  expect(init("--url", "http://localhost:4000/?render=1", "--fps", "30").exitCode).toBe(0);
  expect(JSON.parse(readFileSync(resolve(empty, "beatclip.config.json"), "utf8"))).toMatchObject({ page: { url: "http://localhost:4000/?render=1" }, fps: 30 });
  expect(init().exitCode).toBe(1);
  rmSync(empty, { recursive: true });

  expect((await cli("docs")).json.readme).toContain("# beatclip");
}, 60000);

test("at, find and beat read the shot list from the page", async () => {
  const at = (await cli("at", "0:04.2")).json;
  expect(at.shot).toMatchObject({ id: "bounce", s: 3, e: 6, file: "scene.js:8" });
  expect(at.word.key).toBe("a2.1");
  expect((await cli("find", "bar")).json.map((h: any) => `${h.kind}:${h.id}`)).toEqual(["word:a3.1", "cue:bar full"]);
  expect((await cli("beat", "4.2", "--next")).json).toMatchObject({ n: 8, t: 4.5 });
  const bad = await cli("at", "nonsense");
  expect(bad.code).toBe(1);
  expect(bad.json.error).toContain("not a time");
}, 30000);

test("frames writes a new labelled sheet each time and nothing when a capture fails", async () => {
  const one = (await cli("frames", "--shot", "bounce", "--beats")).json;
  expect(one.tiles.map((t: any) => t.t)).toEqual([3, 3.5, 4, 4.5, 5, 5.5]);
  expect(one.tiles[2].label).toContain("beat 7");
  expect(one.tiles[2].label).toContain("“ball”");
  expect(readFileSync(one.sheets[0]).subarray(1, 4).toString()).toBe("PNG");
  const two = (await cli("frames", "--shot", "bounce", "--beats")).json;
  expect(two.sheets[0]).not.toBe(one.sheets[0]);

  const before = sheets();
  const missing = await cli("frames", "4", "--video", "out/nope.mp4");
  expect(missing.code).toBe(1);
  expect(missing.json.error).toContain("no such video");
  expect((await cli("frames", "99")).code).toBe(1);
  expect((await cli("frames", "4", "--out", one.sheets[0])).json.error).toContain("refusing to overwrite");
  expect(sheets()).toEqual(before);
}, 60000);

test("render: full, partial from the cache, and a stale cache is caught and widened", async () => {
  const full = (await cli("render")).json;
  expect(full).toMatchObject({ kind: "full", frames: { total: 360, shot: 360 } });
  expect(existsSync(full.out)).toBe(true);

  const part = (await cli("render", "--shot", "bounce")).json;
  expect(part).toMatchObject({ kind: "partial", frames: { shot: 90 }, rendered: [{ from: 3, to: 6 }] });
  expect(part.check.differing).toEqual([]);
  expect(part.out).not.toBe(full.out);

  // Limited-range BT.709, tagged, so players do not have to guess; all frames there after the join.
  expect(probe(full.out, "pix_fmt,color_range,color_space,color_transfer,color_primaries,nb_frames")).toBe("yuv420p,tv,bt709,bt709,bt709,360");
  expect(full.segments).toEqual({ segments: 3, encoded: 3 });
  // Nothing changed in "bounce": its frames come out the same, so no segment is encoded again.
  expect(part.segments).toEqual({ segments: 3, encoded: 0 });
  // The joined segments and a one-pass encode of the same frames are the same video.
  const whole = (await cli("render", "--shot", "bounce", "--whole")).json;
  expect(whole.segments).toBeNull();
  expect((await cli("diff", part.out, whole.out, "--threshold", "6")).json.ranges).toEqual([]);

  const quick = (await cli("render", "--shot", "bounce", "--excerpt")).json;
  expect(quick.out).toContain("excerpt-3.00-6.00-1.mp4");
  expect(probe(quick.out, "nb_frames")).toBe("90");
  expect(probe(quick.out, "color_space")).toBe("bt709");

  // The square is in "intro" and "finale"; only the first second is asked for, so the check has to widen to both shots.
  recolour("SQUARE", "#ff00ff");
  const stale = await cli("render", "--from", "0", "--to", "1");
  expect(new Set(stale.json.check.differing.map((d: any) => d.shot))).toEqual(new Set(["intro", "finale"]));
  expect(stale.json.rendered).toEqual([{ from: 0, to: 3 }, { from: 9, to: 12 }]);
  expect(stale.json.kind).toBe("partial");
  expect(stale.err).toContain("no longer match the cache");

  // The bar is in "grow" and "finale": with "intro" asked for, widening would cover most of the video, so everything is shot.
  recolour("BAR", "#ff00ff");
  const most = (await cli("render", "--shot", "intro")).json;
  expect(most.kind).toBe("full");
  expect(most.fullBecause).toContain("kept differing from the cache");

  const strict = await cli("render", "--shot", "bounce", "--no-widen");
  expect(strict.code).toBe(0);
  recolour("BAR", "#00ffff");
  const refused = await cli("render", "--shot", "intro", "--no-widen", "--no-encode");
  expect(refused.code).toBe(1);
  expect(refused.json.error).toContain("frames outside the rendered range changed");
  // The unfinished ranges are remembered and shot with the next partial render.
  const healed = (await cli("render", "--shot", "bounce", "--no-encode")).json;
  expect(healed.check.differing.length).toBeGreaterThan(0);
  expect((await cli("render", "--shot", "bounce", "--no-encode")).json.check.differing).toEqual([]);
}, 120000);

test("render starts over when a source file changes during the shoot", async () => {
  const config = resolve(dir, "beatclip.config.json");
  writeFileSync(config, readFileSync(config, "utf8").replace('"workers": 4', '"workers": 1'));
  // Empty the cache, start a full render, and edit the scene once the first frames have been shot.
  const cache = resolve(dir, "out/cache/frames");
  rmSync(cache, { recursive: true, force: true });
  const running = cli("render", "--full", "--no-encode");
  while (!existsSync(cache) || readdirSync(cache).length < 40) await Bun.sleep(50);
  recolour("SQUARE", "#ffaa00");
  const result = await running;
  writeFileSync(config, readFileSync(config, "utf8").replace('"workers": 1', '"workers": 4'));
  expect(result.code).toBe(0);
  expect(result.json.restarts).toBeGreaterThanOrEqual(1);
  expect(result.err).toContain("scene.js changed during the shoot");
  expect((await cli("render", "--shot", "bounce", "--no-encode")).json.check.differing).toEqual([]);
}, 120000);

test("notes, proofs, the report, and diff against the ledger", async () => {
  const old = (await cli("render")).json.out;
  expect((await cli("notes", "add", "0:04", "the ball should be orange")).json.note.id).toBe(1);
  await cli("notes", "add", "7", "--to", "8.5", "bar grows too slowly");
  await cli("notes", "proof", "1", "before", "--video", old);
  recolour("BALL", "#ff8800");
  const fresh = (await cli("render", "--note", "1")).json;
  // The ball is also in "finale", which the note does not cover: the check finds it and widens.
  expect(fresh.rendered).toEqual([{ from: 3, to: 6 }, { from: 9, to: 12 }]);

  const proof = (await cli("notes", "proof", "1", "after", "--video", fresh.out)).json;
  expect(proof.diff).toBeGreaterThan(20);
  await cli("notes", "set", "1", "done", "--shows", "an orange ball on the floor line");
  const report = (await cli("notes", "report")).json.markdown as string;
  expect(report).toMatch(/\| 1 \| the ball should be orange \| 0:04.00 \| bounce \| done in demo-\d+\.mp4 \| an orange ball on the floor line \| before \[0:04.00\]\(out\/proofs\//);
  expect(report).toContain("| 2 | bar grows too slowly | 0:07.00–0:08.50 | grow | open |");

  // Note 2 is marked done although nothing changed there: diff has to say so.
  await cli("notes", "set", "2", "done");
  const diff = (await cli("diff", old, fresh.out)).json;
  expect(diff.ranges.map((r: any) => [r.shots, r.notes])).toEqual([[["bounce"], [1]], [["finale"], []]]);
  expect(diff.unexplained).toBe(1);
  expect(diff.notesWithoutDifference).toEqual([2]);
  expect((await cli("notes", "set", "1", "nonsense")).code).toBe(1);
}, 120000);

test("arguments that would silently change what runs are refused", async () => {
  const refused = async (...args: string[]) => {
    const r = await cli(...args);
    expect(r.code).toBe(1);
    return r.json.error as string;
  };
  expect(await refused("render", "3", "6", "--no-encode")).toContain('unexpected argument "3"');
  expect(await refused("render", "--from", "3", "--tp", "6")).toContain("unknown option --tp");
  expect(await refused("render", "--notes", "2")).toContain('unexpected argument "2"');
  expect(await refused("render", "--from", "20", "--to", "30")).toContain("starts past the end");
  expect(await refused("frames", "--from", "20", "--to", "30")).toContain("none of the asked times");
  expect(await refused("frames", "--word", "a2.1", "--every", "0")).toContain("must be above 0");
  expect(await refused("frames", "--shot", "intro", "--shot", "grow")).toContain("given 2 times");
  expect(await refused("frames", "4", "--cols", "0")).toContain("at least 1");
  expect(await refused("beat", "4.2", "5.7")).toContain('unexpected argument "5.7"');
  expect(await refused("beat", "4", "--next", "--prev")).toContain("cannot be used together");
  expect(await refused("notes", "add", "99", "too late")).toContain("past the end");
  expect(await refused("notes", "add", "4", "x", "--status", "done")).toContain("unknown option --status");
  expect(await refused("probe", "ball", "3.5", "--from", "3", "--to", "3.1")).toContain("not both");
  expect(await refused("frames", "4", "--half")).toContain("only applies with --beats");
  expect(await refused("render", "--no-encode", "--out", "x.mp4")).toContain("cannot be combined");
  expect(await refused("beat", "--n", "8", "--next")).toContain("need a time");
  expect(await refused("frames", "--shot", "bounce", "--beats", "--every", "0.5")).toContain("do not apply");
  expect(await refused("check", "--all", "--update-allow")).toContain("cannot be combined");
  expect(await refused("probe", "ball", "--from", "3", "--to", "3.1", "--half")).toContain("only applies with");
  expect(await refused("render", "--excerpt", "--no-encode")).toContain("cannot be combined");
  expect((await cli("at", "12")).json.frame).toBe(359);
}, 60000);

test("render never overwrites a named draft, and two renders cannot share the cache", async () => {
  const first = (await cli("render", "--shot", "intro", "--out", "out/named.mp4")).json;
  expect(first.out).toContain("out/named.mp4");
  const again = await cli("render", "--shot", "intro", "--out", "out/named.mp4");
  expect(again.code).toBe(1);
  expect(again.json.error).toContain("already exists");

  const lock = resolve(dir, "out/cache/frames/.lock");
  const running = cli("render", "--full", "--no-encode");
  while (!existsSync(lock)) await Bun.sleep(20);
  const second = await cli("render", "--shot", "intro", "--no-encode");
  expect(second.code).toBe(1);
  expect(second.json.error).toContain("another beatclip render");
  expect((await running).code).toBe(0);
  expect(existsSync(lock)).toBe(false);
}, 120000);

test("an edit that lands after the shoot does not leave two versions of the page in the cache", async () => {
  recolour("BALL", "#aa00ff");
  const started = Date.now();
  const running = cli("render", "--shot", "bounce", "--no-encode");
  // Wait until the last frame of the range has been written, then change the ball again while the check runs.
  const last = resolve(dir, "out/cache/frames/000179.jpg");
  while (statSync(last).mtimeMs < started) await Bun.sleep(10);
  recolour("BALL", "#00aa44");
  // Even an edit that leaves the file looking older than before (cp -p, rsync -t, an unpacked archive) must count.
  const old = new Date(Date.now() - 3600_000);
  utimesSync(resolve(dir, "scene.js"), old, old);
  const result = await running;
  expect(result.code).toBe(0);
  expect(result.err).toMatch(/changed while rendering|changed during the shoot/);
  // Every frame of the cache now shows the second colour: nothing outside "intro" differs from the page.
  expect((await cli("render", "--shot", "intro", "--no-encode")).json.check.differing).toEqual([]);
}, 120000);

test("commands running at the same time share the page server and the ledger", async () => {
  const [sheet, part] = await Promise.all([cli("frames", "--from", "0", "--to", "12", "--every", "0.5"), cli("render", "--shot", "grow", "--no-encode")]);
  expect(sheet.code).toBe(0);
  expect(part.code).toBe(0);
  // Both started cold; whoever finished last stopped the one server, shell child included.
  expect(await serverUp()).toBe(false);
  expect(existsSync(resolve(dir, ".beatclip/server.json"))).toBe(false);

  // A record left by a crashed command whose pid now belongs to something else must not get that process killed.
  const bystander = Bun.spawn(["sleep", "30"]);
  writeFileSync(resolve(dir, ".beatclip/server.json"), JSON.stringify({ pid: bystander.pid, started: "Thu Jan  1 00:00:00 1970" }));
  const stale = new Date(Date.now() - 60_000);
  utimesSync(resolve(dir, ".beatclip/server.json"), stale, stale);
  expect((await cli("frames", "4")).code).toBe(0);
  expect(bystander.killed).toBe(false);
  // A source file dated far in the future must not hold a render up.
  const future = new Date(Date.now() + 3600_000);
  utimesSync(resolve(dir, "lyrics.json"), future, future);
  const began = Date.now();
  expect((await cli("render", "--shot", "intro", "--no-encode")).code).toBe(0);
  expect(Date.now() - began).toBeLessThan(15000);
  expect(bystander.exitCode).toBeNull();
  bystander.kill();
  expect(await serverUp()).toBe(false);

  const before = (await cli("notes", "list")).json.length;
  const [proof, added] = await Promise.all([cli("notes", "proof", "1", "before"), Bun.sleep(150).then(() => cli("notes", "add", "10", "the square should pulse harder"))]);
  expect(proof.code).toBe(0);
  expect(added.code).toBe(0);
  const after = (await cli("notes", "list")).json;
  expect(after.length).toBe(before + 1);
  expect(after.find((n: any) => n.id === 1).before[0].source).toBe("live page");
}, 120000);

test("diff of drafts of different length compares only what both have", async () => {
  const whole = (await cli("render", "--shot", "intro")).json.out;
  const part = (await cli("render", "--shot", "intro", "--excerpt")).json.out;
  const diff = (await cli("diff", whole, part)).json;
  expect(diff.frames).toBe(90);
  expect(diff.ranges).toEqual([]);
  expect(diff.lengthNote).toContain("only the first 90");
  // The done notes at 0:04 and 0:07 lie outside the three seconds compared: nothing may be claimed about them.
  expect(diff.notesWithoutDifference).toEqual([]);
}, 120000);

test("render --changed finds the shots an edit touched, and a segment is encoded only where frames changed", async () => {
  await cli("render", "--full", "--no-encode");
  expect((await cli("render", "--changed")).json).toMatchObject({ kind: "none", out: null });

  // The bar is in "grow" (6-9 s) and "finale" (9-12 s): two of the three four-second segments.
  recolour("BAR", "#123456");
  const changed = (await cli("render", "--changed")).json;
  expect(changed.scan.shots).toEqual(["grow", "finale"]);
  expect(changed.rendered).toEqual([{ from: 6, to: 12 }]);
  expect(changed.segments).toEqual({ segments: 3, encoded: 2 });
  expect(probe(changed.out, "nb_frames")).toBe("360");
  expect((await cli("render", "--changed")).json.kind).toBe("none");
  expect((await cli("render", "--changed", "--shot", "intro")).json.error).toContain("finds the ranges itself");
}, 120000);

test("a profile renders at its own scale into its own cache and leaves the base cache alone", async () => {
  const config = resolve(dir, "beatclip.config.json");
  const base = readFileSync(config, "utf8");
  writeFileSync(config, base.replace('"fps": 30,', '"fps": 30,\n  "profiles": { "big": { "render": { "scale": 2 } } },'));
  const doctor = (await cli("doctor", "--profile", "big")).json;
  expect(doctor.checks.find((c: any) => c.what === "canvases at scale 2").level).toBe("ok");

  const big = await cli("render", "--shot", "intro", "--profile", "big", "--drop-cache");
  expect(big.json.kind).toBe("full");
  expect(big.err).toContain("the frame cache will take about");
  expect(big.json.out).toMatch(/demo-big-1\.mp4$/);
  expect(probe(big.json.out, "width,height")).toBe("1280,720");
  expect(big.json.cacheDropped).toBe(true);
  expect(existsSync(resolve(dir, "out/cache/frames-big"))).toBe(false);
  // The base cache is still complete: a partial render of it stays partial.
  expect((await cli("render", "--shot", "intro", "--no-encode")).json.kind).toBe("partial");
  expect((await cli("at", "4", "--profile", "nope")).json.error).toContain('no profile "nope"');
}, 120000);

test("frames: a crop, a capped sheet width, and waiting after a source edit", async () => {
  const draft = (await cli("render", "--shot", "intro")).json.out;
  const crop = (await cli("frames", "--shot", "bounce", "--beats", "--crop", "270,90,100,220", "--compare", draft)).json;
  expect(crop.crop).toEqual({ x: 270, y: 90, w: 100, h: 220 });
  expect(crop.tiles.map((t: any) => t.differs)).toEqual([false, false, false, false, false, false]);
  expect((await cli("frames", "4", "--crop", "600,0,100,100")).json.error).toContain("--crop is x,y,w,h");

  const wide = (await cli("frames", "--from", "0", "--to", "12", "--every", "1", "--compare", draft, "--cols", "4", "--width", "620")).json;
  expect(wide.layout).toMatchObject({ cols: 1, width: 620 });
  expect(wide.layout.adjusted).toContain("within 2000 px");
  expect(readFileSync(wide.sheets[0]).readUInt32BE(16)).toBeLessThanOrEqual(2000);

  // Right after an edit the page may be reloading: the command waits instead of reading it half-loaded.
  recolour("SQUARE", "#0f0f0f");
  const soon = await cli("frames", "1");
  expect(soon.code).toBe(0);
  expect(soon.err).toContain("waiting for the page to settle");
  expect((await cli("frames", "1", "2", "--max-width", "10")).json.error).toContain("leaves no room");
}, 120000);

test("frames shoots the live page again when a source changes under it, and writes one sheet", async () => {
  // Let the last edit settle and the shot list be read, so the edit below lands in the middle of the shooting.
  await Bun.sleep(1600);
  await cli("at", "1");
  const had = sheets().length;
  const running = cli("frames", "--from", "0", "--to", "12", "--every", "0.05", "--all");
  await Bun.sleep(2500);
  recolour("SQUARE", "#00c2ff");
  const result = await running;
  expect(result.code).toBe(0);
  expect(result.err).toContain("the page reloaded while it was being read; trying again");
  expect(sheets().length - had).toBe(result.json.sheets.length);
}, 120000);

test("render: a damaged segment index is rebuilt, and a repeated shot id is refused", async () => {
  await cli("render", "--full");
  writeFileSync(resolve(dir, "out/cache/segments/segments.json"), '{"seg-0000');
  const again = await cli("render", "--shot", "intro");
  expect(again.code).toBe(0);
  expect(again.json.segments).toEqual({ segments: 3, encoded: 3 });

  const config = resolve(dir, "beatclip.config.json");
  const kept = readFileSync(config, "utf8");
  writeFileSync(config, JSON.stringify({ ...JSON.parse(kept), duration: 12, shots: [{ id: "a", s: 0 }, { id: "a", s: 6 }] }));
  expect((await cli("at", "1")).json.error).toContain('two shots are called "a"');
  writeFileSync(config, kept);
}, 120000);

test("notes: several proof frames, several notes at once, drafts and superseded notes", async () => {
  const total = (await cli("notes", "list")).json.length;
  const a = (await cli("notes", "add", "4.5", "the ball should squash when it lands")).json.note.id;
  const b = (await cli("notes", "add", "5", "the ball should squash more")).json.note.id;
  expect([a, b]).toEqual([total + 1, total + 2]);
  const old = (await cli("render", "--shot", "intro")).json.out;

  const before = (await cli("notes", "proof", String(a), "before", "--video", old, "--at", "4.25", "--at", "4.5", "--at", "4.75")).json;
  expect(before.before.map((p: any) => p.t)).toEqual([4.25, 4.5, 4.75]);
  expect((await cli("notes", "proof", `${a}-${b}`, "before", "--at", "4")).json.error).toContain("one note");
  const both = (await cli("notes", "proof", `${a},${b}`, "before", "--video", old)).json;
  expect(both.map((n: any) => n.before.length)).toEqual([1, 1]);

  recolour("BALL", "#ff0066");
  const fresh = (await cli("render", "--changed")).json.out;
  const after = (await cli("notes", "proof", String(a), "after", "--video", fresh)).json;
  expect(after.doneIn).toMatch(/demo-\d+\.mp4$/);
  expect(after.diff).toBeGreaterThan(20);

  expect((await cli("notes", "set", String(b), "superseded")).json.error).toContain("names its replacement");
  expect((await cli("notes", "set", String(b), "superseded", "--by", String(a))).json).toMatchObject({ status: "superseded", supersededBy: a });
  const set = (await cli("notes", "set", `1-${total}`, "verified", "--video", old)).json;
  expect(set.every((n: any) => n.status === "verified")).toBe(true);
  expect((await cli("notes", "set", "1-2", "done", "--shows", "x")).json.error).toContain("applies to one note");
  const report = (await cli("notes", "report")).json.markdown as string;
  expect(report).toContain(`superseded by #${a}`);

  // Only the note done in the second draft is judged; the ones verified in an older draft are left out, not flagged.
  const diff = (await cli("diff", old, fresh)).json;
  expect(diff.notesWithoutDifference).toEqual([]);
  expect(diff.notesDoneElsewhere).toBe(total);
  expect(diff.ranges.find((r: any) => r.shots.includes("bounce")).notes).toEqual([a]);

  // "all" is the round in hand: the notes settled in earlier rounds keep their proofs and their draft.
  await cli("notes", "set", String(a), "verified");
  const settled = (await cli("notes", "list")).json.filter((n: any) => n.status === "verified" || n.status === "superseded");
  const c = (await cli("notes", "add", "10", "the bar should be taller")).json.note.id;
  expect((await cli("notes", "proof", "all", "before", "--video", fresh)).json.id).toBe(c);
  expect((await cli("notes", "proof", "all", "after", "--video", fresh)).json.id).toBe(c);
  expect((await cli("notes", "list")).json.filter((n: any) => settled.some((s: any) => s.id === n.id))).toEqual(settled);
  expect((await cli("notes", "set", "all", "done")).json.id).toBe(c);
  expect((await cli("notes", "set", `${c},${c + 5}`, "done")).json.error).toContain(`no note ${c + 5}`);
  await cli("notes", "remove", String(c));
  expect((await cli("notes", "set", `${a}-${c + 3}`)).json.map((n: any) => n.id)).toEqual([a, b]);

  // A note sent back to open is not tied to a draft any more, and a diff against the next draft counts it in.
  expect((await cli("notes", "set", String(a), "open")).json.doneIn).toBeUndefined();
  expect((await cli("diff", old, fresh)).json.ranges.find((r: any) => r.shots.includes("bounce")).notes).toEqual([a]);
  // A proof picture deleted since does not stop new proofs from being taken.
  const gone = (await cli("notes", "list")).json.find((n: any) => n.id === a).before[0].file;
  rmSync(resolve(dir, gone));
  const retaken = await cli("notes", "proof", String(a), "after", "--video", fresh);
  expect(retaken.code).toBe(0);
  expect(retaken.json.diff).toBeUndefined();
}, 180000);

test("check: known exceptions pass, new problems fail, probes measure boxes", async () => {
  const ok = await cli("check");
  expect(ok.code).toBe(0);
  expect(ok.json).toMatchObject({ words: 16, rules: 2, new: [], fixed: [] });
  expect(ok.json.known.map((k: any) => `${k.key} ${k.kind}`)).toEqual(["a3.3 early"]);

  writeFileSync(resolve(dir, "beatclip.allow.json"), JSON.stringify({ allow: [{ key: "a1.0", kind: "late" }] }));
  const bad = await cli("check");
  expect(bad.code).toBe(1);
  expect(bad.json.new.map((k: any) => `${k.key} ${k.kind}`)).toEqual(["a3.3 early"]);
  expect(bad.json.fixed).toEqual([{ key: "a1.0", kind: "late" }]);

  const lows = (await cli("probe", "ball", "--from", "3", "--to", "6", "--lowest")).json.extremes;
  expect(lows.map((x: any) => x.t)).toEqual([3.5, 4, 4.5, 5, 5.5]);
  expect(lows.every((x: any) => x.beat.delta === 0)).toBe(true);
  const box = (await cli("probe", "ball", "3.75")).json.boxes[0].box;
  expect(box).toMatchObject({ left: 295, right: 345, top: 100, bottom: 150 });

  // A rule that cannot hold: the ball is highest between beats, not on them.
  const config = resolve(dir, "beatclip.config.json");
  writeFileSync(config, readFileSync(config, "utf8").replace('"lowest-on-beat"', '"highest-on-beat"'));
  const off = await cli("check", "--update-allow");
  expect(off.json.allow.filter((a: any) => a.kind === "off-beat").length).toBe(6);
}, 60000);
