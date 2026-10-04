// Electrobun serves bundled views as `views://mainview/index.html`. A relative
// `../assets/foo.js` in that page resolves (RFC 3986) to
// `views://mainview/assets/foo.js`, and the `views://` scheme handler maps that
// to `Resources/app/views/mainview/assets/foo.js` — it can never climb above the
// view host to reach a shared `views/assets/` folder. Vite emits one shared
// `dist/assets/`, so mirror it into each view folder before packaging.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VIEWS = ["mainview", "tabview"] as const;

export function mirrorViewAssets(root: string = PROJECT_ROOT): boolean {
  const assets = resolve(root, "dist/assets");
  if (!existsSync(assets)) return false;
  for (const view of VIEWS) {
    const target = resolve(root, `dist/${view}/assets`);
    rmSync(target, { recursive: true, force: true });
    cpSync(assets, target, { recursive: true });
  }
  return true;
}
