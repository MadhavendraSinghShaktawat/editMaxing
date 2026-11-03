import { Readable } from "node:stream";
import type { Files } from "./files.ts";
import { TokenBucket } from "./lib/dsa.ts";

export type DriveLink = { kind: "file" | "folder"; id: string };

export function parseDriveLink(url: string): DriveLink | null {
  const text = url.trim();
  const folder = text.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]{10,})/);
  if (folder) return { kind: "folder", id: folder[1] };
  const file = text.match(/drive\.google\.com\/file\/(?:u\/\d+\/)?d\/([\w-]{10,})/) ?? text.match(/drive\.(?:google|usercontent\.google)\.com\/(?:uc|open|download)\?(?:.*&)?id=([\w-]{10,})/);
  return file ? { kind: "file", id: file[1] } : null;
}

const limiter = new TokenBucket(5, 5);
const API = "https://www.googleapis.com/drive/v3/files";

export type DriveFile = { id: string; name: string; mimeType: string; size?: string; md5Checksum?: string };

/** Listing a shared folder needs a Google API key. Single public files don't. */
export async function listFolder(id: string, apiKey: string, fetcher: typeof fetch = fetch) {
  const out: DriveFile[] = [];
  const folders = [id];
  const seen = new Set(folders);
  while (folders.length) {
    const parent = folders.pop()!;
    let page: string | undefined;
    do {
      await limiter.take();
      const params = new URLSearchParams({ q: `'${parent}' in parents and trashed = false`, key: apiKey, fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      if (page) params.set("pageToken", page);
      const res = await fetcher(`${API}?${params}`);
      if (!res.ok) throw new Error(`Google Drive refused the folder (${res.status}). Check that it's shared with anyone who has the link.`);
      const body = (await res.json()) as { nextPageToken?: string; files?: DriveFile[] };
      for (const f of body.files ?? []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          if (!seen.has(f.id)) {
            seen.add(f.id);
            folders.push(f.id);
          }
        } else if (f.mimeType.startsWith("video/")) out.push(f);
      }
      page = body.nextPageToken;
    } while (page);
  }
  return out;
}

export async function downloadFile(files: Files, id: string, name: string, apiKey: string | null, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  await limiter.take();
  const url = apiKey ? `${API}/${id}?alt=media&key=${encodeURIComponent(apiKey)}&supportsAllDrives=true` : `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  const res = await fetcher(url, { signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Google Drive refused ${name} (${res.status}). Check its sharing setting.`);
  if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new Error(`${name} isn't downloadable. It may be private, or Google has limited it for now.`);
  const disposition = res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1];
  return files.fromStream(Readable.fromWeb(res.body as never), name || disposition || `${id}.mp4`);
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Reads Drive's public folder page: each entry's id, name, and whether it's a video or a folder. */
export function parseFolderPage(html: string) {
  const videos: { id: string; name: string }[] = [];
  const folders: string[] = [];
  for (const m of html.matchAll(/class="flip-entry" id="entry-([\w-]+)"[\s\S]*?href="([^"]+)"[\s\S]*?\/type\/([^"]+)"[\s\S]*?class="flip-entry-title">([^<]*)</g)) {
    const [, id, href, type, name] = m;
    if (/\/folders\//.test(href) || /folder/.test(type)) folders.push(id);
    else if (/^video\//.test(type) || /\.(mp4|mov|m4v|mkv|webm|avi|mts|mxf)$/i.test(name)) videos.push({ id, name: decode(name.trim()) });
  }
  return { videos, folders };
}

/**
 * Every video in a folder shared with "Anyone with the link", including subfolders. Uses the
 * studio's Google key when there is one, and Drive's public folder page when there isn't.
 */
export async function folderVideos(id: string, apiKey: string | null, fetcher: typeof fetch = fetch) {
  if (apiKey) return (await listFolder(id, apiKey, fetcher)).map((f) => ({ id: f.id, name: f.name }));
  const out: { id: string; name: string }[] = [];
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length && seen.size <= 50) {
    const folder = queue.shift()!;
    await limiter.take();
    const res = await fetcher(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folder)}`);
    const html = res.ok ? await res.text() : "";
    if (!html.includes("flip-entries")) {
      if (folder === id) throw new Error("Google Drive won't show that folder. Set it to “Anyone with the link”.");
      continue;
    }
    const page = parseFolderPage(html);
    out.push(...page.videos);
    for (const f of page.folders) if (!seen.has(f)) (seen.add(f), queue.push(f));
  }
  return out;
}
