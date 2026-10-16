import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const errors = [];

if (manifest.manifest_version !== 3) errors.push("Manifest must use version 3.");
if ((manifest.host_permissions || []).some((item) => item === "<all_urls>")) {
  errors.push("Permanent all-sites access is not allowed.");
}

const requiredFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  "offscreen.html",
  "offscreen.js",
  "pcm-capture-worklet.js",
  "caption-overlay.js",
  "caption-overlay.css",
  "stats.html",
  "stats.js",
  "icons/icon-live-16.png",
  "icons/icon-live-32.png",
  "icons/icon-live-48.png",
  "icons/icon-live-128.png",
  ...Object.values(manifest.icons || {})
].filter(Boolean);

for (const file of requiredFiles) {
  try {
    await access(resolve(root, file));
  } catch {
    errors.push(`Missing referenced file: ${file}`);
  }
}

for (const htmlName of ["popup.html", "offscreen.html", "stats.html"]) {
  const html = await readFile(resolve(root, htmlName), "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) errors.push(`${htmlName} contains inline JavaScript.`);
  if (/https?:\/\/[^"']+\.js/i.test(html)) errors.push(`${htmlName} loads remote JavaScript.`);
}

for (const jsName of ["background.js", "offscreen.js", "popup.js", "stats.js", "caption-overlay.js"]) {
  const source = await readFile(resolve(root, jsName), "utf8");
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) errors.push(`${jsName} uses dynamic code execution.`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validated ${requiredFiles.length} referenced files (including live toolbar icons), permissions, CSP-safe scripts, and Manifest V3 structure.`);
