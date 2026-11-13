// Builds dist/duck-wars.zip for upload to the AirConsole developer console.
// The zip holds only what the game needs: screen.html and controller.html in the root, plus
// css/, js/ and fonts/. Development files (dev/, tests/, tools/) stay out.
//
//   node tools/package.mjs
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const include = ["screen.html", "controller.html", "css", "js", "fonts"];

function walk(rel, out) {
  const abs = path.join(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) { for (const name of fs.readdirSync(abs).sort()) walk(rel + "/" + name, out); }
  else out.push(rel);
  return out;
}
const files = [];
for (const item of include) walk(item, files);

// ---- preflight: the things review rejects most often -------------------------------------------
const problems = [];
for (const page of ["screen.html", "controller.html"]) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  const tags = html.match(/<script[^>]+airconsole\.com\/api\/airconsole-[^"']+/g) || [];
  if (tags.length !== 1) problems.push(page + ": expected exactly one AirConsole API script tag, found " + tags.length);
  else if (!/airconsole-\d+\.\d+\.\d+\.js/.test(tags[0])) problems.push(page + ": pin a real API version, not 'latest'");
  if (/<img\b/i.test(html)) problems.push(page + ": <img> tags are not allowed on controllers, use div backgrounds");
}
for (const f of files) {
  if (!/\.(html|css|js)$/.test(f)) continue;
  const text = fs.readFileSync(path.join(root, f), "utf8");
  const http = text.match(/["'(]http:\/\/[^"')\s]+/g);
  if (http) problems.push(f + ": plain http reference " + http[0]);
  if (/(src|href)=["']\//.test(text) || /url\(["']?\//.test(text)) problems.push(f + ": absolute path, use relative paths");
}
if (problems.length) {
  console.error("Not packaged:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

// ---- minimal zip writer (deflate) ---------------------------------------------------------------
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

const chunks = [], central = [];
let offset = 0, raw = 0, gz = 0;
for (const f of files) {
  const data = fs.readFileSync(path.join(root, f));
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const name = Buffer.from(f, "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
  cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
  chunks.push(local, name, comp);
  central.push(cen, name);
  offset += local.length + name.length + comp.length;
  raw += data.length; gz += comp.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const outFile = path.join(root, "dist", "duck-wars.zip");
fs.writeFileSync(outFile, Buffer.concat(chunks.concat(central, [end])));
console.log("dist/duck-wars.zip: " + files.length + " files, " + (raw / 1024).toFixed(0) + " KB raw, " + (gz / 1024).toFixed(0) + " KB compressed (AirConsole limit: 50 MB to the main menu)");
