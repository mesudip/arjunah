import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VERSION, LIMITS } from "../src/lib/constants.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// npm versions may carry a prerelease tag (1.0.0-alpha.2); the protocol version does not.
const release = (version) => String(version).split("-")[0];
for (const path of [
  "package.json",
  "desktop/package.json",
  "packages/sdk/package.json",
  "packages/widget/package.json",
]) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (release(manifest.version) !== VERSION || manifest.version !== pkg.version)
    throw new Error(`${path} and protocol versions drifted.`);
}
const required = [
  "manifest.json",
  "background.js",
  "content.js",
  "renderer/core.js",
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
  "src/renderer",
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
const renderer = readFileSync("src/renderer/core.js", "utf8");
if (!renderer.includes("resize:both"))
  throw new Error("Hosted chat must remain user-resizable.");
// The renderer also ships as an npm package, so it must stay a classic script
// that touches no extension API and no network.
for (const forbidden of ["chrome.", "browser.runtime", "fetch(", "import "])
  if (renderer.includes(forbidden))
    throw new Error(`The renderer must not reference ${forbidden.trim()}.`);
if (!renderer.startsWith("/**") || !renderer.includes("var ArjunahRenderer ="))
  throw new Error(
    "The renderer must define ArjunahRenderer as a classic script.",
  );
const desktopServer = readFileSync("desktop/lib/server.mjs", "utf8");
if (
  !desktopServer.includes(`APP_VERSION = "${VERSION}"`) ||
  !desktopServer.includes(`PROTOCOL_VERSION = "${VERSION}"`)
)
  throw new Error("Desktop app and protocol versions drifted.");
// The widget package must publish the very renderer the extension loads.
const widgetRenderer = "packages/widget/dist/renderer.js";
try {
  const built = readFileSync(widgetRenderer, "utf8");
  if (!built.startsWith(renderer))
    throw new Error("packages/widget/dist is stale; run npm run build:widget.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
// SPEC.md's header carries the release channel (1.0.0-alpha) while every
// runtime version string is the bare protocol version (1.0.0). AGENTS.md has
// promised this was enforced for a while; now it is.
const spec = readFileSync("SPEC.md", "utf8");
const channel = String(pkg.version).split("-")[1];
const specVersion = channel ? `${VERSION}-${channel.split(".")[0]}` : VERSION;
if (!spec.includes(`\nVersion: **${specVersion}**\n`))
  throw new Error(
    `SPEC.md must declare Version: **${specVersion}** to match ${pkg.version}.`,
  );
for (const needle of [
  `readonly attribute DOMString version; // "${VERSION}"`,
  `its \`detail\` is \`{ "version": "${VERSION}" }\``,
])
  if (!spec.includes(needle))
    throw new Error(`SPEC.md section 3 version drifted: ${needle}`);
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
// The integration fixtures are plain static pages that no browser test loads,
// so a rename of the page API can rot them silently. It already did once.
const LEGACY_PAGE_API = [
  "window.ai.site",
  "window.ai.chat",
  "window.ai.models",
  "window.ai.context",
  "window.ai.version",
  "user-controlled-ai:",
];
for (const root of ["sample-site/dist", "demo"]) {
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (/\.(js|html)$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        for (const legacy of LEGACY_PAGE_API)
          if (source.includes(legacy))
            throw new Error(
              `${path} uses the pre-1.0 page API "${legacy}"; the namespace is window.ai.arjunah.`,
            );
      }
    }
  }
}
console.log("Static extension checks passed.");
