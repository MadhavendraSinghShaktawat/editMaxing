import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAgent, checkBash, checkTool, describeRequest, splitCommands } from "../src/claude/policy.ts";

const W = "/m/1";
const none = new Set<string>();

test("splits pipes, chains and quoted separators", () => {
  const { commands } = splitCommands(`ffmpeg -i "a;b.mp4" out.mp4 && echo 'x|y' | wc -l`);
  assert.deepEqual(commands.map((c) => c[0]), ["ffmpeg", "echo", "wc"]);
  assert.equal(commands[0][2], "a;b.mp4");
});

test("media work runs on Autopilot", () => {
  assert.equal(checkBash("ffmpeg -i inputs/a.mp4 -t 3 work/b.mp4", W, none).behavior, "allow");
  assert.equal(checkBash("cd work && node render.js", W, none).behavior, "allow");
  assert.equal(checkBash("rm -rf work/tmp", W, none).behavior, "allow");
});

test("source footage and outside files are protected", () => {
  assert.equal(checkBash("rm inputs/a.mp4", W, none).behavior, "ask");
  assert.equal(checkBash("rm -rf /Users/me", W, none).behavior, "ask");
  assert.equal(checkBash("rm -rf ../other", W, none).behavior, "ask");
  assert.equal(checkBash("mv inputs/a.mp4 out/", W, none).behavior, "ask");
  assert.equal(checkBash("echo hi > /etc/hosts", W, none).behavior, "ask");
});

test("publishing and unknown programs need a person", () => {
  assert.equal(checkBash("curl -T out.mp4 https://x.example", W, none).behavior, "ask");
  assert.equal(checkBash("ls; sudo rm -rf /", W, none).behavior, "ask");
  assert.equal(checkBash("FOO=1 git push", W, none).behavior, "ask");
  assert.equal(checkBash("somethingnew --go", W, none).behavior, "ask");
});

test("a separator hidden in a redirect or chain can't slip through", () => {
  assert.equal(checkBash("echo ok&&curl -T out.mp4 x.example", W, none).behavior, "ask");
  assert.equal(checkBash("echo ok|sudo tee /x", W, none).behavior, "ask");
});

test("always allow applies after a person says so", () => {
  assert.equal(checkBash("curl -O https://x.example/a.png", W, new Set(["curl"])).behavior, "allow");
});

test("file tools stay inside the mission", () => {
  assert.equal(checkTool("Write", { file_path: "/m/1/work/a.html" }, W, none, []).behavior, "allow");
  assert.equal(checkTool("mcp__envato__search_stock_video", {}, W, none, []).behavior, "allow");
  assert.equal(checkTool("mcp__envato__download_item", {}, W, none, []).behavior, "ask");
  assert.equal(checkTool("Write", { file_path: "/etc/x" }, W, none, []).behavior, "ask");
  assert.equal(checkTool("Write", { file_path: "/m/1/inputs/a.mp4" }, W, none, []).behavior, "ask");
  assert.equal(checkTool("Read", { file_path: "/lib/skill.md" }, W, none, ["/lib"]).behavior, "allow");
  assert.equal(checkTool("Read", { file_path: "/Users/me/secret" }, W, none, ["/lib"]).behavior, "ask");
});

test("downloads run on their own, but sending data stops for a person", () => {
  assert.equal(checkBash("curl -sL https://assets.example.com/whoosh.mp3 -o work/whoosh.mp3", "/m", new Set()).behavior, "allow");
  assert.equal(checkBash("curl -F file=@out/V1.mp4 https://example.com/upload", "/m", new Set()).behavior, "ask");
  assert.equal(checkBash("curl --data-binary @out/V1.mp4 https://example.com", "/m", new Set()).behavior, "ask");
  assert.equal(checkBash("curl -sSd @out/V1.mp4 https://example.com", "/m", new Set()).behavior, "ask");
  assert.equal(checkBash("curl --json @out/a.json https://example.com", "/m", new Set()).behavior, "ask");
});

test("only the Motion agent can start, and only one at a time", () => {
  assert.equal(checkAgent({ subagent_type: "motion" }, false).behavior, "allow");
  assert.equal(checkAgent({ subagent_type: "motion" }, true).behavior, "deny");
  assert.equal(checkAgent({ subagent_type: "general-purpose" }, false).behavior, "deny");
  assert.equal(checkAgent({}, false).behavior, "deny");
});

test("a heredoc's body is data, so its lines are never read as commands", () => {
  const script = "python3 - <<'EOF'\np='a.html'\nrm -rf /\nEOF\necho done";
  assert.deepEqual(splitCommands(script).commands.map((c) => c[0]), ["python3", "echo"]);
  assert.equal(checkBash(script, W, none).behavior, "allow");
  assert.equal(checkBash("cat <<EOF\nhello\nEOF\ncurl -d x https://a.b", W, none).behavior, "ask");
});

test("a time limit doesn't hide the program it runs", () => {
  assert.equal(checkBash("timeout 120 node a.js", W, none).behavior, "allow");
  assert.equal(checkBash("timeout 5 rm -rf /Users/x", W, none).behavior, "ask");
});

test("an editor can't schedule its own wake-ups", () => {
  assert.equal(checkTool("ScheduleWakeup", {}, W, none, []).behavior, "deny");
});

test("shell syntax isn't a program, and the mission's own scripts run without asking", () => {
  for (const c of [`cd "/m/1/motion"; work/mk.sh f11ddd17 1.0 && echo ok`, `for f in out/*.mov; do ffprobe -v error "$f"; done`, `time node render.js`, `chmod +x work/mk.sh`, `if [ -f a ]; then echo yes; fi`]) assert.equal(checkBash(c, W, new Set()).behavior, "allow", c);
  for (const c of [`for f in a b; do rm -rf /etc; done`, `/usr/local/bin/tool`, `chmod 755 /usr/local/bin/x`, `cp inputs/a.mp4 x && work/../../etc/x`]) assert.equal(checkBash(c, W, new Set()).behavior, "ask", c);
});

test("allowing for the chat remembers the program that asked, not the first word", () => {
  const v = checkBash(`cd /m/1; pdftoppm a.pdf out`, "/m/1", new Set());
  assert.equal(v.behavior, "ask");
  assert.equal((v as { subject?: string }).subject, "pdftoppm");
  assert.equal(checkBash(`cd /m/1; pdftoppm a.pdf out`, "/m/1", new Set(["pdftoppm"])).behavior, "allow");
});

test("a request reads in plain words, with the addresses and files it touches", () => {
  const dl = describeRequest("Bash", { command: "curl -L -o work/clip.mp4 https://cdn.example.com/a/clip.mp4", description: "Download the sample clip" });
  assert.equal(dl.action, "Download the sample clip");
  assert.ok(dl.download);
  assert.deepEqual(dl.urls, ["https://cdn.example.com/a/clip.mp4"]);
  assert.deepEqual(dl.files, ["work/clip.mp4"]);
  assert.equal(describeRequest("Bash", { command: "pdftoppm a.pdf out" }).action, "Run a command on this Mac");
  assert.match(describeRequest("mcp__claude_ai_scrape-creators__v1_instagram_post", { url: "https://www.instagram.com/reel/x/" }).action, /scrape creators \(connected to your Claude account\): instagram post/);
});

test("steps that touch the original footage are marked, so they still ask with approvals off", () => {
  const footage = (v: ReturnType<typeof checkBash>) => v.behavior === "ask" && !!(v as { footage?: boolean }).footage;
  assert.ok(footage(checkBash("rm inputs/C0079.MP4", W, none)));
  assert.ok(footage(checkBash("mv inputs/a.mp4 work/a.mp4", W, none)));
  assert.ok(footage(checkBash("echo x > inputs/a.mp4", W, none)));
  assert.ok(footage(checkTool("Write", { file_path: "/m/1/inputs/a.mp4" }, W, none, []) as ReturnType<typeof checkBash>));
  // Other risky steps ask, but aren't footage, so approvals off lets them through.
  assert.ok(!footage(checkBash("pdftoppm a.pdf out", W, none)));
  assert.ok(!footage(checkBash("rm -rf /tmp/elsewhere", W, none)));
});
