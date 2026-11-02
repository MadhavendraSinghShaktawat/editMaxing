import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.DOJO_ROOT ?? resolve(here, "../..");
export const HOME = process.env.DOJO_HOME ?? join(homedir(), "Library/Application Support/Shifu Dojo");
export const PORT = Number(process.env.DOJO_PORT ?? 51791);

export const DIRS = {
  files: join(HOME, "files"),
  missions: join(HOME, "missions"),
  accounts: join(HOME, "accounts"),
  packs: join(HOME, "packs"),
  cache: join(HOME, "cache"),
  library: join(HOME, "library"),
  tmp: join(HOME, "tmp"),
  styles: join(HOME, "styles"),
};

/** Styles the maintainers have chosen to share with everyone. Empty until one is added. */
export const SHARED_STYLES = process.env.DOJO_SHARED_STYLES ?? join(ROOT, "library/styles");
export const PLUGIN_DIR = process.env.DOJO_PLUGIN ?? join(ROOT, "library/plugin");
export const MOTION_MODULES = join(DIRS.packs, "motion/node_modules");
export const MOTION_PYTHON = join(DIRS.packs, "motion/.venv/bin");
export const WEB_DIR = process.env.DOJO_WEB ?? join(ROOT, "dist");

export function ensureDirs() {
  for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });
}

/** GUI apps start with a minimal PATH, so common install folders are always searched. */
const SEARCH = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(homedir(), ".local/bin"), join(homedir(), ".claude/local")];

export const TOOL_PATH = [...new Set(SEARCH.filter(Boolean))].join(delimiter);

export function findBin(name: string) {
  for (const dir of new Set(SEARCH)) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function nativeBin() {
  const options = [process.env.DOJO_NATIVE, join(ROOT, "dojo-native"), join(ROOT, "mac/.build/release/dojo-native"), join(ROOT, "mac/.build/debug/dojo-native")];
  return options.find((p) => p && existsSync(p)) ?? null;
}

export const earshotPython = () => {
  const p = join(DIRS.packs, "earshot/.venv/bin/python");
  return existsSync(p) ? p : null;
};
