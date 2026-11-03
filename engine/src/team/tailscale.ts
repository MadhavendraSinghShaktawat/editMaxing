import { existsSync } from "node:fs";
import { PORT, findBin } from "../config.ts";
import { json } from "../db.ts";
import { HttpError } from "../lib/http.ts";
import { run } from "../lib/proc.ts";

/** The App Store and standalone apps keep the command line inside the app. Homebrew puts it on PATH. */
const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function tailscaleBin() {
  return existsSync(APP_CLI) ? APP_CLI : findBin("tailscale");
}

export type TailscaleStatus =
  | { installed: false }
  | { installed: true; running: boolean; state: string; name: string | null; address: string | null; serving: boolean };

/** Reads Tailscale's own status. Changes nothing. */
export async function tailscaleStatus(): Promise<TailscaleStatus> {
  const bin = tailscaleBin();
  if (!bin) return { installed: false };
  const out = await run(bin, ["status", "--json"]).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
  const s = json<{ BackendState?: string; Self?: { DNSName?: string; HostName?: string } }>(out.stdout, {});
  const dns = s.Self?.DNSName?.replace(/\.$/, "") || null;
  const serve = await run(bin, ["serve", "status", "--json"]).catch(() => ({ stdout: "" }));
  const serving = serve.stdout.includes(`127.0.0.1:${PORT}`) || serve.stdout.includes(`localhost:${PORT}`);
  return { installed: true, running: s.BackendState === "Running", state: s.BackendState ?? "Unknown", name: s.Self?.HostName ?? null, address: dns ? `https://${dns}` : null, serving };
}

/**
 * Puts the Studio behind Tailscale Serve: HTTPS on this Mac's tailnet name, reachable only by
 * devices in the same tailnet. The engine itself keeps listening on 127.0.0.1 only.
 */
export async function tailscaleServe(on: boolean) {
  const bin = tailscaleBin();
  if (!bin) throw new HttpError(400, "Tailscale isn't installed on this Mac.");
  const status = await tailscaleStatus();
  if (status.installed && !status.running) throw new HttpError(400, "Tailscale is installed but not connected. Open Tailscale and sign in first.");
  const args = on ? ["serve", "--bg", `http://127.0.0.1:${PORT}`] : ["serve", "--https=443", "off"];
  await run(bin, args).catch((e: Error) => {
    throw new HttpError(400, `Tailscale said: ${e.message.split("\n")[0]}`);
  });
  return tailscaleStatus();
}
