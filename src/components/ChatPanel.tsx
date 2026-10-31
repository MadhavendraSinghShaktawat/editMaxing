import { useEffect, useRef, useState } from "react";
import { LogOut, X } from "lucide-react";
import { STAGES, STARTERS } from "../sim/data";
import { Attachment, Decision, Editor, Message, stateLabel, store, useStore } from "../sim/store";
import { AttachButton, AttachmentStrip, formatSize, formatTime, useAttachments } from "./Attach";
import { Icon } from "./Icon";
import { ModelPicker } from "./ModelPicker";
import { Filmstrip, Portrait } from "./Pixel";

function SentFile({ a }: { a: Attachment }) {
  return (
    <div className="sent-file">
      {a.thumb ? <img src={a.thumb} alt="" /> : <Icon name="movie" size={22} />}
      <span>
        <b>{a.name}</b>
        <small>
          {a.role === "reference" ? "Style reference" : a.role === "footage" ? "Footage" : "File"}
          {a.duration ? ` · ${formatTime(a.duration)}` : ""} · {formatSize(a.size)}
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

function Bubble({ m, editor }: { m: Message; editor: Editor }) {
  if (m.from === "system") return <div className="msg-system">{m.text}</div>;
  if (m.tool) {
    return (
      <div className="msg-tool">
        <Icon name={STAGES.find((s) => s.label === m.tool)?.icon ?? "gear"} size={13} />
        {m.text}
      </div>
    );
  }
  return (
    <div className={`msg ${m.from}`}>
      {m.text}
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
  const files = useAttachments("reference");
  const scroll = useRef<HTMLDivElement>(null);
  const count = e?.messages.length ?? 0;

  useEffect(() => {
    setEnding(false);
    setDraft("");
  }, [e?.id]);

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [count, e?.id]);

  if (!e) return null;
  const stage = STAGES[e.stage];
  const ready = e.mission && stage.id === "review";

  const canSend = (draft.trim() || files.items.length) && !files.busy;
  const send = () => {
    if (!canSend) return;
    store.send(e.id, draft, files.ready());
    setDraft("");
    files.clear();
  };

  return (
    <aside
      className={`chat ${dropping ? "dropping" : ""}`}
      aria-label={`Chat with ${e.name}`}
      onDragOver={(ev) => {
        ev.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(ev) => {
        ev.preventDefault();
        setDropping(false);
        void files.add(ev.dataTransfer.files);
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
          {ending ? (
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
        </div>

        {ready && (
          <button className="review-cta" onClick={() => onReview(e.id)}>
            <Icon name="star" size={17} color="#3a2115" /> Watch V{e.version} and review
          </button>
        )}

        <form
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
            <ModelPicker model={e.model} effort={e.effort} onChange={(m, v) => s.setModel(e.id, m, v)} />
            <button type="submit" className="send" disabled={!canSend}>
              {files.items.some((f) => f.progress < 1) ? "Adding…" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}
