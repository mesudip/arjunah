import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VERSION, LIMITS } from "../src/lib/constants.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// npm versions may carry a prerelease tag (1.0.0-alpha.1); the protocol version does not.
const release = (version) => String(version).split("-")[0];
for (const path of [
  "package.json",
  "desktop/package.json",
  "packages/sdk/package.json",
]) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (release(manifest.version) !== VERSION || manifest.version !== pkg.version)
    throw new Error(`${path} and protocol versions drifted.`);
}
const required = [
  "manifest.json",
  "background.js",
  "content.js",
  "page-api.js",
  "popup.html",
  "options.html",
];
for (const file of required) readFileSync(join("src", file));
const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
const firefoxManifest = JSON.parse(
  readFileSync("manifests/firefox.json", "utf8"),
);
if (manifest.version !== VERSION)
  throw new Error("Manifest and protocol versions drifted.");
if (manifest.version_name !== pkg.version)
  throw new Error("Chrome manifest version_name and package version drifted.");
if (manifest.manifest_version !== 3) throw new Error("Expected Manifest V3.");
if (
  firefoxManifest.manifest_version !== 3 ||
  !firefoxManifest.background?.scripts
)
  throw new Error("Expected a Firefox Manifest V3 event page.");
for (const key of [
  "name",
  "version",
  "permissions",
  "host_permissions",
  "icons",
  "action",
  "options_ui",
  "content_scripts",
  "web_accessible_resources",
]) {
  if (JSON.stringify(manifest[key]) !== JSON.stringify(firefoxManifest[key]))
    throw new Error(`Browser manifests drifted at ${key}.`);
}
if (manifest.content_security_policy)
  throw new Error("Use the default strict extension CSP.");

for (const directory of [
  "src",
  "src/lib",
  "desktop/bin",
  "desktop/lib",
  "desktop/lib/providers",
  "desktop/lib/t3",
  "desktop/dashboard",
]) {
  for (const file of readdirSync(directory).filter(
    (name) => name.endsWith(".js") || name.endsWith(".mjs"),
  ))
    execFileSync(process.execPath, ["--check", join(directory, file)], {
      stdio: "inherit",
    });
}
const pageApi = readFileSync("src/page-api.js", "utf8");
for (const member of [
  "isEnabled",
  "enable",
  "disable",
  "permissions",
  "providers",
  "models",
  "context",
  "site",
  "chat",
])
  if (!pageApi.includes(member))
    throw new Error(`Missing page API member: ${member}`);
const content = readFileSync("src/content.js", "utf8");
if (!content.includes('attachShadow({ mode: "closed" })'))
  throw new Error("Consent and hosted chat must use a closed Shadow DOM.");
if (!content.includes("resize:both"))
  throw new Error("Hosted chat must remain user-resizable.");
const desktopServer = readFileSync("desktop/lib/server.mjs", "utf8");
if (
  !desktopServer.includes(`APP_VERSION = "${VERSION}"`) ||
  !desktopServer.includes(`PROTOCOL_VERSION = "${VERSION}"`)
)
  throw new Error("Desktop app and protocol versions drifted.");
const types = readFileSync("packages/sdk/src/types.ts", "utf8");
const sdk = readFileSync("packages/sdk/src/index.ts", "utf8");
if (
  !pageApi.includes(`version: "${VERSION}"`) ||
  !types.includes(`version: "${VERSION}"`) ||
  !sdk.includes(`PROTOCOL_VERSION = "${VERSION}"`)
)
  throw new Error("Discovery/type versions drifted.");
for (const [path, needle] of [
  ["src/page-api.js", String(LIMITS.resultBytes)],
  ["src/content.js", String(LIMITS.contextText)],
  ["src/content.js", String(LIMITS.selection)],
]) {
  if (!readFileSync(path, "utf8").includes(needle))
    throw new Error(`Classic script limit drifted in ${path}.`);
}
console.log("Static extension checks passed.");
