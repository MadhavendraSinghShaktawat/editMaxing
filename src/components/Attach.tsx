import { Check, Film, ImageIcon, Link2, Loader2, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StoredFile, api, filePrint, uploadFile } from "../sim/engine";
import { Attachment, store } from "../sim/store";

/** `link` marks a video fetched from a pasted address rather than uploaded from this computer. */
export type Pending = Attachment & {
  progress: number; error?: string; source?: "link";
  /** The address it came from and the download following it, so a draft can carry on after a restart. */
  link?: string; job?: string;
  /** A short status, such as "120 MB of 480 MB" or "Already on this Mac". */
  note?: string;
};

const LIMITS = { image: 10 * 1024 * 1024 };

export const formatSize = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);
export const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Reads a real poster frame and duration in the browser, so nothing leaves the Mac for a preview. */
async function inspectVideo(file: File): Promise<{ thumb?: string; duration?: number }> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    v.src = url;
    await new Promise<void>((ok, bad) => {
      v.onloadedmetadata = () => ok();
      v.onerror = () => bad(new Error("unreadable"));
    });
    const duration = v.duration;
    v.currentTime = Math.min(duration * 0.2, 2);
    await new Promise<void>((ok) => {
      v.onseeked = () => ok();
      window.setTimeout(ok, 1200);
    });
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = Math.round((240 * v.videoHeight) / (v.videoWidth || 1)) || 135;
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    return { duration, thumb: c.toDataURL("image/jpeg", 0.8) };
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A pasted address, short enough to read in one row: "instagram.com/reel/DfGTuV5gxPW". */
const shortLink = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
};

type LinkResult = { file: StoredFile; platform: string; credits: number };

export function useAttachments(defaultRole: Attachment["role"]) {
  const [items, setItems] = useState<Pending[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach((t) => window.clearInterval(t)), []);

  const update = useCallback((id: string, patch: Partial<Pending>) => setItems((v) => v.map((x) => (x.id === id ? { ...x, ...patch } : x))), []);
  const fetched = useCallback((id: string, r: LinkResult) => update(id, { name: r.platform === "Google Drive" ? r.file.name : `${r.platform} video`, size: r.file.size, duration: r.file.meta.duration, hash: r.file.hash, job: undefined, error: undefined, progress: 1 }), [update]);

  /**
   * One link to one file. A link fetched before comes back at once; otherwise the engine downloads
   * it in the background, and this follows that download to the end, even after a restart.
   */
  const fetchOne = useCallback(async (id: string, url: string, name?: string, job?: string) => {
    const follow = (jobId: string) => store.waitJob<LinkResult>(jobId, (j) => update(id, { progress: 0.05 + 0.9 * (j.progress ?? 0), note: j.message }));
    try {
      if (job) {
        try {
          return fetched(id, await follow(job));
        } catch {
          // That job ended or was lost. Asking again reuses the file or the partial download.
        }
      }
      const r = await api<{ file: LinkResult } | { job: string }>("POST", "/api/links/fetch", { url, name });
      if ("file" in r) return fetched(id, r.file);
      update(id, { job: r.job });
      fetched(id, await follow(r.job));
    } catch (e) {
      update(id, { error: (e as Error).message, job: undefined });
    }
  }, [fetched, update]);

  const add = useCallback(
    async (files: Iterable<File>) => {
      for (const file of files) {
        const kind: Attachment["kind"] = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : "file";
        const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const tooBig = kind === "image" && file.size > LIMITS.image;
        const item: Pending = { id, name: file.name, kind, role: kind === "video" ? defaultRole : "file", size: file.size, progress: tooBig ? 0 : 0.03, error: tooBig ? "Images can be up to 10 MB" : undefined };
        setItems((v) => [...v, item]);
        if (tooBig) continue;
        const meta = kind === "video" ? await inspectVideo(file) : kind === "image" ? { thumb: URL.createObjectURL(file) } : {};
        update(id, meta);
        if (store.live) {
          // A file uploaded before is recognised by its fingerprint and not sent again.
          const print = await filePrint(file).catch(() => null);
          const known = print ? await api<StoredFile>("GET", `/api/files/print/${print}`).catch(() => null) : null;
          if (known) {
            update(id, { hash: known.hash, duration: known.meta.duration, progress: 1, note: "Already on this Mac" });
            continue;
          }
          uploadFile(file, (progress) => update(id, { progress }), print)
            .then((stored) => setItems((v) => v.map((x) => (x.id === id ? { ...x, hash: stored.hash, duration: x.duration ?? stored.meta.duration, progress: 1 } : x))))
            .catch((e: Error) => update(id, { error: e.message }));
          continue;
        }
        const timer = window.setInterval(() => {
          setItems((v) =>
            v.map((x) => {
              if (x.id !== id) return x;
              const progress = Math.min(1, x.progress + 0.08 + Math.random() * 0.1);
              if (progress === 1) window.clearInterval(timer);
              return { ...x, progress };
            }),
          );
        }, 90);
        timers.current.push(timer);
      }
    },
    [defaultRole, update],
  );

  /**
   * A pasted link: a Drive file, a social post, or (when `folders` is on) a Drive folder, which
   * becomes one row per video, fetched two at a time. A refused link keeps its row and its reason.
   */
  const addLink = useCallback(
    async (url: string, folders = false): Promise<unknown> => {
      if (folders && /drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\//.test(url)) {
        const { videos } = await api<{ videos: { id: string; name: string; url: string }[] }>("POST", "/api/links/folder", { url });
        const queued = videos.map((v, i) => ({ ...v, key: `drive-${v.id}-${Date.now()}-${i}` }));
        setItems((list) => [...list, ...queued.map((v) => ({ id: v.key, name: v.name, kind: "video" as const, role: defaultRole, size: 0, progress: 0.02, source: "link" as const, link: v.url }))]);
        let next = 0;
        await Promise.all([0, 1].map(async () => {
          while (next < queued.length) {
            const v = queued[next++];
            await fetchOne(v.key, v.url, v.name);
          }
        }));
        return { count: videos.length };
      }
      const id = `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setItems((v) => [...v, { id, name: shortLink(url), kind: "video", role: defaultRole, size: 0, progress: 0.05, source: "link", link: url }]);
      await fetchOne(id, url);
      return null;
    },
    [defaultRole, fetchOne],
  );

  /**
   * Brings back a saved draft. Finished files are ready at once, downloads carry on from where
   * they stopped, and an upload that was cut off asks for its file again.
   */
  const restore = useCallback((saved: Pending[]) => {
    setItems(saved.map((x) => (x.hash || x.error || x.link ? x : { ...x, error: "The upload stopped. Add this file again." })));
    let next = 0;
    const pending = saved.filter((x) => !x.hash && !x.error && x.link);
    void Promise.all([0, 1].map(async () => {
      while (next < pending.length) {
        const x = pending[next++];
        await fetchOne(x.id, x.link!, x.name, x.job);
      }
    }));
  }, [fetchOne]);

  /** Removing a row stops its download. What was fetched so far is kept, so adding it again carries on. */
  const remove = (id: string) => setItems((v) => {
    const x = v.find((y) => y.id === id);
    if (x?.job && x.progress < 1) void api("DELETE", `/api/jobs/${x.job}`).catch(() => {});
    return v.filter((y) => y.id !== id);
  });
  const setRole = (id: string, role: Attachment["role"]) => update(id, { role });
  const setTags = (id: string, tags: string[]) => update(id, { tags });
  const clear = () => setItems([]);
  // A failed item never blocks: it isn't sent, and it can be removed or left.
  const busy = items.some((x) => !x.error && x.progress < 1);
  const ready = (): Attachment[] => items.filter((x) => !x.error && x.progress >= 1).map(({ id, name, kind, role, size, duration, thumb, hash, tags }) => ({ id, name, kind, role, size, duration, thumb, hash, tags }));
  /** What a draft keeps: everything but local previews, which are rebuilt or not needed. */
  const snapshot = (): Pending[] => items.map(({ thumb: _thumb, ...x }) => x);
  return { items, add, addLink, restore, remove, setRole, setTags, clear, busy, ready, snapshot };
}

export function AttachButton({ onFiles, accept }: { onFiles: (f: FileList) => void; accept?: string }) {
  return (
    <label className="attach-btn" title="Attach a reference video or file">
      <Paperclip size={18} strokeWidth={2.3} />
      <span className="sr">Attach a file</span>
      <input
        type="file"
        multiple
        hidden
        accept={accept}
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </label>
  );
}

export function AttachmentStrip({ items, onRemove, onRole }: { items: Pending[]; onRemove: (id: string) => void; onRole: (id: string, role: Attachment["role"]) => void }) {
  if (!items.length) return null;
  return (
    <div className="attach-strip">
      {items.map((a) => (
        <div key={a.id} className={`attach-chip ${a.error ? "bad" : ""}`}>
          <span className="attach-thumb">
            {a.thumb ? <img src={a.thumb} alt="" /> : a.kind === "video" ? <Film size={18} /> : <ImageIcon size={18} />}
            {a.duration ? <em>{formatTime(a.duration)}</em> : null}
          </span>
          <span className="attach-info">
            <b title={a.name}>{a.name}</b>
            {a.error ? (
              <small>{a.error}</small>
            ) : a.progress < 1 ? (
              <small className="attach-load">
                <Loader2 size={11} /> Adding {Math.round(a.progress * 100)}%
              </small>
            ) : a.kind === "video" ? (
              <select value={a.role} aria-label="Use this video as" onChange={(e) => onRole(a.id, e.target.value as Attachment["role"])}>
                <option value="reference">Style reference</option>
                <option value="footage">Footage to edit</option>
              </select>
            ) : (
              <small>
                <Check size={11} /> {formatSize(a.size)}
              </small>
            )}
          </span>
          <button aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Paste a TikTok, Instagram, Facebook or other video link instead of a file. Without a Scrape
 * Creators key it says where to add one; an unsupported link shows the engine's reason.
 */
export function LinkInput({ onLink, label = "Or paste a video link" }: { onLink: (url: string) => Promise<unknown>; label?: string }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (value = url) => {
    setBusy(true);
    setError(null);
    try {
      await onLink(value.trim());
      setUrl("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="link-input">
      <form className="ui-inline" onSubmit={(e) => (e.preventDefault(), url.trim() && !busy && void submit())}>
        <Link2 size={15} className="t-muted" />
        <input className="ui-input" type="url" value={url} placeholder={label} aria-label={label} disabled={busy} onChange={(e) => { setUrl(e.target.value); setError(null); }} onPaste={(e) => { const t = e.clipboardData.getData("text/plain").trim(); if (/^https?:\/\/\S+$/i.test(t)) { e.preventDefault(); setUrl(t); void submit(t); } }} />
        <button type="submit" className="ui-btn v-secondary sm" disabled={!url.trim() || busy}>{busy ? <Loader2 size={13} className="ui-spin" /> : null}<span>{busy ? "Fetching" : "Add"}</span></button>
      </form>
      {error && <span className="link-error" role="alert">{error}</span>}
    </div>
  );
}
