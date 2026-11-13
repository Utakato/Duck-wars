// Old embedded Chromium (TV sticks, cars) must be able to parse every game file, so the game is
// written in ES2017-level syntax. This parses all of it with acorn at that level.
//
//   node tests/syntax.spec.mjs        (needs acorn, which ships with Playwright)
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let acorn = null;
try { acorn = require("acorn"); } catch (e) {
  try { acorn = createRequire(require.resolve("playwright"))("acorn"); } catch (e2) { acorn = null; }
}
if (!acorn) { console.log("SKIPPED syntax.spec: acorn not found"); process.exit(0); }

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (fs.statSync(f).isDirectory()) walk(f, out); else if (f.endsWith(".js")) out.push(f);
  }
  return out;
}
let failures = 0;
const files = walk(path.join(root, "js"), []);
for (const f of files) {
  try { acorn.parse(fs.readFileSync(f, "utf8"), { ecmaVersion: 2017, sourceType: "module" }); }
  catch (e) { failures++; console.log("FAIL " + path.relative(root, f) + ": " + e.message); }
}
console.log(failures ? failures + " file(s) use syntax newer than ES2017" : "PASSED syntax.spec: " + files.length + " files parse as ES2017 (acorn " + acorn.version + ")");
process.exit(failures ? 1 : 0);
