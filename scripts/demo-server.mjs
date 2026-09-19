// Serves the playground pages over loopback HTTP so the extension can inject window.ai.arjunah.
//   npm run demo            → http://127.0.0.1:8090/        (playground landing page)
//   http://127.0.0.1:8090/paint/         (level-0 Paint playground)
//   http://127.0.0.1:8090/trip-planner/  (original trip planner)
//   http://127.0.0.1:8090/lab/  (the minimal Assistant Protocol Lab sample)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.env.ARJUNAH_DEMO_PORT) || 8090;
const roots = { "/lab": resolve("sample-site/dist"), "": resolve("demo") };
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const prefix = url.pathname.startsWith("/lab") ? "/lab" : "";
  let path = normalize(url.pathname.slice(prefix.length) || "/");
  if (path.endsWith("/")) path += "index.html";
  const file = join(roots[prefix], path);
  if (!file.startsWith(roots[prefix])) {
    response.writeHead(403);
    return response.end();
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`अर्जुनः playground: http://127.0.0.1:${port}/`);
  console.log(`Paint:            http://127.0.0.1:${port}/paint/`);
  console.log(`Trip planner:     http://127.0.0.1:${port}/trip-planner/`);
  console.log(`Sample site:      http://127.0.0.1:${port}/lab/`);
  console.log(
    "Load the extension from src/ (or dist/chrome-unpacked) first, then open the page.",
  );
});
