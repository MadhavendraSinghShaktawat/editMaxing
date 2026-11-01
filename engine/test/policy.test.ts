import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBash, checkTool, splitCommands } from "../src/claude/policy.ts";

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
