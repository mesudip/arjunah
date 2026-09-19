/**
 * Builds the standalone widget package from the sources the extension itself
 * ships, so there is exactly one renderer and one card validator. The renderer
 * is a classic script in `src/renderer/`; here it gains an ESM footer. Nothing
 * is transpiled or minified: the published file is the reviewed file.
 */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve as join } from "node:path";
import { fileURLToPath } from "node:url";

// npm may run this from the workspace directory, so paths are anchored to the
// repository rather than to the current working directory.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const resolve = (...parts) => join(root, ...parts);
const out = resolve("packages/widget/dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const core = readFileSync(resolve("src/renderer/core.js"), "utf8");
writeFileSync(
  resolve(out, "renderer.js"),
  `${core}\nexport default ArjunahRenderer;\nexport const { STYLE, createChatView, renderCard, renderMarkdown } =\n  ArjunahRenderer;\n`,
);
for (const file of ["cards.js", "errors.js", "constants.js", "schema.js"])
  copyFileSync(resolve("src/lib", file), resolve(out, file));
for (const file of ["index.js", "index.d.ts"])
  copyFileSync(resolve("packages/widget/src", file), resolve(out, file));
console.log(`widget: ${out}`);
