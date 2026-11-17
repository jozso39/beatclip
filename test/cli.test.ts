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

  const quick = (await cli("render", "--shot", "bounce", "--excerpt")).json;
  expect(quick.out).toContain("excerpt-3.00-6.00-1.mp4");
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "csv=p=0", quick.out]);
  expect(parseInt(probe.stdout.toString())).toBe(90);

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
  expect(report).toContain("| 1 | the ball should be orange | 0:04.00 | bounce | done | an orange ball on the floor line | [before](out/proofs/");
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
  expect(after.find((n: any) => n.id === 1).before.source).toBe("live page");
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
