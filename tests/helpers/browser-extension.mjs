import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";

// Only this disposable test copy redirects provider traffic. The production
// endpoint restriction, options UI, consent, and request adapter stay intact.
export async function mockProviderExtension(mockBase, firefox = false) {
  const root = await mkdtemp(join(tmpdir(), "arjunah-extension-test-"));
  const directory = join(root, "extension");
  try {
    await cp(resolve("src"), directory, { recursive: true });
    const providerPath = join(directory, "lib/provider.js");
    const source = await readFile(providerPath, "utf8");
    const transport = `const fetch = (url, init) => {
      const target = new URL(url);
      if (target.origin !== 'https://api.openai.com' || !target.pathname.startsWith('/v1/'))
        throw new Error('Unexpected provider destination in browser test.');
      return globalThis.fetch(${JSON.stringify(mockBase)} + target.pathname.slice(3), init);
    };\n`;
    await writeFile(providerPath, transport + source);
    let addonPath;
    if (firefox) {
      await cp(
        resolve("manifests/firefox.json"),
        join(directory, "manifest.json"),
      );
      const files = {};
      async function collect(path, prefix = "") {
        for (const item of await readdir(path, { withFileTypes: true })) {
          if (item.isDirectory())
            await collect(join(path, item.name), `${prefix}${item.name}/`);
          else
            files[`${prefix}${item.name}`] = new Uint8Array(
              await readFile(join(path, item.name)),
            );
        }
      }
      await collect(directory);
      addonPath = join(root, "test-extension.xpi");
      await writeFile(addonPath, zipSync(files));
    }
    return {
      directory,
      addonPath,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
