/** Thin client for the local engine. Every call stays on this Mac. */
export type LimitWindow = { id: string; label: string; kind: "session" | "weekly" | "model"; usedPercent: number; resetsAt: string | null };
export type EngineModel = { id: string; name: string; description: string; resolved: string | null; efforts: string[]; fable: boolean };
export type Account = { id: string; label: string; kind: "subscription" | "api_key"; email: string | null; plan: string | null; signedIn: boolean; models: EngineModel[]; limits: LimitWindow[]; limitsAt: number | null };
export type Brief = { title?: string; modeId?: string | null; styleId?: string | null; reason?: string; locale?: string };
export type ChatStatus = "idle" | "working" | "thinking" | "needs" | "stuck" | "resting";
export type ChatView = { id: string; name: string; look: number; accountId: string; model: string; effort: string | null; status: ChatStatus; detail: string; station: string; stage: string | null; mission: Brief | null; createdAt: number };
export type EngineMessage = { id: number; chatId?: string; role: string; kind: string; text: string; data: Record<string, unknown> | null };
export type EngineDecision = { id: string; chatId: string; kind: string; payload: Record<string, unknown> };
export type StyleRule = { rule: string; area?: string; confidence?: string; evidence?: { at: number; note: string }[] };
export type StyleArea = { summary?: string; rules?: StyleRule[] };
export const STYLE_AREAS = [["pacing", "Pacing"], ["editing", "Editing style"], ["audio", "Audio"], ["captions", "Captions"], ["positioning", "Positioning"], ["motion", "Motion"], ["animation", "Animation"], ["effects", "Effects and transitions"]] as const;
export type StyleCard = { summary?: string; structure?: string; rules?: StyleRule[]; colors?: string[]; rejected?: { rule: string; reason: string }[]; unsure?: string[]; anyPerson?: string[] } & { [K in (typeof STYLE_AREAS)[number][0]]?: StyleArea };
export type EngineStyle = { id: string; name: string; status: string; mode: string | null; card: StyleCard; shared?: boolean; author?: string | null };
export type Recipe = { id: string; title: string; text: string; uses: number };
export type MemoryRule = { id: string; text: string; mode: string | null };
export type Pack = { id: string; name: string; about: string; size: string; installed: boolean };
export type LibraryStats = { clips: number; shots: number; analyzed: number; embedded: number; pending: number; percentPerShot: number | null };
export type Job = { id: string; kind: string; status: string; progress?: number; message?: string; error?: string | null; result?: unknown };
export type StoredFile = { hash: string; path: string; name: string; size: number; kind: string; meta: { duration?: number } };
export type State = {
  accounts: Account[]; chats: ChatView[]; decisions: EngineDecision[]; jobs: Job[]; library: LibraryStats; styles: EngineStyle[]; modes: { id: string; label: string; rules: string }[];
  recipes: Recipe[]; memory: MemoryRule[]; packs: Pack[]; keys: Record<string, boolean>; settings: { account: string; model: string; effort: string; embedModel: string };
};

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error ?? "The engine didn't respond.");
  return data as T;
}

/** XHR rather than fetch, because only XHR reports upload progress. */
export function uploadFile(file: File, onProgress: (v: number) => void) {
  return new Promise<StoredFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/files?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.min(0.98, e.loaded / e.total));
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText) as StoredFile) : reject(new Error("The upload failed.")));
    xhr.onerror = () => reject(new Error("The upload failed."));
    xhr.send(file);
  });
}

export const EVENT_TYPES = ["chat", "chat.ended", "message", "delta", "decision", "decision.closed", "account", "account.removed", "account.login", "job", "library", "library.warning", "style", "style.removed", "recipe", "memory", "limit"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function connect(onEvent: (type: EventType, data: never) => void, onOpen: () => void, onLost: () => void) {
  const source = new EventSource("/api/events");
  source.onopen = onOpen;
  source.onerror = onLost;
  for (const type of EVENT_TYPES) source.addEventListener(type, (e) => onEvent(type, JSON.parse((e as MessageEvent<string>).data) as never));
  return () => source.close();
}

/** How much of a window is left, as 0 to 1, for the life bars. */
export const leftOf = (w: LimitWindow | undefined) => (w ? Math.max(0, 1 - w.usedPercent / 100) : null);

export function resetLabel(iso: string | null | undefined) {
  if (!iso) return "unknown";
  const min = Math.max(0, (new Date(iso).getTime() - Date.now()) / 60000);
  if (min >= 1440) return `${Math.round(min / 1440)}d`;
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
