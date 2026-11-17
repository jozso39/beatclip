# beatclip

A command-line tool for editing code-rendered music videos from timestamped notes ("at 1:07 the ball should land on the beat").

It is for videos where a web page draws every frame as a pure function of the song time, and a script screenshots that page frame by frame. beatclip answers the questions that come up on every round of changes: what is on screen at 1:07, which beat is that, what does the frame look like now, and what did it look like in the last draft.

Work in progress: `at`, `find`, `beat`, `analyze beats` and `frames` are in; `render`, `notes`, `diff` and `check` are next.

## Install

Needs [Bun](https://bun.sh), Google Chrome and `ffmpeg`/`ffprobe` on the PATH.

```bash
git clone https://github.com/jozso39/beatclip.git
cd beatclip
bun install
bun link
```

`beatclip` is then on your PATH. Run it from the project folder (it looks for `beatclip.config.json` there and in the parent folders) or pass `--project <folder>`.

## Try the demo

`demo/` is a twelve-second video of three coloured shapes on a 120 BPM beat. Its page server is started for you.

```bash
bun demo/make-audio.ts
cd demo
beatclip at 0:04.2
```

## What the page must expose

| Hook | Meaning |
| --- | --- |
| `window.__seek(t)` | Draw the frame of time `t` (seconds). May return a promise. Must not depend on what was drawn before. |
| `window.__duration` | Length of the video in seconds. |
| `window.__ready` | Set to `true` once fonts, images and the hooks above are in place. |
| `window.__shots` (optional) | `[{ id, s }]`: every shot with its start time. A shot ends where the next one starts. |

The names can be changed in the config. See [demo/index.html](demo/index.html) for a minimal page.

## The config file

`beatclip.config.json` in the project root; every path is relative to it. The demo's config:

```json
{
  "page": {
    "url": "http://localhost:5210/index.html?render=1",
    "width": 640,
    "height": 360,
    "shots": "__shots",
    "start": "bun serve.ts 5210"
  },
  "fps": 30,
  "audio": "audio/click.wav",
  "lyrics": "lyrics.json",
  "sources": ["scene.js", "index.html", "lyrics.json"],
  "cues": [
    { "name": "ball first lands", "t": 3.5 },
    { "name": "bar full", "t": 8.5 }
  ],
  "beats": { "first": 0.5, "interval": 0.5, "perBar": 4 },
  "out": { "dir": "out", "video": "out/demo-{n}.mp4" }
}
```

| Key | Meaning |
| --- | --- |
| `page.url`, `page.width`, `page.height` | The page to drive and its frame size. |
| `page.ready`, `page.seek`, `page.duration` | Hook names, default `__ready`, `__seek`, `__duration`. |
| `page.shots` | Name of the shot-list hook. Leave it out and list the shots under `shots` instead: `[{ "id": "intro", "s": 0 }]`. |
| `page.start` | Command that starts the page's server when the URL does not answer (optional). |
| `fps` | Frames per second of the video (default 60). |
| `audio` | The song, used for the encode and as the default input of `analyze beats`. |
| `lyrics` | JSON with `lines: [{ id, text, s, e, words: [{ w, s, e }] }]`. Optional `shouts: [{ id, s, e, letters: [{ c, s, e }] }]` are read as lines of one-letter words. |
| `sources` | Globs of the files the picture depends on. The shot list read from the page is cached until one of them changes. |
| `cues` | Named moments: `[{ "name": "bar full", "t": 8.5 }]`. |
| `beats` | `{ "first": 0.5, "interval": 0.5 }` for a constant tempo, or `{ "file": "beats.json" }` for measured beat times. `perBar` adds bar numbers. |
| `out` | Output folders: `sheets` (default `out/sheets`). |
| `python` | Python with librosa, only for `analyze beats`. |

## Times

Everywhere a time is expected you can write `1:07`, `1:07.5` or `67.5`. Lyric words are named `<line id>.<index from 0>`, for example `a2.1`. Beats are numbered from 0; `7.5` is the half beat after beat 7.

Every command prints a readable answer by default and JSON with `--json`. Errors go to stderr with exit code 1 (and `{"error": ...}` on stdout with `--json`).

## Commands

### `beatclip at <time>`

What is on at a time: shot (with its source file when the id is found in `sources`), lyric line and word, nearest cue, beat.

```
$ beatclip at 0:04.2
0:04.20 (4.20 s)  frame 126
shot   bounce  0:03.00–0:06.00  (1.20 s in)  scene.js:8
line   a2  "blue ball bounces high"  0:03.50–0:05.50
word   a2.1  "ball"  0:04.00–0:04.50  (being sung)
cue    "ball first lands" at 0:03.50 (+0.70 s from it)
beat   7 + 0.40  bar 2, beat 4  (nearest: beat 7 at 0:04.00, +0.20 s from it)
```

### `beatclip find <text>`

The reverse: times of lyric words (or runs of words), lines, cues and shots matching a text.

```
$ beatclip find ball
 0:03.50     3.50 s  cue   ball first lands
 0:04.00     4.00 s  word  a2.1         ball  (to 0:04.50)
```

### `beatclip beat <time> [--next|--prev] [--half] [+N|-N]`

The time of a beat: the nearest one by default, the next or previous one, on the half-beat grid with `--half`, moved by `+N`/`-N` beats. `beatclip beat --n 8` gives the time of beat 8.

```
$ beatclip beat 4.2 --next --half
beat 7.5 at 0:04.25 (4.25 s)  frame 128  (+0.05 s from 0:04.20)
shot   bounce  0:03.00–0:06.00  (1.25 s in)  scene.js:8
line   a2  "blue ball bounces high"  0:03.50–0:05.50
word   a2.1  "ball"  0:04.00–0:04.50  (being sung)
cue    "ball first lands" at 0:03.50 (+0.75 s from it)
```

### `beatclip analyze beats [audio]`

For songs without a constant tempo: tracks the beats with librosa and writes a beat-times file to use as `"beats": { "file": ... }`. It also prints the constant grid that fits best and how far the worst beat is from it, so you can tell whether a constant grid is good enough. This is the only command that needs Python (`--python <path>` or `"python"` in the config, with librosa installed).

### `beatclip frames`

Labelled contact sheets. Each tile carries its time, shot and the lyric word being sung.

```bash
beatclip frames 0:04 0:04.25 0:04.5          # explicit times
beatclip frames --from 3 --to 6 --every 0.5  # a range
beatclip frames --shot bounce                # a shot, 12 frames spread over it (--count, --every)
beatclip frames --word a2.1 --window 0.3     # around the start of a lyric word
beatclip frames --shot bounce --beats --half # on every beat or half beat
beatclip frames --shot bounce --video out/demo-1.mp4                 # from a rendered file
beatclip frames --shot bounce --compare out/demo-1.mp4               # live page beside a draft
beatclip frames --shot bounce --video out/demo-2.mp4 --compare out/demo-1.mp4
```

Times are snapped to video frames. With `--compare` the two pictures of a time stand side by side and the label says how alike they are (`same 1.000` = identical). Options: `--cols`, `--rows` (per sheet, default 6), `--width` (tile width, default 480), `--out <file.png>`.

Sheets are written to `out/sheets/<timestamp>-<what>.png`, a new name every time. If any capture fails, the command exits with an error and writes nothing; an existing file is never overwritten.
