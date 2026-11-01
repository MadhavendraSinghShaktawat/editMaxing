import { isAbsolute, relative, resolve } from "node:path";

export type Verdict = { behavior: "allow" } | { behavior: "ask"; reason: string } | { behavior: "deny"; reason: string };

/** Reads, listing and media work that can't harm anything. */
const SAFE = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "sed", "awk", "sort", "uniq", "cut", "tr", "echo", "printf", "pwd", "date", "basename", "dirname", "realpath", "stat", "file", "du", "df", "which", "true", "false", "test", "[", "jq", "sips", "ffmpeg", "ffprobe", "node", "npm", "npx", "python3", "python", "bash", "sh", "mkdir", "touch", "cp", "ln", "tee", "seq", "sleep", "pip", "pip3", "env", "cd", "export", "xargs", "find", "shasum", "open"]);

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

const program = (words: string[]) => {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  return { name: (words[i] ?? "").split("/").pop() ?? "", args: words.slice(i + 1) };
};

export const inside = (path: string, root: string) => {
  const rel = relative(root, resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Paths under a mission's work folders are the editor's own and safe to change. */
export function checkBash(command: string, workspace: string, allowed: Set<string>): Verdict {
  const { commands, redirects, substitution } = splitCommands(command);
  for (const target of redirects) {
    if (target !== "/dev/null" && !inside(target, workspace)) return { behavior: "ask", reason: `writes outside this mission: ${target}` };
  }
  for (const words of commands) {
    const { name, args } = program(words);
    if (!name || allowed.has(name)) continue;
    if (name === "rm" || name === "mv" || name === "rmdir" || name === "unlink" || name === "shred") {
      const paths = args.filter((a) => !a.startsWith("-"));
      const outside = paths.find((p) => !inside(p, workspace));
      if (outside) return { behavior: "ask", reason: `deletes or moves something outside this mission: ${outside}` };
      if (paths.some((p) => /(^|\/)inputs(\/|$)/.test(p))) return { behavior: "ask", reason: "deletes or moves your source footage" };
      continue;
    }
    if (name === "find" && args.includes("-delete")) return { behavior: "ask", reason: "bulk deletes files" };
    if (name === "open" && args.some((a) => /^https?:/.test(a))) return { behavior: "ask", reason: "opens a website" };
    if ((name === "curl" || name === "wget") && !args.some((a) => SENDS.test(a))) continue;
    const sensitive = SENSITIVE.get(name);
    if (sensitive) return { behavior: "ask", reason: `${name} ${sensitive}` };
    if (!SAFE.has(name)) return { behavior: "ask", reason: `runs ${name}` };
  }
  if (substitution && commands.some((w) => ["rm", "mv"].includes(program(w).name))) return { behavior: "ask", reason: "deletes files chosen by a nested command" };
  return { behavior: "allow" };
}

export function checkTool(name: string, input: Record<string, unknown>, workspace: string, allowed: Set<string>, readable: string[]): Verdict {
  if (allowed.has(name)) return { behavior: "allow" };
  if (name === "Bash") return checkBash(String(input.command ?? ""), workspace, allowed);
  if (name === "Write" || name === "Edit" || name === "NotebookEdit") {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    if (!inside(path, workspace)) return { behavior: "ask", reason: `changes a file outside this mission: ${path}` };
    if (/(^|\/)inputs\//.test(path)) return { behavior: "ask", reason: "changes your source footage" };
    return { behavior: "allow" };
  }
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "LS") {
    const path = String(input.file_path ?? input.path ?? workspace);
    if ([workspace, ...readable].some((root) => inside(path, root))) return { behavior: "allow" };
    return { behavior: "ask", reason: `reads a file outside this mission: ${path}` };
  }
  if (name.startsWith("mcp__dojo__") || name.startsWith("mcp__earshot__") || name.startsWith("mcp__epidemic__")) return { behavior: "allow" };
  if (["Skill", "TodoWrite", "Task", "Agent", "WebSearch", "WebFetch", "ToolSearch", "BashOutput", "KillShell", "TaskOutput", "TaskStop"].includes(name)) return { behavior: "allow" };
  return { behavior: "ask", reason: `uses ${name}` };
}
