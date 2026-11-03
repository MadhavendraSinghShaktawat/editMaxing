import { isAbsolute, relative, resolve } from "node:path";

/** `footage` marks a step that touches the original clips or references; it asks even when approvals are off. */
export type Verdict = { behavior: "allow" } | { behavior: "ask"; reason: string; subject?: string; footage?: boolean } | { behavior: "deny"; reason: string };

/** Reads, listing and media work that can't harm anything. */
const SAFE = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "sed", "awk", "sort", "uniq", "cut", "tr", "echo", "printf", "pwd", "date", "basename", "dirname", "realpath", "stat", "file", "du", "df", "which", "true", "false", "test", "[", "jq", "sips", "ffmpeg", "ffprobe", "node", "npm", "npx", "python3", "python", "bash", "sh", "mkdir", "touch", "cp", "ln", "tee", "seq", "sleep", "pip", "pip3", "env", "cd", "export", "xargs", "find", "shasum", "open", "diff", "cmp", "fc-list", "pgrep", "ps", "nproc", "sysctl", "uname", "wait", "basename", "paste", "rev", "bc"]);

/** Anything that leaves the Mac or can't be undone needs a person. */
const SENSITIVE = new Map([
  ["sudo", "needs administrator rights"],
  ["ssh", "connects to another machine"],
  ["scp", "copies files to another machine"],
  ["rsync", "copies files to another location"],
  ["curl", "sends data to the internet"],
  ["wget", "sends data to the internet"],
  ["git", "changes a repository"],
  ["gh", "acts on GitHub"],
  ["security", "touches the Keychain"],
  ["osascript", "controls other apps"],
  ["launchctl", "changes background services"],
  ["kill", "stops running programs"],
  ["killall", "stops running programs"],
  ["pkill", "stops running programs"],
]);

/** Splits a shell line into simple commands, honouring quotes. It never executes anything. */
export function splitCommands(line: string) {
  const commands: string[][] = [];
  let word = "";
  let words: string[] = [];
  let quote = "";
  let hasWord = false;
  let substitution = false;
  let redirect = false;
  const redirects: string[] = [];
  const heredocs: string[] = [];
  const endWord = () => {
    if (hasWord) {
      if (redirect) {
        redirects.push(word);
        redirect = false;
      } else words.push(word);
    }
    word = "";
    hasWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"') word += line[++i] ?? "";
      else {
        if (quote === '"' && (c === "`" || (c === "$" && line[i + 1] === "("))) substitution = true;
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      hasWord = true;
    } else if (c === "\\") {
      word += line[++i] ?? "";
      hasWord = true;
    } else if (c === "`" || (c === "$" && line[i + 1] === "(")) {
      substitution = true;
      word += c;
      hasWord = true;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === ";" || c === "\n" || c === "|" || c === "(" || c === ")") {
      endCommand();
      // A heredoc's body is data for the command above it, never commands of its own.
      while (c === "\n" && heredocs.length) {
        const tag = heredocs.shift()!;
        let end = line.indexOf("\n", i + 1);
        while (end !== -1 && line.slice(i + 1, end).replace(/^\t+/, "") !== tag) {
          i = end;
          end = line.indexOf("\n", i + 1);
        }
        i = end === -1 ? line.length : end;
      }
    } else if (c === "&") {
      if (line[i + 1] === ">") {
        i++;
        endWord();
        redirect = true;
      } else endCommand();
    } else if (c === ">") {
      endWord();
      if (line[i + 1] === ">") i++;
      if (line[i + 1] === "&") {
        i += 2;
        continue;
      }
      redirect = true;
    } else if (c === "<") {
      endWord();
      if (line[i + 1] === "<" && line[i + 2] !== "<") {
        const tag = line.slice(i + 2).match(/^-?\s*(?:'([^']+)'|"([^"]+)"|\\?([\w.-]+))/);
        if (tag) {
          heredocs.push(tag[1] ?? tag[2] ?? tag[3]);
          i += 1 + tag[0].length;
        }
      } else if (line[i + 1] === "<") i += 2;
    } else {
      word += c;
      hasWord = true;
    }
  }
  endCommand();
  return { commands, redirects, substitution };
}

/** Downloading a sound or a font isn't publishing. Sending data out is. */
const SENDS = /^(-[a-zA-Z]*[dFTXK]|--data|--data-\S+|--json|--form|--form-string|--config|--upload-file|--request|--post-data|--post-file|--method|--body-data|--body-file)(=|$)|^-[a-zA-Z]*[dFTXK]./;

/** Shell syntax that leads into a command, like `do` in a loop or `time` before a program. */
const LEADS = new Set(["do", "then", "else", "elif", "if", "while", "until", "time", "!", "{", "}", "(", ")", "nohup", "command"]);
/** Shell syntax that isn't a command at all: a loop's header, or the word that closes a block. */
const HEADERS = new Set(["for", "select", "case", "in", "done", "fi", "esac", "function", "}"]);

const program = (words: string[]) => {
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (LEADS.has(words[i])) {
      i++;
      if (words[i - 1] === "time" && words[i] === "-p") i++;
      continue;
    }
    // A time limit is transparent: what matters is the program it runs.
    if (words[i] === "timeout" || words[i] === "gtimeout") {
      i++;
      while (i < words.length && (words[i].startsWith("-") || /^\d/.test(words[i]))) i++;
      continue;
    }
    break;
  }
  if (HEADERS.has(words[i])) return { name: "", path: "", args: [] as string[] };
  return { name: (words[i] ?? "").split("/").pop() ?? "", path: words[i] ?? "", args: words.slice(i + 1) };
};

export const inside = (path: string, root: string) => {
  const rel = relative(root, resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Paths under a mission's work folders are the editor's own and safe to change. */
export function checkBash(command: string, workspace: string, allowed: Set<string>): Verdict {
  const { commands, redirects, substitution } = splitCommands(command);
  for (const target of redirects) {
    if (/(^|\/)inputs\//.test(target)) return { behavior: "ask", reason: "writes over your source footage", footage: true };
    if (target !== "/dev/null" && !inside(target, workspace)) return { behavior: "ask", reason: `writes outside this mission: ${target}` };
  }
  for (const words of commands) {
    const { name, path, args } = program(words);
    if (!name || allowed.has(name)) continue;
    // A script the editor or Motion agent wrote inside this mission is its own work.
    if (path.includes("/") && inside(path, workspace) && !/(^|\/)inputs\//.test(path)) continue;
    if (name === "chmod") {
      const outside = args.filter((a) => !a.startsWith("-") && !/^[0-7]{3,4}$|^[ugoa]*[+=-][rwxX]+$/.test(a)).find((a) => !inside(a, workspace));
      if (outside) return { behavior: "ask", reason: `changes permissions outside this mission: ${outside}` };
      continue;
    }
    if (name === "rm" || name === "mv" || name === "rmdir" || name === "unlink" || name === "shred") {
      const paths = args.filter((a) => !a.startsWith("-"));
      const outside = paths.find((p) => !inside(p, workspace));
      if (outside) return { behavior: "ask", reason: `deletes or moves something outside this mission: ${outside}`, subject: name };
      if (paths.some((p) => /(^|\/)inputs(\/|$)/.test(p))) return { behavior: "ask", reason: "deletes or moves your source footage", subject: name, footage: true };
      continue;
    }
    if (name === "find" && args.includes("-delete")) return { behavior: "ask", reason: "bulk deletes files" };
    if (name === "open" && args.some((a) => /^https?:/.test(a))) return { behavior: "ask", reason: "opens a website" };
    if ((name === "curl" || name === "wget") && !args.some((a) => SENDS.test(a))) continue;
    const sensitive = SENSITIVE.get(name);
    if (sensitive) return { behavior: "ask", reason: `${name} ${sensitive}`, subject: name };
    if (!SAFE.has(name)) return { behavior: "ask", reason: `runs ${name}, which isn't on the safe list`, subject: name };
  }
  if (substitution && commands.some((w) => ["rm", "mv"].includes(program(w).name))) return { behavior: "ask", reason: "deletes files chosen by a nested command" };
  return { behavior: "allow" };
}

/** One main editor, and at most one Motion agent beside it. */
export function checkAgent(input: Record<string, unknown>, busy: boolean): Verdict {
  if (input.subagent_type !== "motion") return { behavior: "deny", reason: `Only the Motion agent can be started here, using subagent_type "motion". Do the rest of the edit yourself.` };
  if (busy) return { behavior: "deny", reason: "The Motion agent is already working. Carry on with the edit. When it reports back, send the next brief." };
  return { behavior: "allow" };
}

export function checkTool(name: string, input: Record<string, unknown>, workspace: string, allowed: Set<string>, readable: string[]): Verdict {
  if (name === "ScheduleWakeup" || name === "CronCreate") return { behavior: "deny", reason: "Don't schedule a check. End your turn: the Motion agent's report wakes you by itself." };
  if (allowed.has(name)) return { behavior: "allow" };
  if (name === "Bash") return checkBash(String(input.command ?? ""), workspace, allowed);
  if (name === "Write" || name === "Edit" || name === "NotebookEdit") {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    if (!inside(path, workspace)) return { behavior: "ask", reason: `changes a file outside this mission: ${path}` };
    if (/(^|\/)inputs\//.test(path)) return { behavior: "ask", reason: "changes your source footage", footage: true };
    return { behavior: "allow" };
  }
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "LS") {
    const path = String(input.file_path ?? input.path ?? workspace);
    if ([workspace, ...readable].some((root) => inside(path, root))) return { behavior: "allow" };
    return { behavior: "ask", reason: `reads a file outside this mission: ${path}` };
  }
  if (name.startsWith("mcp__dojo__") || name.startsWith("mcp__earshot__") || name.startsWith("mcp__epidemic__")) return { behavior: "allow" };
  // Envato's server only searches. Anything else it adds later has to be asked about first.
  if (/^mcp__envato__search_[a-z0-9_]+$/.test(name)) return { behavior: "allow" };
  // Scrape Creators only reads public posts. The person turned it on knowing it spends their credits.
  if (name.startsWith("mcp__scrapecreators__")) return { behavior: "allow" };
  if (["Skill", "TodoWrite", "Task", "Agent", "WebSearch", "WebFetch", "ToolSearch", "BashOutput", "KillShell", "TaskOutput", "TaskStop", "ListAgents"].includes(name)) return { behavior: "allow" };
  return { behavior: "ask", reason: `uses ${name}` };
}


/** Pretty names for tool servers, so a request says who it really goes to. */
const SERVERS: Record<string, string> = { dojo: "Shifu Dojo", earshot: "Earshot", epidemic: "Epidemic Sound", envato: "Envato Elements", scrapecreators: "Scrape Creators" };

/**
 * A request in plain words, for the approval card: what will happen, the exact command, and the
 * web addresses and files it touches, so a person can decide without reading code.
 */
export function describeRequest(name: string, input: Record<string, unknown>) {
  const urls = new Set<string>();
  const files = new Set<string>();
  const text = JSON.stringify(input);
  for (const m of text.matchAll(/https?:\/\/[^\s"'\\)<>]+/g)) urls.add(m[0].replace(/[.,;]+$/, ""));
  if (name === "Bash") {
    const command = String(input.command ?? "");
    const { commands, redirects } = splitCommands(command);
    for (const r of redirects) if (r !== "/dev/null") files.add(r);
    for (const words of commands) {
      const { name: prog, args } = program(words);
      if ((prog === "curl" || prog === "wget") && args.length) {
        const o = args.findIndex((a) => a === "-o" || a === "-O" || a === "--output");
        if (o >= 0 && args[o + 1] && args[o] !== "-O") files.add(args[o + 1]);
      }
      if (["rm", "mv", "rmdir", "unlink", "chmod"].includes(prog)) for (const a of args) if (!a.startsWith("-")) files.add(a);
    }
    const said = typeof input.description === "string" && input.description.trim() ? input.description.trim() : null;
    const download = urls.size > 0 && /\b(curl|wget)\b/.test(command);
    return { action: said ?? (download ? "Download from the internet" : "Run a command on this Mac"), command, urls: [...urls].slice(0, 6), files: [...files].slice(0, 8), download };
  }
  if (name === "Write" || name === "Edit" || name === "NotebookEdit") return { action: `Change ${String(input.file_path ?? input.notebook_path ?? "a file")}`, command: null, urls: [...urls].slice(0, 6), files: [String(input.file_path ?? input.notebook_path ?? "")], download: false };
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "LS") return { action: `Look at ${String(input.file_path ?? input.path ?? "files")}`, command: null, urls: [], files: [String(input.file_path ?? input.path ?? "")], download: false };
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    const server = SERVERS[mcp[1]] ?? (mcp[1].startsWith("claude_ai_") ? `${mcp[1].slice(10).replace(/[-_]/g, " ")} (connected to your Claude account)` : mcp[1].replace(/[-_]/g, " "));
    return { action: `Use ${server}: ${mcp[2].replace(/^v\d+_/, "").replace(/_/g, " ")}`, command: Object.keys(input).length ? JSON.stringify(input, null, 1).slice(0, 2000) : null, urls: [...urls].slice(0, 6), files: [], download: false };
  }
  return { action: `Use ${name}`, command: Object.keys(input).length ? JSON.stringify(input, null, 1).slice(0, 2000) : null, urls: [...urls].slice(0, 6), files: [], download: false };
}
