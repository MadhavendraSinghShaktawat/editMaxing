import { spawn } from "node:child_process";
import { TOOL_PATH } from "../config.ts";

export type RunOptions = { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; input?: string; onLine?: (line: string) => void };

/** Runs a program without a shell, so file names can never be interpreted as commands. */
export function run(command: string, args: string[], options: RunOptions = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, PATH: TOOL_PATH, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
    const out: string[] = [];
    const err: string[] = [];
    let carry = "";
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      out.push(d);
      if (options.onLine) {
        const lines = (carry + d).split("\n");
        carry = lines.pop() ?? "";
        lines.forEach(options.onLine);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      err.push(d);
      if (err.length > 400) err.shift();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) return reject(new Error("Cancelled"));
      const stdout = out.join("");
      const stderr = err.join("");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(lastLine(stderr) || lastLine(stdout) || `${command} exited with code ${code}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop()?.slice(0, 400) ?? "";

export function runBinary(command: string, args: string[], signal?: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, PATH: TOOL_PATH }, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: string[] = [];
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(lastLine(err.join("")) || `${command} exited with code ${code}`));
    });
  });
}
