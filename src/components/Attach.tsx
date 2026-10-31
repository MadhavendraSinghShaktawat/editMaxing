import { Check, Film, ImageIcon, Loader2, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Attachment } from "../sim/store";

export type Pending = Attachment & { progress: number; error?: string };

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
        // Stand-in for the local engine copying the file into the mission folder.
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

  const remove = (id: string) => setItems((v) => v.filter((x) => x.id !== id));
  const setRole = (id: string, role: Attachment["role"]) => setItems((v) => v.map((x) => (x.id === id ? { ...x, role } : x)));
  const clear = () => setItems([]);
  const busy = items.some((x) => x.progress < 1 || x.error);
  const ready = (): Attachment[] => items.filter((x) => !x.error).map(({ id, name, kind, role, size, duration, thumb }) => ({ id, name, kind, role, size, duration, thumb }));
  return { items, add, remove, setRole, clear, busy, ready };
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
