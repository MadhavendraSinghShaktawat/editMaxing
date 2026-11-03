import { useEffect, useRef, useState } from "react";
import { Brain, Check, LogOut, Play, Square, TriangleAlert, X } from "lucide-react";
import { STAGES, STARTERS } from "../sim/data";
import { api } from "../sim/engine";
import { Attachment, Decision, Editor, Message, stateLabel, store, useStore } from "../sim/store";
import { AttachButton, AttachmentStrip, formatSize, formatTime, useAttachments } from "./Attach";
import { CompactChip, ContextCompactionRow, ContextWindowMeter, shouldOfferResumeCompaction } from "./Context";
import { DecisionCards } from "./Decisions";
import { Icon } from "./Icon";
import { ModelPicker } from "./ModelPicker";
import { Filmstrip, Portrait } from "./Pixel";
import { Button } from "./ui";

function SentFile({ a }: { a: Attachment }) {
  return (
    <div className="sent-file">
      {a.thumb ? <img src={a.thumb} alt="" /> : <Icon name="movie" size={22} />}
      <span>
        <b>{a.name}</b>
        <small>
          {a.role === "reference" ? "Style reference" : a.role === "footage" ? "Footage" : "File"}
          {a.duration ? ` · ${formatTime(a.duration)}` : ""}
          {a.size ? ` · ${formatSize(a.size)}` : ""}
        </small>
      </span>
    </div>
  );
}

function DecisionCard({ editor, decision }: { editor: Editor; decision: Decision }) {
  const resolved = decision.chosen !== undefined;
  return (
    <div className={`decision ${resolved ? "resolved" : ""}`}>
      <div className="decision-head">
        <span>Pick a B-roll · {decision.at}</span>
        <q>{decision.prompt.replace(/[“”]/g, "")}</q>
      </div>
      <div className="decision-options">
        {decision.options.map((o) => (
          <button
            key={o.id}
            disabled={resolved}
            className={decision.chosen === o.id ? "chosen" : ""}
            onClick={() => store.choose(editor.id, decision.id, o.id)}
          >
            <Filmstrip kind={o.scene} frames={1} playing={!resolved} />
            <b>{o.label}</b>
            <small>{o.why}</small>
          </button>
        ))}
      </div>
      {!resolved && (
        <div className="decision-more">
          <button onClick={() => store.choose(editor.id, decision.id, "none")}>None of these</button>
          <button onClick={() => store.choose(editor.id, decision.id, decision.options[0].id)}>Let {editor.name} choose</button>
        </div>
      )}
    </div>
  );
}

/** Claude writes light Markdown. This covers what it uses in chat, and never renders raw HTML. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
        part.startsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part,
      )}
    </>
  );
}

function Rich({ text }: { text: string }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const list = /^[-*] /.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.list === list && list) last.lines.push(line.slice(2));
    else blocks.push({ list, lines: [list ? line.slice(2) : line] });
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i}>{b.lines.map((l, k) => <li key={k}><Inline text={l} /></li>)}</ul>
        ) : (
          <p key={i}><Inline text={b.lines[0].replace(/^#+\s+/, "")} /></p>
        ),
      )}
    </>
  );
}

/**
 * The newest cut, pinned under the header, so it's always one tap away however long the chat
 * gets. It opens into a player here, and into the full review with versions and comments.
 */
function LatestCut({ e, onReview }: { e: Editor; onReview: () => void }) {
  const [open, setOpen] = useState(false);
  const latest = [...e.messages].reverse().find((m) => m.video);
  const count = e.messages.filter((m) => m.video).length;
  useEffect(() => setOpen(false), [latest?.id]);
  if (!latest?.video) return null;
  return (
    <div className={`latest-cut ${open ? "is-open" : ""}`}>
      {open && <video key={latest.video.url} src={latest.video.url} controls autoPlay playsInline />}
      <div className="latest-cut-bar">
        <button type="button" className="latest-cut-play" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <X size={14} /> : <Play size={14} fill="currentColor" />}
          <span><b>{latest.text}</b>{count > 1 && <small>{count} versions</small>}</span>
        </button>
        <button type="button" className="latest-cut-review" onClick={onReview}>Review</button>
      </div>
    </div>
  );
}

function RenderCard({ m }: { m: Message }) {
  const v = m.video!;
  const failed = v.quality?.checks.filter((c) => !c.ok) ?? [];
  return (
    <div className="render-card">
      <video src={v.url} controls preload="metadata" />
      <div className="render-foot">
        <b>{m.text}</b>
        {v.quality && <span className={failed.length ? "qc bad" : "qc"}>{failed.length ? <TriangleAlert size={13} /> : <Check size={13} />} {failed.length ? `${failed.length} check${failed.length > 1 ? "s" : ""} failed` : "Quality check passed"}</span>}
      </div>
      {failed.map((c) => <small key={c.name}>{c.name}: {c.detail}</small>)}
      {v.quality && (
        <div className="render-links">
          <a href={v.url} download>MP4</a>
          {v.srt && <a href={v.srt} download>SRT</a>}
          {v.fcpxml && <a href={v.fcpxml} download>FCPXML for Resolve</a>}
        </div>
      )}
    </div>
  );
}

/** Memory asks once, in one line, and the person decides with one tap. */
function MemoryCard({ m }: { m: Message & { memory: NonNullable<Message["memory"]> } }) {
  const s = useStore();
  const rule = s.memory.find((r) => r.id === m.memory.ruleId);
  const client = s.clients.find((c) => c.id === m.memory.clientId);
  const decide = (choice: "personal" | "client" | "dismiss") => void s.attempt(() => api("POST", `/api/memory/${m.memory.ruleId}/confirm`, { choice }));
  if (!rule) return <div className="msg-system">Memory: {m.text} (decided)</div>;
  if (rule.status !== "suggested") return <div className="msg-system">Remembered: {rule.text}</div>;
  return (
    <div className="memory-card" role="group" aria-label="Memory suggestion">
      <span><Brain size={13} /> Remember this?</span>
      <b>{rule.text}</b>
      <div>
        <Button size="sm" variant="primary" onClick={() => decide("personal")}>Keep</Button>
        {client && <Button size="sm" variant="secondary" onClick={() => decide("client")}>For {client.name}</Button>}
        <Button size="sm" variant="ghost" onClick={() => decide("dismiss")}>Not now</Button>
      </div>
    </div>
  );
}

function Bubble({ m, editor }: { m: Message; editor: Editor }) {
  if (m.memory) return <MemoryCard m={m as Message & { memory: NonNullable<Message["memory"]> }} />;
  if (m.video) return <RenderCard m={m} />;
  if (m.compaction) return <ContextCompactionRow m={m as Message & { compaction: NonNullable<Message["compaction"]> }} />;
  if (m.error) return <div className="msg-system bad">{m.text}</div>;
  if (m.from === "system") return <div className="msg-system">{m.text}</div>;
  if (m.tool) {
    return (
      <div className="msg-tool">
        <Icon name={STAGES.find((s) => s.label === m.tool)?.icon ?? "gear"} size={13} />
        {m.text}
        {m.childId && store.editors.some((x) => x.id === m.childId) && <button type="button" className="msg-tool-link" onClick={() => store.select(m.childId!)}>Watch</button>}
      </div>
    );
  }
  return (
    <div className={`msg ${m.from}`}>
      {m.from === "editor" ? <Rich text={m.text} /> : m.text}
      {m.attachments?.map((a) => <SentFile key={a.id} a={a} />)}
      {m.decision && <DecisionCard editor={editor} decision={m.decision} />}
    </div>
  );
}

export function ChatPanel({ onReview, onVideo }: { onReview: (id: string) => void; onVideo: () => void }) {
  const s = useStore();
  const e = s.selected();
  const [draft, setDraft] = useState("");
  const [dropping, setDropping] = useState(false);
  const [ending, setEnding] = useState(false);
  const [keepFullHistory, setKeepFullHistory] = useState(false);
  const files = useAttachments(e?.mission ? "reference" : "footage");
  const scroll = useRef<HTMLDivElement>(null);
  const count = (e?.messages.length ?? 0) + (e?.questions.length ?? 0) + (e?.draft.length ?? 0);

  useEffect(() => {
    setEnding(false);
    setDraft("");
  }, [e?.id]);

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [count, e?.id]);

  useEffect(() => {
    if (e && s.pendingDraft !== null) {
      setDraft(s.pendingDraft);
      s.pendingDraft = null;
    }
  }, [s.pendingDraft, e, s]);

  if (!e) return null;
  const stage = STAGES[e.stage];
  const ready = e.mission && stage.id === "review";
  const busy = e.status === "working" || e.status === "thinking";
  // An agent another chat started shows its work here, but takes directions only from that chat.
  const readOnly = !!e.parentId;
  const parent = e.parentId ? s.editors.find((x) => x.id === e.parentId) ?? null : null;

  const canSend = (draft.trim() || files.items.length) && !files.busy;
  // A large chat back after Claude's cache expired offers to compact first; the chip switches to Keep.
  const account = s.accounts.find((a) => a.id === e.accountId);
  const offerCompact = s.live && !busy && shouldOfferResumeCompaction(e.context, account?.kind);
  const compactsBeforeSend = offerCompact && !keepFullHistory;
  const modelName = account?.models.find((m) => m.id === e.model)?.name ?? e.model;
  const send = () => {
    if (!canSend) return;
    // "/compact" typed into the box runs Claude Code's own compact command.
    if (/^\/compact\b/.test(draft.trim()) && !files.items.length) {
      void store.attempt(() => api("POST", `/api/chats/${e.id}/compact`));
      setDraft("");
      return;
    }
    store.send(e.id, draft, files.ready(), { compactFirst: compactsBeforeSend });
    setDraft("");
    setKeepFullHistory(false);
    files.clear();
  };

  return (
    <aside
      className={`chat ${dropping ? "dropping" : ""}`}
      aria-label={`Chat with ${e.name}`}
      onDragOver={(ev) => {
        ev.preventDefault();
        if (!readOnly) setDropping(true);
      }}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(ev) => {
        ev.preventDefault();
        setDropping(false);
        if (!readOnly) void files.add(ev.dataTransfer.files);
      }}
    >
      <div className="chat-frame sheet">
        {dropping && <div className="drop-veil">Drop a reference video for {e.name}</div>}
        <div className="chat-head">
          <span className="chat-face">
            <Portrait editor={e} scale={1.75} />
          </span>
          <div className="chat-who">
            <label>
              <span className="sr">Choose editor</span>
              <select value={e.id} onChange={(v) => s.select(v.target.value)}>
                {s.editors.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <span className={`state ${e.activity}`}>{stateLabel[e.activity]}</span>
          </div>
          {readOnly ? null : ending ? (
            <button className="end-confirm" onClick={() => s.endChat(e.id)} onBlur={() => setEnding(false)} autoFocus>
              End chat?
            </button>
          ) : (
            <button className="ghost" aria-label="End chat" title="End chat" onClick={() => setEnding(true)}>
              <LogOut size={16} />
            </button>
          )}
          <button className="ghost" aria-label="Close chat" title="Close" onClick={() => s.select(null)}>
            <X size={18} />
          </button>
        </div>

        {e.mission && (
          <div className="chat-mission">
            <b>{e.mission.title}</b>
            <span>{e.detail}</span>
            <div className="mission-bar">
              <i style={{ width: `${Math.round(e.overall * 100)}%` }} />
            </div>
          </div>
        )}

        {parent && (
          <div className="spawned-by">
            <span>Started by <b>{parent.name}</b> · watch only</span>
            <button type="button" onClick={() => s.select(parent.id)}>Open {parent.name}</button>
          </div>
        )}

        {!readOnly && <LatestCut e={e} onReview={() => onReview(e.id)} />}

        <div className="chat-body" ref={scroll}>
          {e.messages.length === 0 && (
            <div className="starter">
              <h2>Hi, I'm {e.name}.</h2>
              <p>What are we making today?</p>
              <div className="starter-list">
                {STARTERS.map((o) => (
                  <button key={o.label} onClick={() => (o.action === "video" ? onVideo() : setDraft(o.prompt ?? ""))}>
                    <b>{o.label}</b>
                    <small>{o.note}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {e.messages.map((m) => (
            <Bubble key={m.id} m={m} editor={e} />
          ))}
          {e.draft && <div className="msg editor"><Rich text={e.draft} /></div>}
          <DecisionCards list={e.questions} editorName={e.name} />
        </div>

        {ready && (
          <button className="review-cta" onClick={() => onReview(e.id)}>
            <Icon name="star" size={17} color="#3a2115" /> {s.live ? "Watch and review" : `Watch V${e.version} and review`}
          </button>
        )}

        {!readOnly && <form
          className="composer"
          onSubmit={(ev) => {
            ev.preventDefault();
            send();
          }}
        >
          <AttachmentStrip items={files.items} onRemove={files.remove} onRole={files.setRole} />
          <textarea
            rows={2}
            value={draft}
            placeholder={e.mission ? `Tell ${e.name} what to change…` : `Message ${e.name}, or drop a video…`}
            aria-label="Message"
            onChange={(v) => setDraft(v.target.value)}
            onPaste={(v) => {
              if (v.clipboardData.files.length) {
                v.preventDefault();
                void files.add(v.clipboardData.files);
              }
            }}
            onKeyDown={(v) => {
              if (v.key === "Enter" && !v.shiftKey) {
                v.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            <AttachButton onFiles={(f) => void files.add(f)} />
            <ModelPicker model={e.model} effort={e.effort} accountId={e.accountId} onChange={(m, v) => s.setModel(e.id, m, v)} />
            {s.live && s.accounts.length > 1 && (
              <select className="account-pick" aria-label="Claude account for this chat" value={e.accountId} disabled={e.started} onChange={(v) => s.setAccount(e.id, v.target.value)}>
                {s.accounts.filter((a) => a.signedIn).map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            )}
            {busy && (
              <button type="button" className="stop" aria-label="Stop" title="Stop" onClick={() => s.stop(e.id)}>
                <Square size={13} fill="currentColor" />
              </button>
            )}
            {s.live && e.context && (
              <ContextWindowMeter
                usage={e.context}
                modelDisplayName={modelName}
                onCompact={() => void store.attempt(() => api("POST", `/api/chats/${e.id}/compact`))}
                compactDisabled={busy}
                compactDisabledReason={busy ? `Available when ${e.name} finishes this turn.` : null}
              />
            )}
            {offerCompact && e.context && <CompactChip tokens={e.context.usedTokens} keep={keepFullHistory} onToggle={() => setKeepFullHistory(!keepFullHistory)} />}
            <button type="submit" className="send" disabled={!canSend} title={compactsBeforeSend && e.context ? `Summarize ${e.context.usedTokens.toLocaleString("en-US")} tokens of history, then send` : undefined}>
              {files.items.some((f) => f.progress < 1) ? "Adding…" : compactsBeforeSend ? "Compact and send" : "Send"}
            </button>
          </div>
        </form>}
      </div>
    </aside>
  );
}
