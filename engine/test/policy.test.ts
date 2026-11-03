import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAgent, checkBash, checkTool, splitCommands } from "../src/claude/policy.ts";

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
