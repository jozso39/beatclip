// Serves the demo folder: bun demo/serve.ts [port]
import { resolve, normalize } from "node:path";

const root = import.meta.dir;
const port = Number(process.argv[2] ?? 5210);

Bun.serve({
  port,
  async fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
});
console.log(`demo page on http://localhost:${port}/index.html`);
