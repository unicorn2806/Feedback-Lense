// Launches Chromium with the extension loaded. The overlay's shadow root is
// switched from "closed" to "open" in a temporary copy so Playwright can reach
// the overlay's controls; nothing else is changed.
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright is resolved via CommonJS so NODE_PATH works for a global install.
const { chromium } = createRequire(import.meta.url)('playwright');

export const EXT_SRC = fileURLToPath(new URL('../extension/', import.meta.url));

export async function launch({ headless = true, viewport = { width: 1280, height: 860 }, manifestPatch = null } = {}) {
  const work = await mkdtemp(join(process.env.FL_TMP || tmpdir(), 'fl-e2e-'));
  const ext = join(work, 'extension');
  await cp(EXT_SRC, ext, { recursive: true });
  const overlay = join(ext, 'src/content/overlay.js');
  const code = await readFile(overlay, 'utf8');
  if (!code.includes("attachShadow({ mode: 'closed' })")) throw new Error('shadow root marker not found');
  await writeFile(overlay, code.replace("attachShadow({ mode: 'closed' })", "attachShadow({ mode: 'open' })"));
  if (manifestPatch) {
    // e.g. a fixed "key", so the extension ID is known before the browser starts (policy test)
    const manifest = join(ext, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, 'utf8')), ...manifestPatch }, null, 2));
  }

  const context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium',
    headless,
    viewport,
    locale: 'de-DE',
    acceptDownloads: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  const cleanup = async () => {
    await context.close().catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  };
  return { context, sw, extensionId, ext, cleanup, extUrl: (p) => `chrome-extension://${extensionId}/${p}` };
}
