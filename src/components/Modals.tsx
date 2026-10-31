import { ReactNode, useEffect, useState } from "react";
import { PROMPT_CARDS, STYLE_CARDS, TOOLS, Thumb } from "../sim/data";
import { store } from "../sim/store";
import { BoardId } from "./Hud";
import { AttachmentStrip, useAttachments } from "./Attach";
import { Icon } from "./Icon";
import { ModelPicker } from "./ModelPicker";
import { Filmstrip } from "./Pixel";

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

export function NewMission({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [style, setStyle] = useState(STYLE_CARDS[0]);
  const [why, setWhy] = useState("");
  const [drag, setDrag] = useState(false);
  const [refDrag, setRefDrag] = useState(false);
  const [model, setModel] = useState(store.lastModel);
  const refs = useAttachments("reference");

  const go = () => {
    const title = (file ?? "Untitled video").replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    store.startMission({ title, mode: style.mode, style: style.name, length: "--:--" }, why, refs.ready()[0], model);
    onClose();
  };

  return (
    <Modal title="New video" onClose={onClose} wide>
      <div className="mission-flow">
        <div
          className={`drop ${drag ? "over" : ""} ${file ? "has" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            setFile(e.dataTransfer.files[0]?.name ?? "footage.mp4");
          }}
        >
          <Icon name="film" size={30} color="#7a4a2c" />
          {file ? <b>{file}</b> : <b>Drop your raw video here</b>}
          <label className="pick">
            {file ? "Choose a different file" : "or choose a file"}
            <input type="file" accept="video/*" hidden onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)} />
          </label>
        </div>

        <h3>Pick a style</h3>
        <div className="style-grid">
          {STYLE_CARDS.map((c) => (
            <button key={c.id} className={style.id === c.id ? "on" : ""} onClick={() => setStyle(c)}>
              <span className="swatches">
                {c.swatch.map((v) => (
                  <i key={v} style={{ background: v }} />
                ))}
              </span>
              <b>{c.name}</b>
              <small>{c.mode}</small>
            </button>
          ))}
        </div>

        <h3>Why this style? One line, and it's remembered.</h3>
        <input className="why" value={why} placeholder="This is for skeptical founders, so keep it calm." onChange={(e) => setWhy(e.target.value)} />

        <h3>Edit it like this video (optional)</h3>
        <div
          className={`ref-drop ${refDrag ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setRefDrag(true);
          }}
          onDragLeave={() => setRefDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setRefDrag(false);
            void refs.add([...e.dataTransfer.files].slice(0, 1));
          }}
        >
          {refs.items.length ? (
            <AttachmentStrip items={refs.items} onRemove={refs.remove} onRole={refs.setRole} />
          ) : (
            <label className="pick">
              Drop a reference video, or choose one. Claude studies it once and you approve the style.
              <input type="file" accept="video/*" hidden onChange={(e) => e.target.files && void refs.add([...e.target.files].slice(0, 1))} />
            </label>
          )}
        </div>

        <div className="flow-foot">
          <span>
            <i className="dot" /> Autopilot on: only hard-to-undo steps will stop you.
          </span>
          <ModelPicker model={model.model} effort={model.effort} onChange={(m, effort) => setModel({ model: m, effort })} />
          <button className="primary" disabled={!file || refs.busy} onClick={go}>
            Go
          </button>
        </div>
      </div>
    </Modal>
  );
}

const CALLS = [
  { at: "1:12", text: "Kept a 1.4 second pause before the punchline." },
  { at: "0:42", text: "Used a late-night desk shot instead of literal coffee." },
  { at: "3:08", text: "Removed a retake and kept the second delivery." },
  { at: "5:31", text: "Added an explainer graphic for the pricing section." },
];

export function Review({ id, onClose }: { id: string; onClose: () => void }) {
  const e = store.editors.find((v) => v.id === id);
  const [pos, setPos] = useState(38);
  const [note, setNote] = useState("");
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => setPos((p) => (p >= 100 ? 0 : p + 0.5)), 100);
    return () => window.clearInterval(t);
  }, [playing]);

  if (!e) return null;
  const scene: Thumb = pos < 33 ? "sunrise" : pos < 66 ? "desk" : "run";
  return (
    <Modal title={`Review · ${e.mission?.title ?? ""}`} onClose={onClose} wide>
      <div className="review">
        <div className="review-main">
          <button className="player" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)}>
            <Filmstrip kind={scene} frames={1} playing={playing} />
            {!playing && <span className="play">▶</span>}
          </button>
          <input className="scrub" type="range" min={0} max={100} step={0.5} value={pos} aria-label="Position in video" onChange={(v) => setPos(+v.target.value)} />
          <form
            className="comment"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (note.trim()) store.revise(e.id, `At ${Math.floor(pos / 12)}:${String(Math.floor((pos % 12) * 5)).padStart(2, "0")}: ${note}`);
              if (note.trim()) onClose();
            }}
          >
            <input value={note} placeholder="Comment on this moment…" aria-label="Comment" onChange={(v) => setNote(v.target.value)} />
            <button type="submit" disabled={!note.trim()}>
              Ask for changes
            </button>
          </form>
        </div>
        <div className="review-side">
          <h3>Calls {e.name} made</h3>
          {CALLS.map((c) => (
            <div className="call" key={c.at}>
              <button onClick={() => setPos(parseInt(c.at, 10) * 18)}>{c.at}</button>
              <span>{c.text}</span>
            </div>
          ))}
          <div className="versions">
            {Array.from({ length: e.version }, (_, i) => (
              <span key={i} className={i === e.version - 1 ? "on" : ""}>
                V{i + 1}
              </span>
            ))}
          </div>
          <button className="primary full" onClick={() => store.approve(e.id)}>
            Approve and export
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Board({ id, onClose }: { id: BoardId; onClose: () => void }) {
  const [count, setCount] = useState(50);
  if (id === "styles") {
    return (
      <Modal title="Styles" onClose={onClose} wide>
        <p className="lede">Your saved looks and editing styles. Drop in a reference video and Claude learns a new one.</p>
        <div className="board-grid">
          {STYLE_CARDS.map((c) => (
            <article key={c.id} className="card">
              <span className="swatches big">
                {c.swatch.map((v) => (
                  <i key={v} style={{ background: v }} />
                ))}
              </span>
              <b>{c.name}</b>
              <small>{c.mode}</small>
              <p>{c.blurb}</p>
            </article>
          ))}
          <article className="card add">
            <Icon name="film" size={24} color="#7a4a2c" />
            <b>Learn from a reference</b>
            <p>Claude studies the video once. You approve the style.</p>
          </article>
        </div>
      </Modal>
    );
  }
  if (id === "prompts") {
    return (
      <Modal title="Prompt recipes" onClose={onClose}>
        <div className="recipe-list">
          {PROMPT_CARDS.map((p) => (
            <article key={p.title} className="recipe">
              <div>
                <b>{p.title}</b>
                <p>{p.text}</p>
              </div>
              <span>{p.uses} uses</span>
            </article>
          ))}
        </div>
      </Modal>
    );
  }
  if (id === "tools") {
    return (
      <Modal title="Tool shelf" onClose={onClose} wide>
        <p className="lede">These tools run on your Mac and use no Claude allowance.</p>
        <div className="board-grid">
          {TOOLS.map((t) => (
            <article key={t.name} className="card">
              <Icon name={t.icon} size={24} color="#1f8c7f" />
              <b>{t.name}</b>
              <p>{t.note}</p>
              <small>{t.tag}</small>
            </article>
          ))}
        </div>
      </Modal>
    );
  }
  const scenes: Thumb[] = ["run", "desk", "coffee", "sunrise", "city", "climb"];
  return (
    <Modal title="B-roll library" onClose={onClose} wide>
      <div className="import">
        <div>
          <b>12 clips · 96 shots found</b>
          <p>The first 10 shots used about 2% of your session. Choose how many to analyze now.</p>
        </div>
        <div className="import-pick">
          {[25, 50, 96].map((n) => (
            <button key={n} className={count === n ? "on" : ""} onClick={() => setCount(n)}>
              {n === 96 ? "All 96" : n}
            </button>
          ))}
          <span>About {Math.round(count * 0.2)}% of your session</span>
        </div>
      </div>
      <div className="library-grid">
        {scenes.map((s) => (
          <article key={s} className="clip">
            <Filmstrip kind={s} frames={3} playing={false} />
            <span>{s === "run" ? "Discipline, early start" : s === "desk" ? "Hard work, late night" : s === "coffee" ? "Fuel, morning ritual" : s === "sunrise" ? "Hope, new beginning" : s === "city" ? "Solitude, distance" : "Ambition, the summit"}</span>
          </article>
        ))}
      </div>
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
