import { Check, Film, ImageIcon, Link2, Loader2, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StoredFile, api, uploadFile } from "../sim/engine";
import { Attachment, store } from "../sim/store";

/** `link` marks a video fetched from a pasted address rather than uploaded from this computer. */
export type Pending = Attachment & { progress: number; error?: string; source?: "link" };

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

export function useAttachments(defaultRole: Attachment["role"]) {
  const [items, setItems] = useState<Pending[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach((t) => window.clearInterval(t)), []);

  const add = useCallback(
    async (files: Iterable<File>) => {
      for (const file of files) {
        const kind: Attachment["kind"] = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : "file";
        const id = `${file.name}-${file.size}-${Date.now()}`;
        const tooBig = kind === "image" && file.size > LIMITS.image;
        const item: Pending = { id, name: file.name, kind, role: kind === "video" ? defaultRole : "file", size: file.size, progress: tooBig ? 0 : 0.03, error: tooBig ? "Images can be up to 10 MB" : undefined };
        setItems((v) => [...v, item]);
        if (tooBig) continue;
        const meta = kind === "video" ? await inspectVideo(file) : kind === "image" ? { thumb: URL.createObjectURL(file) } : {};
        setItems((v) => v.map((x) => (x.id === id ? { ...x, ...meta } : x)));
        if (store.live) {
          // Files stay on this Mac. The engine stores each one by content, so a re-upload costs nothing.
          uploadFile(file, (progress) => setItems((v) => v.map((x) => (x.id === id ? { ...x, progress } : x))))
            .then((stored) => setItems((v) => v.map((x) => (x.id === id ? { ...x, hash: stored.hash, duration: x.duration ?? stored.meta.duration, progress: 1 } : x))))
            .catch((e: Error) => setItems((v) => v.map((x) => (x.id === id ? { ...x, error: e.message } : x))));
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
    [defaultRole],
  );

  /**
   * A social video link, downloaded on the Mac through the person's Scrape Creators key. An
   * unsupported link is refused at once and never added; the caller shows why.
   */
  const addLink = useCallback(
    async (url: string, folders = false): Promise<unknown> => {
      // A Drive folder becomes one clip per video in it, fetched two at a time.
      if (folders && /drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\//.test(url)) {
        const { videos } = await api<{ videos: { id: string; name: string; url: string }[] }>("POST", "/api/links/folder", { url });
        const queued = videos.map((v, i) => ({ ...v, key: `drive-${v.id}-${Date.now()}-${i}` }));
        setItems((list) => [...list, ...queued.map((v) => ({ id: v.key, name: v.name, kind: "video" as const, role: defaultRole, size: 0, progress: 0.02, source: "link" as const }))]);
        let next = 0;
        await Promise.all([0, 1].map(async () => {
          while (next < queued.length) {
            const v = queued[next++];
            setItems((list) => list.map((x) => (x.id === v.key ? { ...x, progress: 0.3 } : x)));
            try {
              const r = await api<{ file: StoredFile }>("POST", "/api/links/fetch", { url: v.url });
              setItems((list) => list.map((x) => (x.id === v.key ? { ...x, name: r.file.name, size: r.file.size, duration: r.file.meta.duration, hash: r.file.hash, progress: 1 } : x)));
            } catch (e) {
              setItems((list) => list.map((x) => (x.id === v.key ? { ...x, error: (e as Error).message } : x)));
            }
          }
        }));
        return { count: videos.length };
      }
      const id = `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // The row stays whatever happens, so a refused link keeps its reason on screen instead of vanishing.
      setItems((v) => [...v, { id, name: shortLink(url), kind: "video", role: defaultRole, size: 0, progress: 0.05, source: "link" }]);
      try {
        const r = await api<{ file: StoredFile; platform: string; credits: number }>("POST", "/api/links/fetch", { url });
        setItems((v) => v.map((x) => (x.id === id ? { ...x, name: r.platform === "Google Drive" ? r.file.name : `${r.platform} video`, size: r.file.size, duration: r.file.meta.duration, hash: r.file.hash, thumb: undefined, progress: 1 } : x)));
        return r;
      } catch (e) {
        setItems((v) => v.map((x) => (x.id === id ? { ...x, error: (e as Error).message } : x)));
        return null;
      }
    },
    [defaultRole],
  );

  const remove = (id: string) => setItems((v) => v.filter((x) => x.id !== id));
  const setRole = (id: string, role: Attachment["role"]) => setItems((v) => v.map((x) => (x.id === id ? { ...x, role } : x)));
  const clear = () => setItems([]);
  // A failed item never blocks: it isn't sent, and it can be removed or left.
  const busy = items.some((x) => !x.error && x.progress < 1);
  const ready = (): Attachment[] => items.filter((x) => !x.error && x.progress >= 1).map(({ id, name, kind, role, size, duration, thumb, hash }) => ({ id, name, kind, role, size, duration, thumb, hash }));
  return { items, add, addLink, remove, setRole, clear, busy, ready };
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
