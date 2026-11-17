// A twelve-second demo video: three coloured shapes moving on a 120 BPM beat, with made-up lyrics.
// Every frame is a pure function of the time t, which is what beatclip needs from a page.
export const DURATION = 12;
export const BEAT0 = 0.5;
export const BEAT = 0.5;
export const SHOTS = [
  { id: "intro", s: 0 },
  { id: "bounce", s: 3 },
  { id: "grow", s: 6 },
  { id: "finale", s: 9 },
];

const SQUARE = "#e74c3c";
const BALL = "#3498db";
const BAR = "#2ecc71";
/** The word "wide" is drawn this much before it is sung: a deliberate sync problem for `beatclip check`. */
const EARLY = { "a3:3": 0.3 };

const clamp = (x) => Math.min(1, Math.max(0, x));
const el = (parent, style, attrs = {}) => {
  const node = document.createElement("div");
  Object.assign(node.style, { position: "absolute" }, style);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.append(node);
  return node;
};

export function build(stage, lyrics) {
  const square = el(stage, { width: "60px", height: "60px", top: "170px", left: "0", background: SQUARE }, { "data-probe": "square" });
  const ball = el(stage, { width: "50px", height: "50px", left: "295px", top: "0", borderRadius: "50%", background: BALL }, { "data-probe": "ball" });
  const bar = el(stage, { height: "40px", left: "70px", top: "200px", background: BAR }, { "data-probe": "bar" });
  const floor = el(stage, { left: "0", width: "640px", top: "300px", height: "2px", background: "#555" });
  const rows = lyrics.lines.map((line) => {
    const row = el(stage, { left: "0", width: "640px", top: "40px", textAlign: "center", font: "700 34px Helvetica, Arial, sans-serif", color: "#fff" });
    const words = line.words.map((w, i) => {
      const span = document.createElement("span");
      span.className = "lw";
      span.dataset.word = `${line.id}:${i}`;
      span.textContent = w.w + " ";
      row.append(span);
      return { span, s: w.s - (EARLY[`${line.id}:${i}`] ?? 0) };
    });
    return { row, line, words };
  });

  return (t) => {
    const shot = SHOTS.findLast((s) => s.s <= t).id;
    const phase = (t - BEAT0) / BEAT;
    const pulse = Math.exp(-(phase - Math.floor(phase)) * 3);
    const finale = shot === "finale";

    square.style.display = shot === "intro" || finale ? "block" : "none";
    square.style.transform = finale ? `translate(120px, 0) scale(${1 + 0.3 * pulse})` : `translate(${clamp(t / 3) * 580}px, 0) rotate(${t * 120}deg)`;

    ball.style.display = shot === "bounce" || finale ? "block" : "none";
    // Lowest on every beat, highest half-way between two beats.
    ball.style.transform = `translate(0, ${250 - 150 * Math.abs(Math.sin(Math.PI * phase))}px)`;

    bar.style.display = shot === "grow" || finale ? "block" : "none";
    bar.style.width = `${finale ? 500 : 20 + 480 * clamp((t - 6) / 2.5)}px`;
    bar.style.opacity = finale ? String(0.5 + 0.5 * pulse) : "1";

    floor.style.display = shot === "bounce" ? "block" : "none";
    for (const r of rows) {
      r.row.style.display = t >= r.line.s - 0.4 && t < r.line.e + 0.4 ? "block" : "none";
      for (const w of r.words) w.span.style.opacity = t >= w.s ? "1" : "0";
    }
  };
}
