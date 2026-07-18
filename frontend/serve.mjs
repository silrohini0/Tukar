// Zero-dependency static server for the Tukar frontend.
// Serves correct MIME types (notably application/wasm) so the in-browser prover
// can stream the circuit.  Usage: node frontend/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.argv[2]) || 8000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".zkey": "application/octet-stream",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") path = "/index.html";
    // SPA rewrites: /demo and the per-step routes serve the single demo console,
    // which renders the right panel from the URL. Any static host used for a
    // hosted deploy needs the same rewrite rule configured.
    else if (path === "/demo" || /^\/demo\/(send|corridor|receive|audit)\/?$/.test(path)) path = "/demo.html";
    const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    }).end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}).listen(PORT, () => {
  console.log(`Tukar frontend → http://localhost:${PORT}`);
});
