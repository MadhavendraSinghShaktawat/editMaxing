import { useEffect, useState } from "react";
import { ArrowLeft, Bolt, ChevronDown, Clapperboard, Download, ExternalLink, Film, FileText, KeyRound, Link2, Loader2, LogOut, Move3d, Plus, RefreshCw, Scissors, Search, Send, Smartphone, Sparkles, Trash2, Type, UploadCloud, Wand2, X } from "lucide-react";
import { TOOLS } from "../sim/data";
import { EngineStyle, Job, STYLE_AREAS, StoredFile, StyleRule, api, resetLabel, uploadFile } from "../sim/engine";
import { store, useStore } from "../sim/store";
import { LinkInput, Pending, formatSize, formatTime, useAttachments } from "./Attach";
import { BoardId } from "./Hud";
import { MotionBoard, MotionPreview } from "./Motion";
import { ModelPicker } from "./ModelPicker";
import { SettingsBoard } from "./Settings";
import { Badge, Button, Confirm, Dropzone, EmptyState, FileButton, IconButton, Item, Meta, Modal, Progress, Segmented, Select } from "./ui";

const JOB_DONE = new Set(["done", "failed", "cancelled"]);

/** A running job: what it's doing, how far along, and a way to stop it. */
function JobItem({ job }: { job: Job }) {
  if (JOB_DONE.has(job.status)) return job.error ? <Item icon={<X size={18} />} title={<span className="t-bad">Didn't finish</span>} meta={job.error} /> : null;
  const pct = Math.round((job.progress ?? 0) * 100);
  return (
    <Item
      icon={<Loader2 size={18} className="ui-spin" />}
      title={job.message ?? "Queued"}
      meta={<span className="t-accent">{pct}%</span>}
      actions={<Button size="sm" variant="ghost" onClick={() => void store.attempt(() => api("DELETE", `/api/jobs/${job.id}`))}>Cancel</Button>}
    >
      <Progress value={job.progress ?? 0} />
    </Item>
  );
}

/** A file being added: size, length, and live upload state. */
function FileItem({ a, onRemove, children }: { a: Pending; onRemove: (id: string) => void; children?: React.ReactNode }) {
  const uploading = !a.error && a.progress < 1;
  const status = a.error ? <span className="t-bad">{a.error}</span> : uploading ? <span className="t-accent">{a.note ?? (a.source === "link" ? "Fetching…" : "Uploading…")}</span> : <span className="t-ok">{a.note === "Already on this Mac" ? a.note : "Ready"}</span>;
  return (
    <Item
      icon={a.thumb ? <img src={a.thumb} alt="" /> : a.source === "link" ? <Link2 size={18} /> : <Film size={18} />}
      title={a.name}
      meta={<Meta parts={[a.size ? formatSize(a.size) : null, a.duration ? formatTime(a.duration) : null, status]} />}
      actions={<IconButton label={`Remove ${a.name}`} onClick={() => onRemove(a.id)}><X size={16} /></IconButton>}
    >
      {uploading && <Progress value={a.progress} />}
      {children}
    </Item>
  );
}

/** What a reference is for. None picked means the editor studies all of it. */
const REFERENCE_TAGS: { id: string; label: string }[] = [
  { id: "editing", label: "Editing" }, { id: "motion", label: "Motion graphics" }, { id: "explainer", label: "Explainer graphics" }, { id: "captions", label: "Captions" }, { id: "sound", label: "Sound" },
];

function TagChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="ui-chips ref-tags" role="group" aria-label="Use this reference for">
      {REFERENCE_TAGS.map((t) => {
        const on = value.includes(t.id);
        return <button key={t.id} type="button" aria-pressed={on} className={`ui-chip sm ${on ? "is-on" : ""}`} onClick={() => onChange(on ? value.filter((v) => v !== t.id) : [...value, t.id])}>{t.label}</button>;
      })}
    </div>
  );
}

type VideoDraft = { v: 1; footage: Pending[]; refs: Pending[]; prompt: string; script: string | null; styleId: string | null; clientId: string; locale: string; accountId: string; model: { model: string; effort: string } };

// ── New video ──────────────────────────────────────────────────

export function NewMission({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const styles = s.styles.filter((v) => v.status === "approved");
  const footage = useAttachments("footage");
  const refs = useAttachments("reference");
  const [styleId, setStyleId] = useState<string | null>(null);
  const [locale, setLocale] = useState("en-US");
  const [accountId, setAccountId] = useState(s.settings.account);
  const [model, setModel] = useState(s.lastModel);
  const [prompt, setPrompt] = useState("");
  const [script, setScript] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [clientId, setClientId] = useState("");
  const [restored, setRestored] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const myClients = s.clients.filter((c) => c.members.includes(s.me?.id ?? "") || s.me?.role === "owner" || s.me?.role === "admin");
  const signedIn = s.accounts.filter((a) => a.signedIn);
  const video = footage.ready()[0];
  const owner = (id?: string | null) => s.members.find((m) => m.id === id)?.name ?? "a colleague";
  const clips = footage.ready();
  // A clip that failed doesn't block the start; the rest still go to the editor.
  const footageBusy = footage.items.some((x) => !x.error && x.progress < 1);
  const canStart = !!video && !footageBusy && !refs.busy && !reading;
  const reference = refs.ready();
  const readScript = (f: File) => void s.attempt(async () => {
    setReading(true);
    try {
      if (/\.(txt|md|srt|vtt)$/i.test(f.name)) setScript(await f.text());
      else setScript((await api<{ text: string }>("POST", "/api/text/extract", { hash: (await uploadFile(f, () => {})).hash })).text);
    } finally {
      setReading(false);
    }
  });

  // The draft comes back when New video opens again, even after the app quit.
  useEffect(() => {
    void api<{ draft: VideoDraft | null }>("GET", "/api/drafts/new-video").then(({ draft }) => {
      if (draft?.v === 1) {
        footage.restore(draft.footage ?? []);
        refs.restore(draft.refs ?? []);
        setPrompt(draft.prompt ?? "");
        setScript(draft.script ?? null);
        if (!draft.styleId || s.styles.some((x) => x.id === draft.styleId)) setStyleId(draft.styleId ?? null);
        setClientId(draft.clientId ?? "");
        setLocale(draft.locale ?? "en-US");
        if (draft.accountId && s.accounts.some((a) => a.id === draft.accountId)) setAccountId(draft.accountId);
        if (draft.model?.model) setModel(draft.model);
        setRestored(!!(draft.footage?.length || draft.refs?.length || draft.prompt || draft.script));
      }
    }).catch(() => {}).finally(() => setLoaded(true));
    // Runs once, when the window opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every change is saved shortly after it happens. An empty window keeps no draft.
  const draft: VideoDraft = { v: 1, footage: footage.snapshot(), refs: refs.snapshot(), prompt, script, styleId, clientId, locale, accountId, model };
  const draftJson = JSON.stringify(draft);
  useEffect(() => {
    if (!loaded) return;
    const empty = !draft.footage.length && !draft.refs.length && !prompt.trim() && !script?.trim();
    const t = window.setTimeout(() => void (empty ? api("DELETE", "/api/drafts/new-video") : api("PUT", "/api/drafts/new-video", { draft })).catch(() => {}), 500);
    return () => window.clearTimeout(t);
    // draftJson stands for every field in the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftJson, loaded]);

  const discard = () => {
    // Removing each row stops its download; what was fetched stays on the Mac for next time.
    for (const x of footage.items) footage.remove(x.id);
    for (const x of refs.items) refs.remove(x.id);
    setPrompt("");
    setScript(null);
    setStyleId(null);
    setRestored(false);
    void api("DELETE", "/api/drafts/new-video").catch(() => {});
  };

  const go = () => {
    if (!canStart) return;
    void api("DELETE", "/api/drafts/new-video").catch(() => {});
    const ask = prompt.trim();
    const firstLine = ask.split("\n")[0].trim();
    const title = (firstLine.length > 3 ? firstLine : video.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ")).slice(0, 60);
    const many = clips.length > 1 ? `There are ${clips.length} raw clips. Read them all, then build the best story from the strongest takes${script?.trim() ? ", following my script" : ""}.` : "";
    const refNote = reference.length > 1 ? `Use the ${reference.length} attached references. Take each part from the reference marked for it; study unmarked ones for everything.` : reference.length ? "Match the attached reference." : "";
    const text = [ask || "Edit this video.", many, refNote].filter(Boolean).join("\n\n");
    // References go first: they shape every decision, so they must never be the ones left out.
    void s.startVideo({ title, styleId, locale, script: script?.trim() || undefined }, text, [...reference, ...clips], { accountId, ...model, clientId: clientId || null });
    onClose();
  };

  return (
    <Modal
      title="New video"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <div className="ui-grow">
            <Select className="sm" label="Spoken language" value={locale} onChange={setLocale}>
              <option value="en-US">English</option>
              <option value="en-IN">English (India)</option>
              <option value="hi-IN">Hindi</option>
            </Select>
            {myClients.length > 0 && (
              <Select className="sm" label="Client" value={clientId} onChange={setClientId}>
                <option value="">No client</option>
                {myClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
            {signedIn.length > 1 && (
              <Select className="sm" label="Claude account" value={accountId} onChange={setAccountId}>
                {signedIn.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </Select>
            )}
            <ModelPicker model={model.model} effort={model.effort} accountId={accountId} onChange={(m, effort) => setModel({ model: m, effort })} />
          </div>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Sparkles size={15} />} disabled={!canStart} onClick={go}>Start edit</Button>
        </>
      }
    >
      <div className="ui-stack">
        {restored && (
          <div className="nm-restored ui-pop">
            <span>Picked up where you left off</span>
            <Button size="sm" variant="ghost" onClick={discard}>Discard</Button>
          </div>
        )}
        <div className="ui-field">
          {footage.items.length > 1 && <span className="ui-field-label">Raw videos<em>{clips.length} of {footage.items.length} ready</em></span>}
          {footage.items.length > 0 && <div className="ui-list nm-clips">{footage.items.map((a) => <FileItem key={a.id} a={a} onRemove={footage.remove} />)}</div>}
          <Dropzone compact={footage.items.length > 0} icon={<Clapperboard size={footage.items.length ? 18 : 30} strokeWidth={1.6} />} title={footage.items.length ? "Add more clips" : "Drop your raw videos here"} accept="video/*" multiple onFiles={(f) => void footage.add(f)} />
          <LinkInput label="Or paste a Google Drive file or folder, or a social video link" onLink={(u) => footage.addLink(u, true)} />
        </div>

        <div className="ui-field">
          <span className="ui-field-label">Style</span>
          <div className="ui-cards" role="radiogroup" aria-label="Style">
            <StyleOption on={styleId === null} name="None" note="The editor decides" onClick={() => setStyleId(null)} />
            {styles.map((c) => <StyleOption key={c.id} on={styleId === c.id} name={c.name} note={styleSource(c, owner)} colors={c.card.colors} thumbnail={c.thumbnail} onClick={() => setStyleId(c.id)} />)}
          </div>
        </div>

        <div className="ui-field">
          <span className="ui-field-label">Reference videos<em>Optional</em></span>
          {refs.items.length > 0 && (
            <div className="ui-list nm-ref">
              {refs.items.map((a) => (
                <FileItem key={a.id} a={a} onRemove={refs.remove}>
                  {!a.error && <TagChips value={a.tags ?? []} onChange={(t) => refs.setTags(a.id, t)} />}
                </FileItem>
              ))}
            </div>
          )}
          <Dropzone compact icon={<Film size={18} />} title={refs.items.length ? "Add another reference" : "Edit it like other videos"} action="Choose files" accept="video/*" multiple onFiles={(f) => void refs.add(f)} />
          <LinkInput label="Or paste a Drive file or folder, TikTok, Instagram or other video link" onLink={(u) => refs.addLink(u, true)} />
        </div>

        {script === null ? (
          <div className="ui-toolbar">
            <Button size="sm" variant="ghost" icon={<FileText size={14} />} onClick={() => setScript("")}>Add a script</Button>
          </div>
        ) : (
          <div className="ui-field">
            <span className="ui-field-label">Script<em>Optional</em></span>
            <textarea className="ui-textarea" rows={5} value={script} placeholder="Paste your script. The editor builds the video in this order." aria-label="Script" onChange={(e) => setScript(e.target.value)} />
            <div className="ui-toolbar">
              <FileButton size="sm" variant="secondary" loading={reading} accept=".txt,.md,.docx,.doc,.rtf,.odt" onFiles={(f) => readScript(f[0])}>Upload</FileButton>
              <Button size="sm" variant="ghost" onClick={() => setScript(null)}>Remove</Button>
            </div>
          </div>
        )}

        <div className="nm-prompt">
          <textarea
            className="ui-textarea"
            value={prompt}
            rows={3}
            placeholder="Tell the editor what you want. For example: open on the strongest claim, keep it under 60 seconds, calm and premium."
            aria-label="Your prompt"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } }}
          />
          <div className="nm-prompt-foot">
            <span>{canStart ? "⌘ Enter to start" : video ? "Waiting for uploads…" : "Add your video first"}</span>
            <IconButton label="Start edit" disabled={!canStart} onClick={go}><Send size={15} /></IconButton>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Where a style came from, in a few words. */
const styleSource = (c: EngineStyle, owner: (id?: string | null) => string) => (c.access === "repo" ? `Shared${c.author ? ` by ${c.author}` : ""}` : c.access === "use" || c.access === "edit" ? `From ${owner(c.ownerId)}` : "Your style");

function StyleOption({ on, name, note, colors, thumbnail, onClick }: { on: boolean; name: string; note: string; colors?: string[]; thumbnail?: string | null; onClick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`ui-card ${on ? "is-on" : ""}`} onClick={onClick}>
      {thumbnail ? <img className="st-thumb sm" src={thumbnail} alt="" loading="lazy" /> : <span className="ui-swatch sm">{colors?.slice(0, 3).map((v) => <i key={v} style={{ background: v }} />)}</span>}
      <b>{name}</b>
      <small>{note}</small>
    </button>
  );
}

// ── Review ─────────────────────────────────────────────────────

type Call = { id: number; atSeconds: number | null; text: string };

export function Review({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useStore();
  const e = s.editors.find((v) => v.id === id);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [note, setNote] = useState("");
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    void store.attempt(async () => {
      setOutputs(await api<string[]>("GET", `/api/chats/${id}/outputs`));
      setCalls(await api<Call[]>("GET", `/api/chats/${id}/review`));
    });
  }, [id]);

  if (!e) return null;
  const rank = (n: string) => Number(n.match(/^V(\d+)/)?.[1] ?? 0) + (n.includes("preview") ? 0 : 0.5);
  const videos = outputs.filter((n) => n.endsWith(".mp4")).sort((a, b) => rank(b) - rank(a));
  const current = picked ?? videos[0];
  const url = (n: string) => `/api/chats/${id}/out/${encodeURIComponent(n)}`;
  const stem = current?.replace(/\.mp4$/, "");
  const seek = (t: number) => {
    const v = document.querySelector<HTMLVideoElement>(".rv video");
    if (v) v.currentTime = t;
  };
  const submit = () => {
    if (!note.trim()) return;
    s.send(e.id, `At ${formatTime(at)}: ${note}`);
    onClose();
  };
  return (
    <Modal title={e.mission?.title ?? "Review"} description={`Edited by ${e.name}`} onClose={onClose} size="lg">
      <div className="rv">
        <div>
          {current ? <video src={url(current)} controls onTimeUpdate={(v) => setAt(v.currentTarget.currentTime)} /> : <div className="rv-empty">Nothing rendered yet</div>}
          <form className="rv-comment" onSubmit={(ev) => (ev.preventDefault(), submit())}>
            <input className="ui-input" value={note} placeholder={`Comment at ${formatTime(at)}`} aria-label="Comment" onChange={(v) => setNote(v.target.value)} />
            <Button type="submit" variant="primary" icon={<Send size={14} />} disabled={!note.trim()}>Send</Button>
          </form>
        </div>
        <aside className="rv-side">
          {videos.length > 0 && (
            <div className="ui-field">
              <span className="ui-field-label">Version</span>
              <Select label="Version" value={current ?? ""} onChange={setPicked}>
                {videos.map((n) => <option key={n} value={n}>{n.replace(".mp4", "").replace("-preview", " · preview")}</option>)}
              </Select>
            </div>
          )}
          {current && (
            <div className="ui-field">
              <span className="ui-field-label">Download</span>
              <div className="ui-chips">
                <a className="ui-btn v-secondary sm" href={url(current)} download><Download size={13} /><span>MP4</span></a>
                {outputs.includes(`${stem}.srt`) && <a className="ui-btn v-secondary sm" href={url(`${stem}.srt`)} download><Download size={13} /><span>SRT</span></a>}
                {outputs.includes(`${stem}.fcpxml`) && <a className="ui-btn v-secondary sm" href={url(`${stem}.fcpxml`)} download><Download size={13} /><span>Resolve</span></a>}
              </div>
            </div>
          )}
          <div className="ui-field">
            <span className="ui-field-label">Editor's calls</span>
            {calls.length ? (
              <div className="rv-calls">
                {calls.map((c) => (
                  <button key={c.id} type="button" className="rv-call" disabled={c.atSeconds === null} onClick={() => c.atSeconds !== null && seek(c.atSeconds)}>
                    <time>{c.atSeconds !== null ? formatTime(c.atSeconds) : "—"}</time>
                    <span>{c.text}</span>
                  </button>
                ))}
              </div>
            ) : <span className="ui-field-hint">None yet</span>}
          </div>
        </aside>
      </div>
    </Modal>
  );
}

// ── Claude accounts ────────────────────────────────────────────

export function Accounts({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [kind, setKind] = useState<"login" | "key">("login");
  const [busy, setBusy] = useState(false);
  const add = () =>
    void s.attempt(async () => {
      setBusy(true);
      try {
        const a = await api<{ id: string }>("POST", "/api/accounts", { label: label.trim() || "Claude account", apiKey: kind === "key" ? apiKey : undefined });
        setLabel("");
        setApiKey("");
        if (kind === "login") await api("POST", `/api/accounts/${a.id}/login`, {});
      } finally {
        setBusy(false);
      }
    });
  return (
    <Modal title="Claude accounts" description="Pick one for each chat." onClose={onClose}>
      <div className="ui-stack">
        <div className="ui-list">
          {s.accounts.map((a) => {
            const signing = s.login?.id === a.id && s.login.status === "link";
            return (
              <Item
                key={a.id}
                icon={a.kind === "api_key" ? <KeyRound size={18} /> : <Sparkles size={18} />}
                title={<>{a.label} {a.plan && <Badge>{a.plan}</Badge>}</>}
                meta={<Meta parts={[a.email ?? (a.kind === "api_key" ? "API key" : null), a.signedIn ? <span className="t-ok">Signed in</span> : <span className="t-muted">Signed out</span>]} />}
                actions={
                  <>
                    {a.kind === "subscription" && !a.signedIn && !signing && <Button size="sm" variant="secondary" onClick={() => void s.attempt(() => api("POST", `/api/accounts/${a.id}/login`, {}))}>Sign in</Button>}
                    <IconButton label="Refresh usage" onClick={() => void s.attempt(() => api("POST", `/api/accounts/${a.id}/refresh`))}><RefreshCw size={15} /></IconButton>
                    {a.kind === "subscription" && a.signedIn && a.id !== "default" && <IconButton label="Sign out" onClick={() => void s.attempt(() => api("POST", `/api/accounts/${a.id}/logout`))}><LogOut size={15} /></IconButton>}
                    {a.id !== "default" && <Confirm icon={<Trash2 size={15} />} label={`Remove ${a.label}`} confirm="Remove" onConfirm={() => void s.attempt(() => api("DELETE", `/api/accounts/${a.id}`))} />}
                  </>
                }
              >
                {a.limits.length > 0 && (
                  <div className="acc-limits">
                    {a.limits.map((l) => {
                      const left = Math.round(100 - l.usedPercent);
                      return (
                        <div key={l.id}>
                          <span>{l.label}</span>
                          <Progress value={left / 100} tone={left < 15 ? "bad" : left < 35 ? "warn" : undefined} />
                          <small>{left}% · {resetLabel(l.resetsAt)}</small>
                        </div>
                      );
                    })}
                  </div>
                )}
                {signing && (
                  <div className="acc-login">
                    <a className="ui-btn v-primary sm" href={s.login!.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /><span>Open Claude sign-in</span></a>
                    <LoginCode id={a.id} />
                  </div>
                )}
                {s.login?.id === a.id && s.login.status === "failed" && <span className="t-bad acc-note">Sign-in didn't finish. Try again.</span>}
              </Item>
            );
          })}
        </div>

        <div className="ui-field">
          <span className="ui-field-label">Add an account</span>
          <div className="acc-add">
            <Segmented label="Account type" value={kind} onChange={setKind} options={[{ id: "login", label: "Claude login" }, { id: "key", label: "API key" }]} />
            <input className="ui-input" value={label} placeholder="Name, e.g. Studio 2" aria-label="Account name" onChange={(e) => setLabel(e.target.value)} />
            {kind === "key" && <input className="ui-input" type="password" value={apiKey} placeholder="sk-ant-…" aria-label="API key" onChange={(e) => setApiKey(e.target.value)} />}
            <Button variant="primary" icon={<Plus size={15} />} loading={busy} disabled={kind === "key" && !apiKey.trim()} onClick={add}>{kind === "key" ? "Add" : "Add and sign in"}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** On another computer, Claude shows a code after sign-in. It goes back to Claude Code on the Hub through here. */
function LoginCode({ id }: { id: string }) {
  const s = useStore();
  const [code, setCode] = useState("");
  return (
    <form className="ui-inline" onSubmit={(e) => { e.preventDefault(); void s.attempt(async () => { await api("POST", `/api/accounts/${id}/login/code`, { code }); setCode(""); }); }}>
      <input className="ui-input" value={code} placeholder="Code from Claude, if shown" aria-label="Claude sign-in code" onChange={(e) => setCode(e.target.value)} />
      <Button type="submit" size="sm" variant="secondary" disabled={code.trim().length < 8}>Send</Button>
    </form>
  );
}

// ── Styles ─────────────────────────────────────────────────────

function Rules({ rules }: { rules?: StyleRule[] }) {
  if (!rules?.length) return null;
  return (
    <div className="ui-group-card">
      {rules.map((r) => (
        <div key={r.rule} className="sd-rule">
          <span>{r.rule}</span>
          {r.evidence && <small>{r.evidence.map((e) => `${e.ref ? `Video ${e.ref} ` : ""}${formatTime(e.at)}`).join(", ")}{r.confidence ? ` · ${r.confidence}` : ""}</small>}
        </div>
      ))}
    </div>
  );
}

function Swatch({ colors, className = "" }: { colors?: string[]; className?: string }) {
  return <span className={`ui-swatch ${className}`}>{colors?.slice(0, 3).map((v) => <i key={v} style={{ background: v }} />)}</span>;
}

function StylesBoard({ onClose, onMotion }: { onClose: () => void; onMotion: () => void }) {
  const s = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [panel, setPanel] = useState<"learn" | "mix" | null>(null);
  const owner = (id?: string | null) => s.members.find((m) => m.id === id)?.name ?? "a colleague";
  const running = job ? s.jobs.get(job) : null;
  const shown = s.styles.find((v) => v.id === open);
  const mixable = s.styles.filter((v) => v.status === "approved");
  const learn = (variant: "primary" | "secondary") => <Button variant={variant} size="sm" icon={<Plus size={15} />} onClick={() => setPanel("learn")}>New style</Button>;

  if (shown) {
    const areas = STYLE_AREAS.filter(([id]) => shown.card[id]?.summary);
    const source = styleSource(shown, owner);
    const saved = s.motion.filter((v) => v.styleId === shown.id);
    const animations = saved.filter((v) => v.kind === "animation");
    const caption = saved.find((v) => v.kind === "caption");
    return (
      <Modal
        title="Styles"
        onClose={onClose}
        size="lg"
        footer={
          <>
            <div className="ui-grow"><Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => setOpen(null)}>All styles</Button></div>
            {shown.access === "own" && <Confirm size="md" icon={<Trash2 size={15} />} confirm="Delete style" onConfirm={() => { void s.attempt(() => api("DELETE", `/api/styles/${shown.id}`)); setOpen(null); }}>Delete</Confirm>}
            {shown.status === "draft" && (shown.access === "own" || shown.access === "edit") && <Button variant="primary" onClick={() => void s.attempt(() => api("PATCH", `/api/styles/${shown.id}`, { status: "approved" }))}>Approve</Button>}
          </>
        }
      >
        <div className="sd-head">
          {shown.thumbnail ? <img className="st-thumb" src={shown.thumbnail} alt={`${shown.name} thumbnail`} /> : <Swatch colors={shown.card.colors} />}
          <div>
            <h3>{shown.name} {shown.status === "draft" && <Badge tone="warn">Draft</Badge>}</h3>
            <p><Meta parts={[source, shown.access === "own" && shown.shared ? "Shared" : null]} /></p>
          </div>
        </div>
        {shown.card.summary && <p className="sd-summary">{shown.card.summary}</p>}
        <div className="ui-stack">
          {(animations.length > 0 || caption) && (
            <section className="ui-group">
              <div className="ui-group-head"><h3>Saved from the reference</h3><Button size="sm" variant="ghost" onClick={onMotion}>Motion library</Button></div>
              <div className="mo-grid sm">
                {caption && <div className="mo-card static"><MotionPreview item={caption} /><span className="mo-card-body"><b>Captions</b><small>{String((caption.card.captions as { fontFeel?: string } | undefined)?.fontFeel ?? "Caption preset")}</small></span></div>}
                {animations.map((v) => <div key={v.id} className="mo-card static"><MotionPreview item={v} /><span className="mo-card-body"><b>{v.name}</b><small>{[v.operation?.label, v.technique?.label].filter(Boolean).join(" → ")}</small></span></div>)}
              </div>
            </section>
          )}
          {areas.length ? areas.map(([id, label]) => (
            <section key={id} className="ui-group">
              <div className="ui-group-head"><h3>{label}</h3>{shown.card[id]!.from && <small className="t-muted">From {shown.card[id]!.from}</small>}</div>
              {shown.card[id]!.summary && <p className="sd-summary" style={{ margin: "0 4px 10px", fontSize: 13 }}>{shown.card[id]!.summary}</p>}
              <Rules rules={shown.card[id]!.rules} />
            </section>
          )) : <Rules rules={shown.card.rules} />}
          {!!shown.card.anyPerson?.length && <Disclosure title="On other people's footage" items={shown.card.anyPerson} />}
          {!!shown.card.unsure?.length && <Disclosure title="Not confirmed" items={shown.card.unsure} />}
          {!!shown.card.rejected?.length && <Disclosure title="Dropped by evidence check" items={shown.card.rejected.map((u) => `${u.rule}: ${u.reason}`)} />}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Styles" description="Learned from reference videos." onClose={onClose} size="lg">
      <div className="ui-stack">
        {running && <div className="ui-list"><JobItem job={running} /></div>}
        {s.styles.length ? (
          <>
            <div className="ui-toolbar">
              <span>{s.styles.length} {s.styles.length === 1 ? "style" : "styles"}</span>
              <div className="ui-inline">
                {mixable.length >= 2 && <Button variant="ghost" size="sm" onClick={() => setPanel("mix")}>Mix styles</Button>}
                {learn("primary")}
              </div>
            </div>
            {panel === "learn" && <NewStylePanel onStarted={(id) => { setJob(id); setPanel(null); }} onCancel={() => setPanel(null)} />}
            {panel === "mix" && <MixStylesPanel styles={mixable} onDone={(id) => { setPanel(null); setOpen(id); }} onCancel={() => setPanel(null)} />}
            <div className="ui-cards wide">
              {s.styles.map((c) => (
                <button key={c.id} type="button" className="ui-card" onClick={() => setOpen(c.id)}>
                  {c.thumbnail ? <img className="st-thumb" src={c.thumbnail} alt="" loading="lazy" /> : <Swatch colors={c.card.colors} />}
                  <b>{c.name}</b>
                  <small>{c.status === "draft" ? <span className="t-warn">Draft</span> : styleSource(c, owner)}</small>
                  {c.card.summary && <p>{c.card.summary}</p>}
                </button>
              ))}
            </div>
          </>
        ) : (
          !running && (panel === "learn"
            ? <NewStylePanel onStarted={(id) => { setJob(id); setPanel(null); }} onCancel={() => setPanel(null)} />
            : <EmptyState art="grid" title="No styles yet" text="Add reference videos and Claude learns their style." action={learn("primary")} />)
        )}
      </div>
    </Modal>
  );
}

/**
 * Learn a style from one or more reference videos. Several become one blended style; marks say
 * what to take from each. What's added is kept as a draft until the style starts learning.
 */
function NewStylePanel({ onStarted, onCancel }: { onStarted: (job: string) => void; onCancel: () => void }) {
  const s = useStore();
  const refs = useAttachments("reference");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ draft: { v: 1; refs: Pending[] } | null }>("GET", "/api/drafts/new-style").then(({ draft }) => draft?.v === 1 && refs.restore(draft.refs ?? [])).catch(() => {}).finally(() => setLoaded(true));
    // Runs once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const snapshot = JSON.stringify(refs.snapshot());
  useEffect(() => {
    if (!loaded) return;
    const list = JSON.parse(snapshot) as Pending[];
    const t = window.setTimeout(() => void (list.length ? api("PUT", "/api/drafts/new-style", { draft: { v: 1, refs: list } }) : api("DELETE", "/api/drafts/new-style")).catch(() => {}), 500);
    return () => window.clearTimeout(t);
  }, [snapshot, loaded]);
  const ready = refs.ready();
  const start = () => void s.attempt(async () => {
    setBusy(true);
    try {
      const r = await api<{ job: string }>("POST", "/api/styles/learn", { hashes: ready.map((x) => x.hash), tags: ready.map((x) => x.tags ?? []), accountId: s.settings.account });
      await api("DELETE", "/api/drafts/new-style").catch(() => {});
      onStarted(r.job);
    } finally {
      setBusy(false);
    }
  });
  return (
    <section className="ui-group st-panel ui-pop">
      <div className="ui-group-head"><h3>New style</h3>{ready.length > 1 && <small className="t-muted">{ready.length} videos → one style</small>}</div>
      {refs.items.length > 0 && (
        <div className="ui-list nm-ref">
          {refs.items.map((a) => (
            <FileItem key={a.id} a={a} onRemove={refs.remove}>
              {!a.error && refs.items.length > 1 && <TagChips value={a.tags ?? []} onChange={(t) => refs.setTags(a.id, t)} />}
            </FileItem>
          ))}
        </div>
      )}
      <Dropzone compact icon={<Film size={18} />} title={refs.items.length ? "Add another reference" : "Drop reference videos"} action="Choose files" accept="video/*" multiple onFiles={(f) => void refs.add(f)} />
      <LinkInput label="Or paste a Drive, reel, TikTok or other video link" onLink={(u) => refs.addLink(u, true)} />
      <div className="ui-toolbar end">
        <Button variant="ghost" size="sm" onClick={onCancel}>Close</Button>
        <Button variant="primary" size="sm" icon={<Sparkles size={14} />} loading={busy} disabled={!ready.length || refs.busy || ready.length > 5} title={`Claude Opus studies ${ready.length > 1 ? "them" : "it"} on ${s.activeAccount()?.label ?? "your"} account`} onClick={start}>Learn style</Button>
      </div>
    </section>
  );
}

/** A new style from areas of saved ones, such as captions from one and motion from another. */
function MixStylesPanel({ styles, onDone, onCancel }: { styles: EngineStyle[]; onDone: (id: string) => void; onCancel: () => void }) {
  const s = useStore();
  const [name, setName] = useState("");
  const [parts, setParts] = useState<Record<string, string>>(() => Object.fromEntries(STYLE_AREAS.map(([id]) => [id, id === "captions" || id === "animation" ? styles[1].id : styles[0].id])));
  const used = new Set(Object.values(parts));
  const create = () => void s.attempt(async () => {
    const v = await api<{ id: string }>("POST", "/api/styles/mix", { name, parts });
    onDone(v.id);
  });
  return (
    <section className="ui-group st-panel ui-pop">
      <div className="ui-group-head"><h3>Mix styles</h3></div>
      <input className="ui-input" value={name} placeholder="Name the new style" aria-label="New style name" onChange={(e) => setName(e.target.value)} />
      <div className="ui-group-card st-mix">
        {STYLE_AREAS.map(([id, label]) => (
          <div key={id} className="ui-row">
            <span className="ui-row-title ui-grow">{label}</span>
            <Select className="sm" label={`${label} from`} value={parts[id]} onChange={(v) => setParts({ ...parts, [id]: v })}>
              {styles.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </div>
        ))}
      </div>
      <div className="ui-toolbar end">
        <Button variant="ghost" size="sm" onClick={onCancel}>Close</Button>
        <Button variant="primary" size="sm" disabled={!name.trim() || used.size < 2} onClick={create}>Create style</Button>
      </div>
    </section>
  );
}

function Disclosure({ title, items }: { title: string; items: string[] }) {
  return (
    <details className="ui-details">
      <summary>{title} <Badge>{items.length}</Badge><ChevronDown size={15} /></summary>
      <div>{items.map((u) => <span key={u} className="ui-row-meta">{u}</span>)}</div>
    </details>
  );
}

// ── Prompt recipes ─────────────────────────────────────────────

function PromptsBoard({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const use = (id: string, value: string) => {
    void s.attempt(() => api("POST", `/api/recipes/${id}/use`));
    s.pendingDraft = value;
    if (!s.selectedId && s.editors[0]) s.select(s.editors[0].id);
    onClose();
  };
  const save = () => void s.attempt(async () => { await api("POST", "/api/recipes", { title, text }); setTitle(""); setText(""); });
  return (
    <Modal title="Prompt recipes" description="Reusable instructions. Click one to use it." onClose={onClose}>
      <div className="ui-stack">
        {s.recipes.length ? (
          <div className="ui-list">
            {s.recipes.map((p) => (
              <Item
                key={p.id}
                icon={<FileText size={18} />}
                title={<>{p.title} {p.uses > 0 && <Badge>{p.uses}×</Badge>}</>}
                meta={<span className="clamp-1">{p.text}</span>}
                onClick={() => use(p.id, p.text)}
                actions={<Confirm icon={<Trash2 size={15} />} label={`Delete ${p.title}`} confirm="Delete" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/recipes/${p.id}`); await s.refresh(); })} />}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="No recipes yet" text="Save instructions you give often." />
        )}
        <form className="ui-field" onSubmit={(e) => (e.preventDefault(), title.trim() && text.trim() && save())}>
          <span className="ui-field-label">New recipe</span>
          <input className="ui-input" value={title} placeholder="Name" aria-label="Recipe name" onChange={(e) => setTitle(e.target.value)} />
          <textarea className="ui-textarea" value={text} rows={3} placeholder="What should the editor do?" aria-label="Recipe text" onChange={(e) => setText(e.target.value)} />
          <div className="ui-toolbar end"><Button type="submit" variant="primary" disabled={!title.trim() || !text.trim()}>Save recipe</Button></div>
        </form>
      </div>
    </Modal>
  );
}

// ── Tools ──────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, React.ReactNode> = {
  removeBackground: <Wand2 size={18} />, transcribe: <Type size={18} />, cutSilences: <Scissors size={18} />,
  reframe: <Smartphone size={18} />, parallax: <Move3d size={18} />, track: <Bolt size={18} />,
};

function ToolItem({ t }: { t: (typeof TOOLS)[number] }) {
  const s = useStore();
  const [job, setJob] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const running = job ? s.jobs.get(job) : null;
  const pack = "pack" in t ? s.packs.find((p) => p.id === t.pack) : null;
  const result = (running?.status === "done" ? running.result : null) as { file?: StoredFile; words?: unknown[] } | null;
  const active = running && !JOB_DONE.has(running.status);
  const run = (f: File) =>
    void s.attempt(async () => {
      setAdding(true);
      try {
        const stored = await uploadFile(f, () => {});
        const r = await api<{ job: string }>("POST", `/api/tools/${t.id}`, { hash: stored.hash, ...t.params });
        setJob(r.job);
      } finally {
        setAdding(false);
      }
    });
  return (
    <Item
      icon={TOOL_ICONS[t.id] ?? <Sparkles size={18} />}
      title={t.name}
      meta={active ? <span className="t-accent">{running.message ?? "Working…"}</span> : result?.words ? <span className="t-ok">{result.words.length} words</span> : running?.error ? <span className="t-bad">{running.error}</span> : t.note}
      actions={
        result?.file ? (
          <a className="ui-btn v-secondary sm" href={`/api/files/${result.file.hash}`} download={result.file.name}><Download size={13} /><span>Save</span></a>
        ) : pack && !pack.installed ? (
          <PackButton id={pack.id} name={pack.name} />
        ) : (
          <FileButton size="sm" variant="secondary" loading={adding || !!active} accept="video/*,image/*" onFiles={(f) => run(f[0])}>Run</FileButton>
        )
      }
    >
      {active && <Progress value={running.progress ?? 0} />}
    </Item>
  );
}

export function PackButton({ id, name }: { id: string; name: string }) {
  const s = useStore();
  const [job, setJob] = useState<string | null>(null);
  const running = job ? s.jobs.get(job) : null;
  useEffect(() => {
    if (running?.status === "done") void s.refresh();
  }, [running?.status, s]);
  const active = !!running && !JOB_DONE.has(running.status);
  return (
    <Button size="sm" variant="secondary" icon={<Download size={13} />} loading={active} title={`Install ${name}`} onClick={() => void s.attempt(async () => setJob((await api<{ job: string }>("POST", `/api/packs/${id}/install`)).job))}>
      {active ? `${Math.round((running!.progress ?? 0) * 100)}%` : "Install"}
    </Button>
  );
}

function ToolsBoard({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Tools" description="Runs on this Mac. No Claude usage." onClose={onClose}>
      <div className="ui-list">{TOOLS.map((t) => <ToolItem key={t.id} t={t} />)}</div>
    </Modal>
  );
}

// ── B-roll library ─────────────────────────────────────────────

function LibraryBoard({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const lib = s.library;
  const [links, setLinks] = useState("");
  const [count, setCount] = useState(10);
  const [path, setPath] = useState("");
  const [data, setData] = useState<{ tree: { path: string; count: number }[]; gaps: string[] }>({ tree: [], gaps: [] });
  const [shots, setShots] = useState<{ id: string; summary: string; implies: string[]; category: string | null }[]>([]);
  const [uploading, setUploading] = useState(0);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const writable = s.libraries.filter((l) => l.access === "own" || l.access === "add");
  const [target, setTarget] = useState<string | null>(null);
  const into = target && writable.some((l) => l.id === target) ? target : writable[0]?.id ?? null;
  const ownerName = (id: string) => s.members.find((m) => m.id === id)?.name ?? "a colleague";
  const active = [...s.jobs.values()].filter((j) => j.kind.startsWith("library.") && !JOB_DONE.has(j.status));

  useEffect(() => {
    void store.attempt(async () => {
      setData(await api("GET", `/api/library?prefix=${encodeURIComponent(path)}`));
      if (path) setShots(await api("GET", `/api/library/browse?path=${encodeURIComponent(path)}`));
      else setShots([]);
    });
  }, [path, lib?.analyzed]);

  const importFiles = (files: File[]) =>
    void s.attempt(async () => {
      setUploading(files.length);
      try {
        for (const f of files) {
          const stored = await uploadFile(f, () => {});
          await api("POST", "/api/library/import", { hashes: [stored.hash], libraryId: into });
          setUploading((n) => n - 1);
        }
      } finally {
        setUploading(0);
      }
    });
  const makeLibrary = () => void s.attempt(async () => {
    const l = await api<{ id: string }>("POST", "/api/libraries", { name: newName });
    setNewName("");
    setNaming(false);
    await s.refresh();
    setTarget(l.id);
  });
  const pending = lib?.pending ?? 0;
  const counts = [...new Set([10, 25, 50, pending].filter((n) => n > 0 && n <= pending))];
  const pick = counts.includes(count) ? count : counts[0];
  const estimate = lib?.percentPerShot ? `≈ ${Math.max(1, Math.round(lib.percentPerShot * pick))}% of your session` : null;

  return (
    <Modal title="B-roll library" onClose={onClose} size="lg">
      <div className="ui-stack">
        <div className="ui-toolbar">
          {naming ? (
            <form className="ui-inline grow" onSubmit={(e) => (e.preventDefault(), newName.trim() && makeLibrary())}>
              <input className="ui-input" autoFocus value={newName} placeholder="Library name" aria-label="New library name" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setNaming(false))} />
              <Button type="submit" variant="primary" size="sm" disabled={!newName.trim()}>Create</Button>
              <Button variant="ghost" size="sm" onClick={() => setNaming(false)}>Cancel</Button>
            </form>
          ) : (
            <>
              <Select className="sm" label="Library" value={into ?? ""} onChange={setTarget}>
                {writable.map((l) => <option key={l.id} value={l.id}>{l.name}{l.ownerId !== s.me?.id ? ` · ${ownerName(l.ownerId)}` : ""}</option>)}
              </Select>
              <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={() => setNaming(true)}>New library</Button>
            </>
          )}
        </div>

        <div className="ui-stats">
          <div className="ui-stat"><b>{lib?.clips ?? 0}</b><span>Clips</span></div>
          <div className="ui-stat"><b>{lib?.shots ?? 0}</b><span>Shots</span></div>
          <div className="ui-stat"><b>{lib?.analyzed ?? 0}</b><span>Analyzed</span></div>
        </div>

        {pending > 0 && (
          <div className="ui-callout lb-analyze">
            <Sparkles size={17} />
            <span><b>{pending} shots</b> ready to analyze{estimate && <span className="t-muted"> · {estimate}</span>}</span>
            {counts.length > 1 && <Segmented label="How many" value={String(pick)} onChange={(v) => setCount(Number(v))} options={counts.map((n) => ({ id: String(n), label: n === pending ? "All" : String(n) }))} />}
            <Button variant="primary" size="sm" onClick={() => void s.attempt(() => api("POST", "/api/library/analyze", { count: Math.min(pick, pending), accountId: s.settings.account }))}>Analyze</Button>
          </div>
        )}
        {active.length > 0 && <div className="ui-list">{active.map((j) => <JobItem key={j.id} job={j} />)}</div>}

        <div>
          <Dropzone icon={<UploadCloud size={30} strokeWidth={1.6} />} title={uploading ? `Adding ${uploading} ${uploading === 1 ? "video" : "videos"}…` : "Drop videos here"} accept="video/*" multiple disabled={!into || uploading > 0} onFiles={importFiles} />
          <div className="ui-hints">
            <span>{s.keys.openrouter ? "Meaning search on" : <><Search size={12} /> Keyword search only. Add OpenRouter in Settings for meaning search.</>}</span>
          </div>
        </div>

        <details className="ui-details">
          <summary><ExternalLink size={15} /> Import from Google Drive<ChevronDown size={15} /></summary>
          <div>
            <textarea className="ui-textarea" value={links} rows={3} placeholder="One link per line. Set to Anyone with the link." aria-label="Google Drive links" onChange={(e) => setLinks(e.target.value)} />
            <div className="ui-toolbar end">
              <Button variant="primary" size="sm" disabled={!links.trim() || !into} onClick={() => void s.attempt(async () => { await api("POST", "/api/library/drive", { links: links.split(/\s+/).filter(Boolean), libraryId: into }); setLinks(""); })}>Import</Button>
            </div>
          </div>
        </details>

        {(data.tree.length > 0 || path) && (
          <div className="ui-field">
            <span className="ui-field-label">{path ? path.split(" / ").pop() : "Browse"}</span>
            <div className="ui-chips">
              {path && <button type="button" className="ui-chip" onClick={() => setPath(path.split(" / ").slice(0, -1).join(" / "))}><ArrowLeft size={13} /> Back</button>}
              {data.tree.map((t) => <button key={t.path} type="button" className="ui-chip" onClick={() => setPath(t.path)}>{t.path.split(" / ").pop()}<small>{t.count}</small></button>)}
            </div>
          </div>
        )}
        {shots.length > 0 && (
          <div className="lb-grid">
            {shots.map((c, i) => (
              <article key={c.id} className="lb-clip" style={{ animationDelay: `${Math.min(i, 12) * 24}ms` }}>
                <img src={`/api/library/shots/${c.id}/filmstrip`} alt="" loading="lazy" />
                <span title={c.summary}>{c.implies.slice(0, 3).join(", ") || c.summary}</span>
              </article>
            ))}
          </div>
        )}
        {data.gaps.length > 0 && (
          <section className="ui-group">
            <div className="ui-group-head"><h3>Missing footage</h3></div>
            <div className="ui-group-card">{data.gaps.slice(0, 5).map((g) => <div key={g} className="sd-rule">{g}</div>)}</div>
          </section>
        )}
      </div>
    </Modal>
  );
}

export function Board({ id, onClose, onBoard }: { id: BoardId; onClose: () => void; onBoard: (b: BoardId) => void }) {
  if (id === "styles") return <StylesBoard onClose={onClose} onMotion={() => onBoard("motion")} />;
  if (id === "motion") return <MotionBoard onClose={onClose} />;
  if (id === "prompts") return <PromptsBoard onClose={onClose} />;
  if (id === "library") return <LibraryBoard onClose={onClose} />;
  if (id === "tools") return <ToolsBoard onClose={onClose} />;
  return (
    <Modal bare size="xl" label="Settings" onClose={onClose}>
      <SettingsBoard />
    </Modal>
  );
}

export function Toast() {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    let lastId = 0;
    let hide = 0;
    return store.subscribe(() => {
      const t = store.toast;
      if (t && t.id !== lastId) {
        lastId = t.id;
        setShown(t.text);
        window.clearTimeout(hide);
        hide = window.setTimeout(() => setShown(null), 4000);
      }
    });
  }, []);
  if (!shown) return null;
  return (
    <div className="toast glass" role="status">
      {shown}
    </div>
  );
}
