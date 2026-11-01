import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudePath } from "./claude/accounts.ts";
import { DIRS, MOTION_MODULES, MOTION_PYTHON, earshotPython, findBin, nativeBin } from "./config.ts";
import type { JobContext, Jobs } from "./jobs.ts";
import { run } from "./lib/proc.ts";
import type { Tools } from "./tools.ts";

const EARSHOT_REPO = "https://github.com/Leonxlnx/earshot.git";
const EARSHOT_COMMIT = "591fa3e";

export type PackId = "earshot" | "motion" | "depth" | "colmap";

const PACKS: { id: PackId; name: string; about: string; size: string }[] = [
  { id: "earshot", name: "Earshot", about: "Lets Claude hear audio and video on this Mac.", size: "About 2.3 GB" },
  { id: "motion", name: "Motion renderer", about: "Renders motion graphics with Playwright and Chromium.", size: "About 300 MB" },
  { id: "depth", name: "Depth", about: "Depth Anything V2 Small for parallax and 3D camera moves.", size: "About 50 MB" },
  { id: "colmap", name: "Camera tracking", about: "COLMAP solves the real 3D camera path from footage.", size: "About 1 GB through Homebrew" },
];

/** Python versions Earshot supports, newest first. */
const pythonBin = () => ["python3.13", "python3.12", "python3.11", "python3.10"].map(findBin).find(Boolean) ?? null;

export class Packs {
  private tools: Tools;
  private jobs: Jobs;

  constructor(tools: Tools, jobs: Jobs) {
    this.tools = tools;
    this.jobs = jobs;
    jobs.register<Record<string, never>>("pack.earshot", (_, ctx) => this.installEarshot(ctx));
    jobs.register<Record<string, never>>("pack.motion", (_, ctx) => this.installMotion(ctx));
    jobs.register<Record<string, never>>("pack.colmap", (_, ctx) => this.installColmap(ctx));
  }

  installed(id: PackId) {
    if (id === "earshot") return !!earshotPython();
    if (id === "motion") return existsSync(join(MOTION_MODULES, "playwright")) && existsSync(join(MOTION_PYTHON, "python"));
    if (id === "depth") return !!this.tools.depthModel();
    return !!findBin("colmap");
  }

  list() {
    return PACKS.map((p) => ({ ...p, installed: this.installed(p.id) }));
  }

  install(id: PackId) {
    if (!PACKS.some((p) => p.id === id)) throw new Error("There is no such pack.");
    return this.jobs.add(`pack.${id}`, {}, { lane: "light", priority: 7 });
  }

  private async installEarshot(ctx: JobContext) {
    const python = pythonBin();
    if (!python) throw new Error("Earshot needs Python 3.10 or newer. Run: brew install python@3.13");
    const dir = join(DIRS.packs, "earshot");
    const venv = join(dir, ".venv/bin/python");
    if (!existsSync(join(dir, ".git"))) {
      rmSync(dir, { recursive: true, force: true });
      ctx.progress(0.05, "Downloading Earshot");
      await run("git", ["clone", EARSHOT_REPO, dir], { signal: ctx.signal });
      await run("git", ["checkout", EARSHOT_COMMIT], { cwd: dir, signal: ctx.signal });
    }
    if (!existsSync(venv)) await run(python, ["-m", "venv", ".venv"], { cwd: dir, signal: ctx.signal });
    ctx.progress(0.2, "Installing Earshot");
    await run(venv, ["-m", "pip", "install", "-q", "-e", ".[mcp]"], { cwd: dir, signal: ctx.signal });
    ctx.progress(0.7, "Downloading hearing models");
    await run(venv, ["-m", "earshot", "doctor", "--fetch"], { cwd: dir, signal: ctx.signal });
    return { installed: true };
  }

  private async installMotion(ctx: JobContext) {
    const dir = join(DIRS.packs, "motion");
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), '{"private":true}');
    ctx.progress(0.2, "Installing Playwright");
    await run("npm", ["install", "--silent", "playwright"], { cwd: dir, signal: ctx.signal });
    ctx.progress(0.5, "Installing Chromium");
    await run("npx", ["playwright", "install", "chromium"], { cwd: dir, signal: ctx.signal });
    // The motion and sound skills run Python. A private venv keeps the Mac's own Python untouched.
    const python = pythonBin();
    if (!python) throw new Error("The motion skills need Python 3.10 or newer. Run: brew install python@3.13");
    ctx.progress(0.75, "Installing Python tools");
    await run(python, ["-m", "venv", ".venv"], { cwd: dir, signal: ctx.signal });
    await run(".venv/bin/python", ["-m", "pip", "install", "-q", "numpy", "scipy", "librosa", "soundfile", "matplotlib"], { cwd: dir, signal: ctx.signal });
    return { installed: true };
  }

  private async installColmap(ctx: JobContext) {
    if (!findBin("brew")) throw new Error("Camera tracking installs through Homebrew. Get it from brew.sh first.");
    ctx.progress(0.1, "Installing COLMAP");
    await run("brew", ["install", "colmap"], { signal: ctx.signal });
    return { installed: true };
  }

  /** One screen that says what works on this Mac and what to do about what doesn't. */
  async doctor() {
    const version = async (bin: string | null, args: string[]) => {
      if (!bin) return null;
      const { stdout, stderr } = await run(bin, args).catch(() => ({ stdout: "", stderr: "" }));
      return (stdout || stderr).split("\n")[0].trim() || "installed";
    };
    const claude = await version((() => { try { return claudePath(); } catch { return null; } })(), ["--version"]);
    const disk = statfsSync(DIRS.files);
    return {
      node: process.version,
      claude: { ok: !!claude, detail: claude ?? "Install Claude Code first." },
      ffmpeg: { ok: !!findBin("ffmpeg"), detail: (await version(findBin("ffmpeg"), ["-version"])) ?? "Run: brew install ffmpeg" },
      native: { ok: !!nativeBin(), detail: nativeBin() ?? "Run: swift build -c release --package-path mac --product dojo-native" },
      python: { ok: !!pythonBin(), detail: pythonBin() ?? "Run: brew install python@3.13" },
      freeDiskGB: Math.round((disk.bavail * disk.bsize) / 1e9),
      packs: this.list(),
    };
  }
}
