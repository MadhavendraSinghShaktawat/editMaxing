import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTool } from "../src/claude/policy.ts";
import { creditBalance, fetchSocialVideo, platformOf, safeMediaUrl, videoCandidates } from "../src/social.ts";

test("supported links are recognised without spending a credit", () => {
  const cases: [string, string][] = [
    ["https://www.tiktok.com/@someone/video/7251387037834595630", "tiktok"],
    ["https://vm.tiktok.com/ZMabc123/", "tiktok"],
    ["https://www.instagram.com/reel/DfGTuV5gxPW/?cplk=Z3ow", "instagram"],
    ["https://instagram.com/p/Cabc123/", "instagram"],
    ["https://www.facebook.com/reel/1535656380759655", "facebook"],
    ["https://fb.watch/abc123/", "facebook"],
    ["https://x.com/someone/status/1790000000000000000", "twitter"],
    ["https://twitter.com/someone/status/1790000000000000000", "twitter"],
    ["https://www.threads.com/@trendspider/post/DIU8naHS6q_", "threads"],
    ["https://www.reddit.com/r/videos/comments/abc/def/", "reddit"],
    ["https://www.twitch.tv/staryuuki/clip/CloudySavage", "twitch"],
    ["https://kick.com/xqc/clips/clip_01JGJHB6", "kick"],
    ["https://rumble.com/v79xhhm-something.html", "rumble"],
  ];
  for (const [url, id] of cases) assert.equal(platformOf(url).platform.id, id, url);
});

test("unsupported links say why, and which ones work", () => {
  assert.throws(() => platformOf("https://www.youtube.com/watch?v=abc"), /isn.t supported.*details of YouTube/);
  assert.throws(() => platformOf("https://youtu.be/abc"), /isn't supported/);
  assert.throws(() => platformOf("https://www.linkedin.com/posts/x"), /isn't supported.*LinkedIn/);
  assert.throws(() => platformOf("https://vimeo.com/123"), /isn't supported\. Links that work: TikTok, Instagram/);
  assert.throws(() => platformOf("not a link"), /isn't a link/);
  assert.throws(() => platformOf("ftp://tiktok.com/x"), /isn't a web link/);
  assert.throws(() => platformOf("https://www.instagram.com/someone/"), /doesn't point to a single post/);
  assert.throws(() => platformOf("https://x.com/someone"), /doesn't point to a single post/);
});

test("TikTok prefers the no-watermark file, then clean streams, then the watermarked one", () => {
  const data = { aweme_detail: { video: { has_watermark: true, download_no_watermark_addr: { url_list: ["https://v16.tiktokcdn.com/nowm.mp4"] }, bit_rate: [{ bit_rate: 900000, play_addr: { url_list: ["https://v16.tiktokcdn.com/br.mp4"] } }], download_addr: { url_list: ["https://v16.tiktokcdn.com/wm.mp4?watermark=1"] }, cover: { url_list: ["https://p16.tiktokcdn.com/cover.jpeg"] } } } };
  assert.deepEqual(videoCandidates(data, "tiktok"), ["https://v16.tiktokcdn.com/nowm.mp4", "https://v16.tiktokcdn.com/br.mp4", "https://v16.tiktokcdn.com/wm.mp4?watermark=1"]);
});

test("the video is found under each platform's usual names, and images and pages never are", () => {
  assert.deepEqual(videoCandidates({ data: { xdt_shortcode_media: { video_url: "https://scontent.cdninstagram.com/o1/v/t2/a.mp4", display_url: "https://scontent.cdninstagram.com/b.jpg" } } }, "instagram"), ["https://scontent.cdninstagram.com/o1/v/t2/a.mp4"]);
  assert.deepEqual(videoCandidates({ video: { sd_url: "https://video.fbcdn.net/sd.mp4", hd_url: "https://video.fbcdn.net/hd.mp4" }, url: "https://www.facebook.com/reel/1" }, "facebook"), ["https://video.fbcdn.net/hd.mp4", "https://video.fbcdn.net/sd.mp4"]);
  const tweet = { legacy: { extended_entities: { media: [{ video_info: { variants: [{ content_type: "application/x-mpegURL", url: "https://video.twimg.com/a.m3u8" }, { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/low.mp4" }, { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/high.mp4" }] } }] } } };
  assert.equal(videoCandidates(tweet, "twitter")[0], "https://video.twimg.com/high.mp4");
  // Reddit's fallback file has no sound, so its stream comes first.
  assert.deepEqual(videoCandidates({ secure_media: { reddit_video: { fallback_url: "https://v.redd.it/x/DASH_720.mp4", hls_url: "https://v.redd.it/x/HLSPlaylist.m3u8" } } }, "reddit"), ["https://v.redd.it/x/HLSPlaylist.m3u8", "https://v.redd.it/x/DASH_720.mp4"]);
  assert.deepEqual(videoCandidates({ post: { caption: "text", image_versions2: { candidates: [{ url: "https://cdn/a.jpg" }] }, video_versions: null }, url: "https://www.threads.com/@a/post/b" }, "threads"), []);
});

test("only public https files are ever downloaded", () => {
  assert.ok(safeMediaUrl("https://v16.tiktokcdn.com/a.mp4"));
  for (const bad of ["http://cdn.example.com/a.mp4", "https://localhost/a.mp4", "https://127.0.0.1/a.mp4", "https://10.0.0.5/a.mp4", "https://192.168.1.2/a.mp4", "https://169.254.169.254/latest", "https://[::1]/a", "https://printer.local/a", "file:///etc/passwd", "https://intranet/a"]) assert.ok(!safeMediaUrl(bad), bad);
});

/** Pretends to be Scrape Creators and a CDN. */
function fake(routes: Record<string, (u: URL) => Response>) {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${u.host}${u.pathname}${u.searchParams.get("download_media") ? "?download_media" : ""}`);
    if (u.host === "api.scrapecreators.com") assert.ok((init?.headers as Record<string, string>)["x-api-key"], "the key is sent as x-api-key");
    for (const [k, h] of Object.entries(routes)) if (`${u.host}${u.pathname}`.startsWith(k)) return h(u);
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("a bad key, a missing post and an empty account each get a clear message", async () => {
  const files = {} as never;
  const tiktok = "https://www.tiktok.com/@a/video/1";
  for (const [status, msg] of [[401, /didn't accept your API key/], [402, /out of credits/], [404, /couldn't find that post/]] as const) {
    const { f } = fake({ "api.scrapecreators.com": () => new Response("{}", { status }) });
    await assert.rejects(fetchSocialVideo(files, "k", tiktok, { fetcher: f }), msg);
  }
  const { f } = fake({ "api.scrapecreators.com/v1/account/credit_balance": () => Response.json({ creditCount: 1292 }) });
  assert.equal(await creditBalance("k", f), 1292);
});

test("a post with no video says so, and a refused CDN falls back to the permanent copy once", async () => {
  const files = {} as never;
  const { f: textOnly } = fake({ "api.scrapecreators.com/v1/instagram/post": () => Response.json({ credits_charged: 1, data: { xdt_shortcode_media: { display_url: "https://cdn/x.jpg" } } }) });
  await assert.rejects(fetchSocialVideo(files, "k", "https://www.instagram.com/p/abc/", { fetcher: textOnly }), /has no video/);

  const { f, calls } = fake({
    "api.scrapecreators.com/v1/instagram/post": (u) => Response.json({ credits_charged: u.searchParams.get("download_media") ? 10 : 1, data: { xdt_shortcode_media: { video_url: u.searchParams.get("download_media") ? "https://perm.supabase.co/v.mp4" : "https://scontent.cdninstagram.com/o1/v/a.mp4" } } }),
    "scontent.cdninstagram.com": () => new Response("forbidden", { status: 403 }),
    "perm.supabase.co": () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  await assert.rejects(fetchSocialVideo(files, "k", "https://www.instagram.com/reel/abc/", { fetcher: f }), /couldn't be downloaded/);
  assert.deepEqual(calls, ["api.scrapecreators.com/v1/instagram/post", "scontent.cdninstagram.com/o1/v/a.mp4", "api.scrapecreators.com/v1/instagram/post?download_media", "perm.supabase.co/v.mp4"]);
});

test("a redirect to a private address is refused", async () => {
  const { f } = fake({
    "api.scrapecreators.com/v1/facebook/post": () => Response.json({ video: { hd_url: "https://video.fbcdn.net/a.mp4" } }),
    "video.fbcdn.net": () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } }),
  });
  await assert.rejects(fetchSocialVideo({} as never, "k", "https://www.facebook.com/reel/1", { fetcher: f }), /redirected somewhere private/);
});

test("Scrape Creators tools in a chat run without asking, because the person turned them on", () => {
  assert.equal(checkTool("mcp__scrapecreators__v1_tiktok_profile", {}, "/tmp/w", new Set(), []).behavior, "allow");
});
