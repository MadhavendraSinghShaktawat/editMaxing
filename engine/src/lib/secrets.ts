import { run } from "./proc.ts";

const SERVICE = "Shifu Dojo";
const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Secrets live in the macOS Keychain. `security -i` keeps them out of the process list. */
export const secrets = {
  async set(name: string, value: string) {
    await run("/usr/bin/security", ["-i"], { input: `add-generic-password -U -a ${quote(name)} -s ${quote(SERVICE)} -w ${quote(value)}\n` });
  },
  async get(name: string) {
    try {
      const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-a", name, "-s", SERVICE, "-w"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  },
  async has(name: string) {
    try {
      await run("/usr/bin/security", ["find-generic-password", "-a", name, "-s", SERVICE]);
      return true;
    } catch {
      return false;
    }
  },
  async remove(name: string) {
    try {
      await run("/usr/bin/security", ["delete-generic-password", "-a", name, "-s", SERVICE]);
    } catch {
      // Already gone.
    }
  },
};
