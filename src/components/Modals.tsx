import { ReactNode, useEffect, useState } from "react";
import { LogOut, Plus, RefreshCw, Trash2 } from "lucide-react";
import { TOOLS } from "../sim/data";
import { Job, StoredFile, api, resetLabel, uploadFile } from "../sim/engine";
import { store, useStore } from "../sim/store";
import { AttachmentStrip, formatTime, useAttachments } from "./Attach";
import { BoardId } from "./Hud";
import { Icon } from "./Icon";
import { ModelPicker } from "./ModelPicker";

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <section className={`modal sheet ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <b>{title}</b>
          <button className="ghost" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="parchment">{children}</div>
      </section>
    </div>
  );
}

const JOB_DONE = new Set(["done", "failed", "cancelled"]);

function JobLine({ job }: { job: Job }) {
  if (JOB_DONE.has(job.status)) return job.error ? <p className="job bad">{job.error}</p> : null;
  return (
    <div className="job">
      <span>{job.message ?? "Queued"}</span>
      <div className="mission-bar">
        <i style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
      </div>
      <button onClick={() => void store.attempt(() => api("DELETE", `/api/jobs/${job.id}`))}>Cancel</button>
    </div>
  );
}

function Pick({ label, accept, multiple, onFiles }: { label: string; accept?: string; multiple?: boolean; onFiles: (f: File[]) => void }) {
  return (
    <label className="pick-btn">
      {label}
      <input
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          if (e.target.files) onFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
    </label>
  );
}

export function NewMission({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const styles = s.styles.filter((v) => v.status === "approved");
  const footage = useAttachments("footage");
  const refs = useAttachments("reference");
  const [modeId, setModeId] = useState(s.modes[0]?.id ?? "");
  const [styleId, setStyleId] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const [locale, setLocale] = useState("en-US");
  const [drag, setDrag] = useState(false);
  const [accountId, setAccountId] = useState(s.settings.account);
  const [model, setModel] = useState(s.lastModel);
  const [goal, setGoal] = useState("");
  const video = footage.ready()[0];

  const go = () => {
    const title = goal.trim().slice(0, 60) || video.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    const text = [goal.trim() || "Edit this video.", refs.items.length ? "Match the attached reference." : ""].filter(Boolean).join(" ");
    void s.startVideo({ title, modeId, styleId, reason: why.trim() || undefined, locale }, text, [...footage.ready(), ...refs.ready()], { accountId, ...model });
    onClose();
  };

  return (
    <Modal title="New video" onClose={onClose} wide>
      <div className="mission-flow">
        <div
          className={`drop ${drag ? "over" : ""} ${video ? "has" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            footage.clear();
            void footage.add([...e.dataTransfer.files].slice(0, 1));
          }}
        >
          {footage.items.length ? (
            <AttachmentStrip items={footage.items} onRemove={footage.remove} onRole={footage.setRole} />
          ) : (
            <>
              <Icon name="film" size={30} color="#7a4a2c" />
              <b>Drop your raw video here</b>
              <Pick label="or choose a file" accept="video/*" onFiles={(f) => void footage.add(f.slice(0, 1))} />
            </>
          )}
        </div>

        <h3>What kind of video is this?</h3>
        <div className="chips">
          {s.modes.map((m) => (
            <button key={m.id} className={modeId === m.id ? "on" : ""} title={m.rules} onClick={() => setModeId(m.id)}>
              {m.label}
            </button>
          ))}
        </div>

        <h3>Pick a style</h3>
        <div className="style-grid">
          <button className={styleId === null ? "on" : ""} onClick={() => setStyleId(null)}>
            <b>Mode only</b>
            <small>No saved style</small>
          </button>
          {styles.map((c) => (
            <button key={c.id} className={styleId === c.id ? "on" : ""} onClick={() => setStyleId(c.id)}>
              <span className="swatches">
                {(c.card.colors ?? []).slice(0, 3).map((v) => (
                  <i key={v} style={{ background: v }} />
                ))}
              </span>
              <b>{c.name}</b>
              <small>{s.modes.find((m) => m.id === c.mode)?.label ?? "Any video"}</small>
            </button>
          ))}
        </div>

        <h3>Why this style? One line, and it's remembered.</h3>
        <input className="why" value={why} placeholder="This is for skeptical founders, so keep it calm." onChange={(e) => setWhy(e.target.value)} />

        <h3>Anything specific? (optional)</h3>
        <input className="why" value={goal} placeholder="Find the strongest 45 seconds and open on the claim." onChange={(e) => setGoal(e.target.value)} />

        <h3>Edit it like this video (optional)</h3>
        <div className="ref-drop">
          {refs.items.length ? <AttachmentStrip items={refs.items} onRemove={refs.remove} onRole={refs.setRole} /> : <Pick label="Choose a reference video" accept="video/*" onFiles={(f) => void refs.add(f.slice(0, 1))} />}
        </div>

        <div className="flow-foot">
          <span>
            <i className="dot" /> Autopilot on: only publishing, paying or deleting footage will stop you.
          </span>
          <label className="lang">
            <span className="sr">Spoken language</span>
            <select value={locale} onChange={(e) => setLocale(e.target.value)}>
              <option value="en-US">English</option>
              <option value="en-IN">English (India)</option>
              <option value="hi-IN">Hindi</option>
            </select>
          </label>
          {s.accounts.length > 1 && (
            <select className="account-pick" aria-label="Claude account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {s.accounts.filter((a) => a.signedIn).map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          )}
          <ModelPicker model={model.model} effort={model.effort} accountId={accountId} onChange={(m, effort) => setModel({ model: m, effort })} />
          <button className="primary" disabled={!video || footage.busy || refs.busy} onClick={go}>
            Go
          </button>
        </div>
      </div>
    </Modal>
  );
}

type Call = { id: number; atSeconds: number | null; text: string };

export function Review({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useStore();
  const e = s.editors.find((v) => v.id === id);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [versions, setVersions] = useState<{ version: number; note: string | null }[]>([]);
  const [note, setNote] = useState("");
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    void store.attempt(async () => {
      setOutputs(await api<string[]>("GET", `/api/chats/${id}/outputs`));
      setCalls(await api<Call[]>("GET", `/api/chats/${id}/review`));
      setVersions(await api<{ version: number; note: string | null }[]>("GET", `/api/chats/${id}/versions`));
    });
  }, [id]);

  if (!e) return null;
  const rank = (n: string) => Number(n.match(/^V(\d+)/)?.[1] ?? 0) + (n.includes("preview") ? 0 : 0.5);
  const videos = outputs.filter((n) => n.endsWith(".mp4")).sort((a, b) => rank(b) - rank(a));
  const current = picked ?? videos[0];
  const url = (n: string) => `/api/chats/${id}/out/${encodeURIComponent(n)}`;
  const stem = current?.replace(/\.mp4$/, "");
  const seek = (t: number) => {
    const v = document.querySelector<HTMLVideoElement>(".review video");
    if (v) v.currentTime = t;
  };
  const submit = () => {
    if (!note.trim()) return;
    s.send(e.id, `At ${formatTime(at)}: ${note}`);
    onClose();
  };
  return (
    <Modal title={`Review · ${e.mission?.title ?? ""}`} onClose={onClose} wide>
      <div className="review">
        <div className="review-main">
          {current ? <video className="player real" src={url(current)} controls onTimeUpdate={(v) => setAt(v.currentTarget.currentTime)} /> : <div className="player empty">Nothing rendered yet.</div>}
          <form
            className="comment"
            onSubmit={(ev) => {
              ev.preventDefault();
              submit();
            }}
          >
            <input value={note} placeholder={`Comment at ${formatTime(at)}…`} aria-label="Comment" onChange={(v) => setNote(v.target.value)} />
            <button type="submit" disabled={!note.trim()}>
              Ask for changes
            </button>
          </form>
        </div>
        <div className="review-side">
          <h3>Calls {e.name} made</h3>
          {!calls.length && <p className="lede">No calls logged yet.</p>}
          {calls.map((c) => (
            <div className="call" key={c.id}>
              {c.atSeconds !== null ? <button onClick={() => seek(c.atSeconds!)}>{formatTime(c.atSeconds)}</button> : <i />}
              <span>{c.text}</span>
            </div>
          ))}
          <h3>Versions</h3>
          <div className="versions">
            {videos.map((n) => (
              <button key={n} className={n === current ? "on" : ""} onClick={() => setPicked(n)}>
                {n.replace(".mp4", "").replace("-preview", " preview")}
              </button>
            ))}
          </div>
          {versions.length > 1 && <small className="lede">{versions.length} saved edits. Ask {e.name} to go back to any of them.</small>}
          {current && (
            <div className="render-links">
              <a href={url(current)} download>MP4</a>
              {outputs.includes(`${stem}.srt`) && <a href={url(`${stem}.srt`)} download>SRT</a>}
              {outputs.includes(`${stem}.fcpxml`) && <a href={url(`${stem}.fcpxml`)} download>FCPXML for Resolve</a>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function Accounts({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [useKey, setUseKey] = useState(false);
  const add = () =>
    void s.attempt(async () => {
      const a = await api<{ id: string }>("POST", "/api/accounts", { label: label.trim() || "Claude account", apiKey: useKey ? apiKey : undefined });
      setLabel("");
      setApiKey("");
      if (!useKey) await api("POST", `/api/accounts/${a.id}/login`, {});
    });
  return (
    <Modal title="Claude accounts" onClose={onClose} wide>
      <p className="lede">Each account signs in through Claude's own login page. Dojo never sees a password or token. You choose the account for each chat, and Dojo never moves a chat between accounts.</p>
      <div className="account-grid">
        {s.accounts.map((a) => (
          <article key={a.id} className="card">
            <b>{a.label}</b>
            <small>{a.email ?? (a.kind === "api_key" ? "API key" : a.signedIn ? "Signed in" : "Not signed in")}{a.plan ? ` · ${a.plan}` : ""}</small>
            {a.limits.map((l) => (
              <div key={l.id} className="limit-row">
                <span>{l.label}</span>
                <div className="mission-bar"><i style={{ width: `${Math.round(100 - l.usedPercent)}%` }} /></div>
                <small>{Math.round(100 - l.usedPercent)}% left · {resetLabel(l.resetsAt)}</small>
              </div>
            ))}
            {s.login?.id === a.id && s.login.status === "link" && <a className="pick-btn" href={s.login.url} target="_blank" rel="noreferrer">Open Claude sign-in</a>}
            {s.login?.id === a.id && s.login.status === "failed" && <p className="job bad">Sign-in didn't finish.</p>}
            <div className="card-actions">
              <button title="Refresh" aria-label={`Refresh ${a.label}`} onClick={() => void s.attempt(() => api("POST", `/api/accounts/${a.id}/refresh`))}><RefreshCw size={14} /></button>
              {a.kind === "subscription" && !a.signedIn && <button onClick={() => void s.attempt(() => api("POST", `/api/accounts/${a.id}/login`, {}))}>Sign in</button>}
              {a.kind === "subscription" && a.signedIn && a.id !== "default" && <button aria-label={`Sign out of ${a.label}`} title="Sign out" onClick={() => void s.attempt(() => api("POST", `/api/accounts/${a.id}/logout`))}><LogOut size={14} /></button>}
              {a.id !== "default" && <button aria-label={`Remove ${a.label}`} title="Remove" onClick={() => void s.attempt(() => api("DELETE", `/api/accounts/${a.id}`))}><Trash2 size={14} /></button>}
            </div>
          </article>
        ))}
        <article className="card add">
          <b>Add an account</b>
          <input className="why" value={label} placeholder="Studio 2" aria-label="Account name" onChange={(e) => setLabel(e.target.value)} />
          {useKey && <input className="why" type="password" value={apiKey} placeholder="Console API key" aria-label="API key" onChange={(e) => setApiKey(e.target.value)} />}
          <label className="check"><input type="checkbox" checked={useKey} onChange={(e) => setUseKey(e.target.checked)} /> Use a Console API key</label>
          <button className="primary" disabled={useKey && !apiKey.trim()} onClick={add}><Plus size={15} /> {useKey ? "Add" : "Add and sign in"}</button>
        </article>
      </div>
    </Modal>
  );
}

function StylesBoard() {
  const s = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const start = (f: File) =>
    void s.attempt(async () => {
      const stored = await uploadFile(f, () => {});
      const r = await api<{ job: string }>("POST", "/api/styles/learn", { hash: stored.hash, accountId: s.settings.account });
      setJob(r.job);
    });
  const running = job ? s.jobs.get(job) : null;
  const shown = s.styles.find((v) => v.id === open);
  if (shown) {
    return (
      <div className="style-detail">
        <button className="back" onClick={() => setOpen(null)}>Back to styles</button>
        <h3>{shown.name} {shown.status === "draft" && <em>Draft</em>}</h3>
        <p className="lede">{shown.card.summary}</p>
        {shown.card.structure && <p>{shown.card.structure}</p>}
        <div className="rule-list">
          {shown.card.rules?.map((r) => (
            <div key={r.rule} className="rule">
              <span>{r.rule}</span>
              {r.evidence && <small>{r.evidence.map((e) => formatTime(e.at)).join(", ")}{r.confidence ? ` · ${r.confidence}` : ""}</small>}
            </div>
          ))}
        </div>
        {!!shown.card.unsure?.length && <><h3>What Claude couldn't confirm</h3>{shown.card.unsure.map((u) => <p key={u} className="lede">{u}</p>)}</>}
        {!!shown.card.rejected?.length && <><h3>Rules dropped by the evidence check</h3>{shown.card.rejected.map((u) => <p key={u.rule} className="lede">{u.rule}: {u.reason}</p>)}</>}
        <div className="flow-foot">
          <button className="ghost-btn" onClick={() => { void s.attempt(() => api("DELETE", `/api/styles/${shown.id}`)); setOpen(null); }}>Delete</button>
          {shown.status === "draft" && <button className="primary" onClick={() => void s.attempt(() => api("PATCH", `/api/styles/${shown.id}`, { status: "approved" }))}>Approve this style</button>}
        </div>
      </div>
    );
  }
  return (
    <>
      <p className="lede">Your saved looks and editing styles. Add a reference video and Claude studies it once. Nothing goes live until you approve it.</p>
      {running && <JobLine job={running} />}
      <div className="board-grid">
        {s.styles.map((c) => (
          <button key={c.id} className="card" onClick={() => setOpen(c.id)}>
            <span className="swatches big">
              {(c.card.colors ?? []).slice(0, 3).map((v) => (
                <i key={v} style={{ background: v }} />
              ))}
            </span>
            <b>{c.name}</b>
            <small>{c.status === "draft" ? "Draft, needs approval" : (s.modes.find((m) => m.id === c.mode)?.label ?? "Any video")}</small>
            <p>{c.card.summary}</p>
          </button>
        ))}
        <article className="card add">
          <Icon name="film" size={24} color="#7a4a2c" />
          <b>Learn from a reference</b>
          <p>Uses Opus on your {s.activeAccount()?.label ?? "default"} account.</p>
          <Pick label="Choose a video" accept="video/*" onFiles={(f) => start(f[0])} />
        </article>
      </div>
    </>
  );
}

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
  return (
    <div className="recipe-list">
      {s.recipes.map((p) => (
        <article key={p.id} className="recipe">
          <button className="recipe-use" onClick={() => use(p.id, p.text)}>
            <b>{p.title}</b>
            <p>{p.text}</p>
          </button>
          <span>{p.uses} uses</span>
          <button className="icon-btn" aria-label={`Delete ${p.title}`} onClick={() => void s.attempt(async () => { await api("DELETE", `/api/recipes/${p.id}`); await s.refresh(); })}><Trash2 size={14} /></button>
        </article>
      ))}
      <form
        className="recipe-add"
        onSubmit={(e) => {
          e.preventDefault();
          void s.attempt(async () => {
            await api("POST", "/api/recipes", { title, text });
            setTitle("");
            setText("");
          });
        }}
      >
        <input className="why" value={title} placeholder="Recipe name" aria-label="Recipe name" onChange={(e) => setTitle(e.target.value)} />
        <input className="why" value={text} placeholder="What should the editor do?" aria-label="Recipe text" onChange={(e) => setText(e.target.value)} />
        <button className="primary" disabled={!title.trim() || !text.trim()}>Save</button>
      </form>
    </div>
  );
}

function ToolCard({ t }: { t: (typeof TOOLS)[number] }) {
  const s = useStore();
  const [job, setJob] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const running = job ? s.jobs.get(job) : null;
  const pack = "pack" in t ? s.packs.find((p) => p.id === t.pack) : null;
  const result = (running?.status === "done" ? running.result : null) as { file?: StoredFile; words?: unknown[] } | null;
  const run = (f: File) =>
    void s.attempt(async () => {
      setAdding(true);
      const stored = await uploadFile(f, () => {}).finally(() => setAdding(false));
      const r = await api<{ job: string }>("POST", `/api/tools/${t.id}`, { hash: stored.hash, ...t.params });
      setJob(r.job);
    });
  return (
    <article className="card">
      <Icon name={t.icon} size={24} color="#1f8c7f" />
      <b>{t.name}</b>
      <p>{t.note}</p>
      <small>{t.tag}</small>
      {pack && !pack.installed ? <PackButton id={pack.id} name={pack.name} /> : <Pick label={adding ? "Adding…" : "Choose a file"} accept="video/*,image/*" onFiles={(f) => run(f[0])} />}
      {running && <JobLine job={running} />}
      {result?.file && <a className="pick-btn" href={`/api/files/${result.file.hash}`} download={result.file.name}>Save {result.file.name}</a>}
      {result?.words && <small>{result.words.length} words transcribed</small>}
    </article>
  );
}

function PackButton({ id, name }: { id: string; name: string }) {
  const s = useStore();
  const [job, setJob] = useState<string | null>(null);
  const running = job ? s.jobs.get(job) : null;
  useEffect(() => {
    if (running?.status === "done") void s.refresh();
  }, [running?.status, s]);
  if (running) return <JobLine job={running} />;
  return (
    <button className="pick-btn" onClick={() => void s.attempt(async () => setJob((await api<{ job: string }>("POST", `/api/packs/${id}/install`)).job))}>
      Install {name}
    </button>
  );
}

function LibraryBoard() {
  const s = useStore();
  const lib = s.library;
  const [links, setLinks] = useState("");
  const [count, setCount] = useState(10);
  const [path, setPath] = useState("");
  const [data, setData] = useState<{ tree: { path: string; count: number }[]; gaps: string[] }>({ tree: [], gaps: [] });
  const [shots, setShots] = useState<{ id: string; summary: string; implies: string[]; category: string | null }[]>([]);
  const [uploading, setUploading] = useState(0);
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
      for (const f of files) {
        const stored = await uploadFile(f, () => {});
        await api("POST", "/api/library/import", { hashes: [stored.hash] });
        setUploading((n) => n - 1);
      }
    });
  const pending = lib?.pending ?? 0;
  const counts = [...new Set([10, 25, 50, pending].filter((n) => n > 0 && n <= pending))];
  const estimate = lib?.percentPerShot ? `About ${Math.max(1, Math.round(lib.percentPerShot * count))}% of your session` : "Run 10 first to measure the usage";

  return (
    <>
      <div className="import">
        <div>
          <b>{lib?.clips ?? 0} clips · {lib?.shots ?? 0} shots · {lib?.analyzed ?? 0} analyzed</b>
          <p>{pending ? `${pending} shots are waiting for Claude. ${estimate}.` : "Every shot has been analyzed."} Batches grow 10, 20, 30, 40, and pause while editors work.</p>
        </div>
        {pending > 0 && (
          <div className="import-pick">
            {counts.map((n) => (
              <button key={n} className={count === n ? "on" : ""} onClick={() => setCount(n)}>{n === pending ? `All ${n}` : n}</button>
            ))}
            <button className="primary" onClick={() => void s.attempt(() => api("POST", "/api/library/analyze", { count: Math.min(count, pending), accountId: s.settings.account }))}>Analyze</button>
          </div>
        )}
      </div>
      {active.map((j) => <JobLine key={j.id} job={j} />)}
      {!s.keys.openrouter && <p className="lede">Keyword search works now. Add an OpenRouter key in Settings for meaning search, where "hard work" can find a late-night desk.</p>}
      <div className="import-row">
        <Pick label={uploading ? `Adding ${uploading}…` : "Add videos"} accept="video/*" multiple onFiles={importFiles} />
        <textarea value={links} rows={2} placeholder="Paste Google Drive links set to Anyone with the link, one per line" aria-label="Google Drive links" onChange={(e) => setLinks(e.target.value)} />
        <button className="primary" disabled={!links.trim()} onClick={() => void s.attempt(async () => { await api("POST", "/api/library/drive", { links: links.split(/\s+/).filter(Boolean) }); setLinks(""); })}>Import</button>
      </div>
      <div className="chips">
        {path && <button onClick={() => setPath(path.split(" / ").slice(0, -1).join(" / "))}>Back</button>}
        {data.tree.map((t) => (
          <button key={t.path} onClick={() => setPath(t.path)}>{t.path.split(" / ").pop()} · {t.count}</button>
        ))}
      </div>
      <div className="library-grid">
        {shots.map((c) => (
          <article key={c.id} className="clip">
            <img src={`/api/library/shots/${c.id}/filmstrip`} alt="" loading="lazy" />
            <span>{c.implies.slice(0, 3).join(", ") || c.summary}</span>
          </article>
        ))}
      </div>
      {data.gaps.length > 0 && (
        <>
          <h3>Footage you're missing</h3>
          {data.gaps.slice(0, 5).map((g) => <p key={g} className="lede">{g}</p>)}
        </>
      )}
    </>
  );
}

const KEYS = [
  { id: "openrouter", name: "OpenRouter", note: "Embeddings for B-roll meaning search. Text only." },
  { id: "google_api_key", name: "Google", note: "Needed only for Drive folder links." },
  { id: "epidemic", name: "Epidemic Sound", note: "Music and effects. Downloads need your paid plan." },
];

type Doctor = Record<string, { ok: boolean; detail: string }> & { freeDiskGB: never };

function SettingsBoard() {
  const s = useStore();
  const [values, setValues] = useState<Record<string, string>>({});
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  useEffect(() => {
    void store.attempt(async () => setDoctor(await api<Doctor>("GET", "/api/doctor")));
  }, []);
  const saveKey = (id: string) =>
    void s.attempt(async () => {
      await api("POST", `/api/keys/${id}`, { value: values[id] });
      setValues({ ...values, [id]: "" });
      await s.refresh();
    });
  return (
    <div className="settings">
      <h3>Connections</h3>
      <p className="lede">Keys are kept in your Mac's Keychain and never shown again.</p>
      {KEYS.map((k) => (
        <div className="setting-row" key={k.id}>
          <div>
            <b>{k.name} {s.keys[k.id] && <em>Connected</em>}</b>
            <small>{k.note}</small>
          </div>
          <input className="why" type="password" value={values[k.id] ?? ""} placeholder={s.keys[k.id] ? "Replace key" : "Paste key"} aria-label={`${k.name} key`} onChange={(e) => setValues({ ...values, [k.id]: e.target.value })} />
          <button className="primary" disabled={!values[k.id]?.trim()} onClick={() => saveKey(k.id)}>Save</button>
          {s.keys[k.id] && <button className="icon-btn" aria-label={`Remove ${k.name} key`} onClick={() => void s.attempt(async () => { await api("DELETE", `/api/keys/${k.id}`); await s.refresh(); })}><Trash2 size={14} /></button>}
        </div>
      ))}
      <h3>Tool packs</h3>
      {s.packs.map((p) => (
        <div className="setting-row" key={p.id}>
          <div>
            <b>{p.name} {p.installed && <em>Installed</em>}</b>
            <small>{p.about} {p.size}.</small>
          </div>
          {!p.installed && <PackButton id={p.id} name={p.name} />}
        </div>
      ))}
      <h3>Personal Memory</h3>
      <p className="lede">When you correct an editor the same way twice, it becomes a rule. Text inside footage can never become one.</p>
      {!s.memory.length && <p className="lede">Nothing learned yet.</p>}
      {s.memory.map((r) => (
        <div className="setting-row" key={r.id}>
          <input className="why" value={editing[r.id] ?? r.text} aria-label="Memory rule" onChange={(e) => setEditing({ ...editing, [r.id]: e.target.value })} onBlur={() => editing[r.id] && void s.attempt(() => api("PATCH", `/api/memory/${r.id}`, { text: editing[r.id] }))} />
          <button className="icon-btn" aria-label="Remove rule" onClick={() => void s.attempt(async () => { await api("DELETE", `/api/memory/${r.id}`); await s.refresh(); })}><Trash2 size={14} /></button>
        </div>
      ))}
      <h3>This Mac</h3>
      {doctor && ["claude", "ffmpeg", "native", "python"].map((k) => (
        <div className="setting-row" key={k}>
          <div>
            <b>{k === "native" ? "Native tools" : k[0].toUpperCase() + k.slice(1)} {doctor[k].ok && <em>Ready</em>}</b>
            <small>{doctor[k].detail}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

const TITLES: Record<BoardId, string> = { styles: "Styles", prompts: "Prompt recipes", library: "B-roll library", tools: "Tool shelf", settings: "Settings" };

export function Board({ id, onClose }: { id: BoardId; onClose: () => void }) {
  return (
    <Modal title={TITLES[id]} onClose={onClose} wide={id !== "prompts"}>
      {id === "styles" && <StylesBoard />}
      {id === "prompts" && <PromptsBoard onClose={onClose} />}
      {id === "library" && <LibraryBoard />}
      {id === "settings" && <SettingsBoard />}
      {id === "tools" && (
        <>
          <p className="lede">These tools run on your Mac and use no Claude allowance.</p>
          <div className="board-grid">
            {TOOLS.map((t) => (
              <ToolCard key={t.id} t={t} />
            ))}
          </div>
        </>
      )}
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
