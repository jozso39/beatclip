import { describe as group, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Args } from "../src/args";
import { fitGrid } from "../src/commands/analyze";
import { differingRanges } from "../src/commands/diff";
import { extremes } from "../src/commands/check";
import { beat, find } from "../src/commands/lookup";
import { fitSheet } from "../src/commands/frames";
import { notesByIds, type Note } from "../src/commands/notes";
import { inRanges, mergeRanges, pickSamples, shotSamples, spaceNeeded } from "../src/commands/render";
import { isReload } from "../src/browser";
import { loadConfig } from "../src/config";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Config } from "../src/config";
import { constantGrid, describe, listGrid, loadLines, nearestBeat, type Project } from "../src/project";
import { fmtTime, parseTime } from "../src/time";

/** The demo project without its page: lyrics from the file, shots and beat grid as scene.js defines them. */
export function demoProject(): Project {
  const lines = loadLines(resolve(import.meta.dir, "../demo/lyrics.json"));
  const starts = [["intro", 0], ["bounce", 3], ["grow", 6], ["finale", 9]] as const;
  return {
    cfg: {} as Config,
    fps: 30,
    duration: 12,
    lines,
    words: lines.flatMap((l) => l.words),
    shots: starts.map(([id, s], i) => ({ id, s, e: starts[i + 1]?.[1] ?? 12 })),
    cues: [{ name: "ball first lands", t: 3.5 }, { name: "bar full", t: 8.5 }],
    grid: { ...constantGrid(0.5, 0.5), perBar: 4 },
  };
}

group("times", () => {
  test("every accepted spelling", () => {
    expect(parseTime("1:07")).toBe(67);
    expect(parseTime("1:07.5")).toBe(67.5);
    expect(parseTime("67.5")).toBe(67.5);
    expect(parseTime("1:02:03.25")).toBe(3723.25);
  });
  test("rejects what is not a time", () => {
    for (const bad of ["", "abc", "1:75", "-3", "1:", "1:07s"]) expect(() => parseTime(bad)).toThrow();
  });
  test("formats minutes and carries rounding", () => {
    expect(fmtTime(67.5)).toBe("1:07.50");
    expect(fmtTime(59.999)).toBe("1:00.00");
    expect(fmtTime(5, 0)).toBe("0:05");
  });
});

group("arguments", () => {
  test("values, switches, repeats and beat offsets", () => {
    const a = new Args(["beat", "1:07", "--half", "-2", "--from", "1", "--from", "2"]);
    expect(a.rest).toEqual(["beat", "1:07", "-2"]);
    expect(a.has("half")).toBe(true);
    expect(a.all("from")).toEqual(["1", "2"]);
    expect(a.time("from")).toBe(2);
  });
  test("a flag without its value is an error", () => {
    expect(() => new Args(["--from"])).toThrow();
    expect(() => new Args(["--every", "x"]).num("every")).toThrow();
  });
});

group("beat grids", () => {
  test("constant grid", () => {
    const g = constantGrid(0.25, 0.5);
    expect(g.time(134)).toBe(67.25);
    expect(g.pos(67.25)).toBe(134);
    expect(nearestBeat(g, 67.1)).toEqual({ n: 134, t: 67.25, delta: -0.15 });
    expect(nearestBeat(g, 67.05, true).n).toBe(133.5);
  });
  test("the constant grid fitted to measured beats", () => {
    const fit = fitGrid([0.26, 0.74, 1.25, 1.76, 2.24]);
    expect(fit.interval).toBeCloseTo(0.498, 3);
    expect(fit.first).toBeCloseTo(0.254, 3);
    expect(fit.worst).toBeCloseTo(0.012, 3);
  });
  test("measured beats interpolate and continue past both ends", () => {
    const g = listGrid([1, 2, 4, 5]);
    expect(g.pos(3)).toBe(1.5);
    expect(g.time(1.5)).toBe(3);
    expect(g.time(4)).toBe(6);
    expect(g.pos(0)).toBe(-1);
    expect(g.time(g.pos(4.3))).toBeCloseTo(4.3);
  });
});

group("lookups on the demo project", () => {
  const p = demoProject();
  test("at a time inside a word", () => {
    const m = describe(p, 4.2);
    expect(m.shot?.id).toBe("bounce");
    expect(m.shot?.into).toBe(1.2);
    expect(m.word?.key).toBe("a2.1");
    expect(m.word?.w).toBe("ball");
    expect(m.line?.id).toBe("a2");
    expect(m.cue).toEqual({ name: "ball first lands", t: 3.5, delta: 0.7 });
    expect(m.beat).toEqual({ index: 7, phase: 0.4, bar: 2, inBar: 4, nearest: { n: 7, t: 4, delta: 0.2 } });
    expect(m.frame).toBe(126);
    expect(describe(p, 11.99).frame).toBe(359);
  });
  test("between two lines it names the last and the next word", () => {
    const m = describe(p, 3);
    expect(m.word).toBeNull();
    expect(m.prevWord?.key).toBe("a1.3");
    expect(m.prevWord?.ago).toBe(0.5);
    expect(m.nextWord?.key).toBe("a2.0");
    expect(m.nextWord?.in).toBe(0.5);
  });
  test("find words, runs of words, cues and shots", () => {
    const hits = (q: string) => (find(p, new Args(q.split(" "))).data as { kind: string; id: string; t: number }[]).map((h) => `${h.kind}:${h.id}@${h.t}`);
    expect(hits("ball")).toEqual(["cue:ball first lands@3.5", "word:a2.1@4"]);
    expect(hits("grows wide")).toEqual(["line:a3@6.5", "word:a3.2@7.5"]);
    expect(hits("finale")).toEqual(["shot:finale@9"]);
    expect(hits("a4")).toEqual(["line:a4@9.5"]);
    expect(hits("zebra")).toEqual([]);
    const hyphen = { ...p, shots: [{ id: "verse-1", s: 0, e: 6 }, { id: "verse_2", s: 6, e: 12 }] };
    expect((find(hyphen, new Args(["verse-1"])).data as { id: string }[]).map((h) => h.id)).toEqual(["verse-1"]);
  });
  test("beat: nearest, next, previous, half beats and offsets", () => {
    const at = (...argv: string[]) => (beat(p, new Args(argv)).data as { n: number; t: number });
    expect(at("4.2")).toMatchObject({ n: 7, t: 4 });
    expect(at("4.2", "--next")).toMatchObject({ n: 8, t: 4.5 });
    expect(at("4.2", "--prev")).toMatchObject({ n: 7, t: 4 });
    expect(at("4", "--next")).toMatchObject({ n: 8, t: 4.5 });
    expect(at("4", "--prev")).toMatchObject({ n: 6, t: 3.5 });
    expect(at("4.2", "--next", "--half")).toMatchObject({ n: 7.5, t: 4.25 });
    expect(at("4.2", "+4")).toMatchObject({ n: 11, t: 6 });
    expect(at("4.2", "--prev", "-2")).toMatchObject({ n: 5, t: 3 });
    expect(at("--n", "8")).toMatchObject({ n: 8, t: 4.5 });
  });
});

group("ranges", () => {
  test("differing frames join into ranges across short gaps", () => {
    const diffs = [0, 9, 9, 0, 9, 0, 0, 0, 0, 30, 0];
    expect(differingRanges(diffs, 10, 6, 2)).toEqual([
      { from: 0.1, to: 0.5, peak: 9, peakAt: 0.1 },
      { from: 0.9, to: 1, peak: 30, peakAt: 0.9 },
    ]);
    expect(differingRanges(diffs, 10, 31, 2)).toEqual([]);
  });
  test("frame ranges merge when they touch or overlap", () => {
    expect(mergeRanges([[5, 9], [0, 3], [3, 4], [8, 12], [20, 20]])).toEqual([[0, 4], [5, 12]]);
  });
  test("check samples lie outside the re-shot ranges and include their neighbours and every other shot", () => {
    const p = demoProject();
    const ranges: [number, number][] = [[90, 180]];
    const picks = pickSamples(p, ranges, 360, 30, () => 0.5);
    expect(picks.some((f) => inRanges(ranges, f))).toBe(false);
    for (const f of [89, 180, 45, 225, 315]) expect(picks).toContain(f);
    expect(picks.length).toBe(30);
  });
  test("turning points of a moving box", () => {
    const box = (bottom: number) => ({ shown: 1, left: 0, right: 10, top: bottom - 10, bottom });
    const series = [50, 80, 100, 100, 70, 40, 60, 90, 60].map((y, i) => ({ t: i / 10, box: box(y) }));
    expect(extremes(series, "lowest")).toEqual([{ t: 0.25, y: 100 }, { t: 0.7, y: 90 }]);
    expect(extremes(series, "highest")).toEqual([{ t: 0.5, y: 30 }]);
  });
});

group("render planning", () => {
  test("--changed samples the first and last frame of every shot and some between", () => {
    const picks = shotSamples(demoProject(), 2);
    expect(picks).toEqual([0, 30, 59, 89, 90, 120, 149, 179, 180, 210, 239, 269, 270, 300, 329, 359]);
  });
  test("--changed also samples the time before the first shot", () => {
    const p = demoProject();
    expect(shotSamples({ ...p, shots: p.shots.slice(1) }, 2)).toEqual(shotSamples(p, 2));
  });
  test("space a full render needs: missing frames, a third for the video, a gigabyte spare", () => {
    expect(spaceNeeded(4e9, 0)).toBe(4e9 + 1.2e9 + 1e9);
    expect(spaceNeeded(4e9, 4e9)).toBe(1.2e9 + 1e9);
  });
  test("a reload is told apart from a server that is gone", () => {
    expect(isReload(new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation"))).toBe(true);
    expect(isReload(new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:1/\n - navigating to ..."))).toBe(false);
    expect(isReload(new Error("ffmpeg failed"))).toBe(false);
  });
});

group("sheets", () => {
  test("a sheet wider than the limit loses columns first, then picture width", () => {
    expect(fitSheet(4, 480, 1, 2000)).toEqual({ cols: 4, width: 480, changed: null });
    expect(fitSheet(4, 620, 2, 2000)).toMatchObject({ cols: 1, width: 620 });
    expect(fitSheet(4, 620, 2, 2600)).toMatchObject({ cols: 2, width: 620 });
    expect(fitSheet(2, 1200, 2, 2000)).toMatchObject({ cols: 1, width: 991 });
    expect(fitSheet(4, 620, 2, 2000).changed).toContain("1 column of 620 px");
    expect(fitSheet(4, 480, 1, 10).width).toBeLessThan(16);
  });
});

group("notes", () => {
  const notes = [1, 2, 3, 5, 6].map((id) => ({ id }) as Note);
  test("ids as single numbers, lists, ranges and all", () => {
    const ids = (spec: string) => notesByIds(notes, spec, notes.slice(3)).map((n) => n.id);
    expect(ids("3")).toEqual([3]);
    expect(ids("1,5")).toEqual([1, 5]);
    expect(ids("2-3,1,2")).toEqual([1, 2, 3]);
    // "all" is whatever the caller counts as the round in hand; a range takes the notes that exist in it.
    expect(ids("all")).toEqual([5, 6]);
    expect(ids("2-5")).toEqual([2, 3, 5]);
    expect(ids("1-99999999999")).toEqual([1, 2, 3, 5, 6]);
    for (const bad of ["x", "4-2", "9", "4", "7-9", "all,3", "2-"]) expect(() => notesByIds(notes, bad, notes)).toThrow();
  });
});

group("config profiles", () => {
  const dir = mkdtempSync(`${tmpdir()}/beatclip-config-`);
  const file = `${dir}/beatclip.config.json`;
  writeFileSync(file, JSON.stringify({
    page: { url: "http://localhost:1/", width: 640, height: 360 },
    beats: { first: 0, interval: 0.5 },
    out: { video: "out/draft-{n}.mp4" },
    render: { quality: 90 },
    profiles: { big: { render: { scale: 2 } }, own: { render: { scale: 2, workers: 6 }, out: { cache: "big/frames", video: "big/final.mp4" } } },
  }));
  test("the base config", () => {
    const c = loadConfig(file);
    expect(c.render).toMatchObject({ scale: 1, workers: 8, quality: 90, segment: 4, audioBitrate: "256k" });
    expect([c.out.cache, c.out.segments, c.out.video]).toEqual([`${dir}/out/cache/frames`, `${dir}/out/cache/segments`, `${dir}/out/draft-{n}.mp4`]);
  });
  test("a profile overrides keys and gets its own cache, segments and video name", () => {
    const c = loadConfig(file, "big");
    expect(c.render).toMatchObject({ scale: 2, workers: 4, quality: 90 });
    expect([c.out.cache, c.out.segments, c.out.video]).toEqual([`${dir}/out/cache/frames-big`, `${dir}/out/cache/segments-big`, `${dir}/out/draft-big-{n}.mp4`]);
  });
  test("a profile that names its own folders keeps them", () => {
    const c = loadConfig(file, "own");
    expect(c.render.workers).toBe(6);
    expect([c.out.cache, c.out.segments, c.out.video]).toEqual([`${dir}/big/frames`, `${dir}/big/segments`, `${dir}/big/final.mp4`]);
  });
  test("an unknown profile is an error naming the ones there are", () => {
    expect(() => loadConfig(file, "nope")).toThrow("big, own");
  });
});
