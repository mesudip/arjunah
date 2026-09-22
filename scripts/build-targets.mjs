import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve, join } from "node:path";
import { zipSync } from "fflate";

// Archives carry the npm version, which includes the prerelease tag (1.0.0-beta.1).
const RELEASE = JSON.parse(readFileSync("package.json", "utf8")).version;

const root = resolve(".");
const dist = resolve(root, "dist");
const source = resolve(root, "src");
const unpackedOnly = process.argv.includes("--unpacked");
mkdirSync(dist, { recursive: true });

function stage(name, manifestPath) {
  const destination = resolve(dist, `${name}-unpacked`);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  if (manifestPath)
    writeFileSync(
      resolve(destination, "manifest.json"),
      readFileSync(manifestPath),
    );
  return destination;
}
function entries(directory, prefix = "") {
  const files = {};
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const name = `${prefix}${item.name}`;
    if (item.isDirectory())
      Object.assign(files, entries(join(directory, item.name), `${name}/`));
    else if (item.isFile())
      files[name] = new Uint8Array(readFileSync(join(directory, item.name)));
  }
  return files;
}
const chromeDir = stage("chrome");
const firefoxDir = stage("firefox", resolve(root, "manifests/firefox.json"));
if (!unpackedOnly) {
  for (const [name, directory] of [
    ["chrome", chromeDir],
    ["firefox", firefoxDir],
  ]) {
    const archive = resolve(
      dist,
      `arjunah-${name}-v${RELEASE}.${name === "firefox" ? "xpi" : "zip"}`,
    );
    writeFileSync(archive, zipSync(entries(directory), { level: 6 }));
    console.log(`${name}: ${archive} (${basename(directory)})`);
  }
}
