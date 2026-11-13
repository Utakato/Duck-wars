// Tiny static server for development. Usage: node tools/serve.mjs [port]
// Open http://localhost:8080/dev/ for the local simulator, or point the AirConsole
// simulator at http://<your-LAN-IP>:8080/ (see README).
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".ttf": "font/ttf", ".png": "image/png",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8"
};

export function createServer() {
  return http.createServer(function (req, res) {
    let rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.argv[2]) || 8080;
  createServer().listen(port, function () {
    console.log("Duck Wars dev server");
    console.log("  local simulator : http://localhost:" + port + "/dev/");
    console.log("  AirConsole      : http://http.airconsole.com/simulator/#debug:http://<your-LAN-IP>:" + port + "/");
  });
}
