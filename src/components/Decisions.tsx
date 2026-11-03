import { useState } from "react";
import { EngineDecision } from "../sim/engine";
import { store } from "../sim/store";
import { MotionPreview } from "./Motion";

type Option = { label: string; detail?: string; description?: string; shotId?: string; animationId?: string; technique?: string | null; summary?: string; seconds?: number };
type Question = { question: string; header?: string; options: Option[]; multiSelect?: boolean };

/** Claude's AskUserQuestion: one or more questions, answered together. */
function QuestionCard({ d }: { d: EngineDecision }) {
  const questions = (d.payload.questions ?? []) as Question[];
  const [picks, setPicks] = useState<Record<string, string>>({});
  const set = (q: Question, label: string) => {
    const next = { ...picks, [q.question]: label };
    setPicks(next);
    if (questions.every((v) => next[v.question])) store.answer(d.id, { answers: next });
  };
  return (
    <div className="decision">
      {questions.map((q) => (
        <div key={q.question} className="decision-q">
          <div className="decision-head">
            <span>{q.header ?? "Your call"}</span>
            <p>{q.question}</p>
          </div>
          <div className="decision-list">
            {q.options.map((o) => (
              <button key={o.label} className={picks[q.question] === o.label ? "chosen" : ""} onClick={() => set(q, o.label)}>
                <b>{o.label}</b>
                {o.description && <small>{o.description}</small>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ChoiceCard({ d, editorName }: { d: EngineDecision; editorName: string }) {
  const { question, line, options } = d.payload as { question: string; line?: string; options: Option[] };
  const broll = d.kind === "broll";
  const motion = d.kind === "motion";
  return (
    <div className="decision">
      <div className="decision-head">
        <span>{broll ? "Pick a B-roll" : motion ? "Pick an animation" : "Your call"}</span>
        {line ? <q>{line}</q> : <p>{question}</p>}
      </div>
      <div className={broll || motion ? "decision-options real" : "decision-list"}>
        {options.map((o) => (
          <button key={o.label} onClick={() => store.answer(d.id, { label: o.label, shotId: o.shotId, animationId: o.animationId })}>
            {o.shotId && <img src={`/api/library/shots/${o.shotId}/filmstrip`} alt="" />}
            {o.animationId && <MotionPreview item={{ id: o.animationId, kind: "animation", name: o.label }} autoPlay />}
            <b>{o.label}</b>
            {o.technique && <small className="t-accent">{o.technique}</small>}
            {(o.detail ?? o.summary) && <small>{o.detail ?? o.summary}</small>}
          </button>
        ))}
      </div>
      <div className="decision-more">
        <button onClick={() => store.answer(d.id, { label: "None of these", note: "The user rejected every option." })}>None of these</button>
        <button onClick={() => store.answer(d.id, null)}>Let {editorName} choose</button>
      </div>
    </div>
  );
}

type About = { action: string; command: string | null; urls: string[]; files: string[]; download: boolean; who: string; subject: string | null; footage?: boolean };

const MEDIA = /\.(mp4|mov|m4v|webm|mp3|wav|m4a|jpe?g|png|gif|webp)(\?|$)/i;
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** A download's file, shown before it's allowed, when it's a picture, a video or a sound. */
function MediaPreview({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  if (broken || !MEDIA.test(url)) return null;
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return <img className="perm-media" src={url} alt="" onError={() => setBroken(true)} />;
  if (/\.(mp3|wav|m4a)(\?|$)/i.test(url)) return <audio className="perm-media" src={url} controls preload="none" onError={() => setBroken(true)} />;
  return <video className="perm-media" src={url} controls preload="metadata" muted onError={() => setBroken(true)} />;
}

/**
 * An approval says who is asking, what will happen in plain words, why it needs a yes, and
 * exactly what it touches: the web addresses (with a preview for media), the files, the command.
 */
function PermissionCard({ d }: { d: EngineDecision }) {
  const { tool, reason, about, input } = d.payload as { tool: string; reason?: string; about?: About; input?: Record<string, unknown> };
  const a: About = about ?? { action: tool === "Bash" ? String(input?.description ?? "Run a command on this Mac") : `Use ${tool}`, command: tool === "Bash" ? String(input?.command ?? "") : null, urls: [], files: [], download: false, who: "The editor", subject: null };
  return (
    <div className="decision perm">
      <div className="decision-head">
        <span>{a.who} needs your OK</span>
        <p className="perm-action">{a.action}</p>
        {reason && <small className="perm-why">Asking because it {reason}.</small>}
      </div>
      {a.urls.length > 0 && (
        <div className="perm-list">
          <small>{a.download ? "Downloads from" : "Connects to"}</small>
          {a.urls.map((u) => (
            <div key={u} className="perm-url">
              <a href={u} target="_blank" rel="noreferrer noopener">{host(u)}</a>
              <code title={u}>{u}</code>
              <MediaPreview url={u} />
            </div>
          ))}
        </div>
      )}
      {a.files.length > 0 && (
        <div className="perm-list">
          <small>Files</small>
          {a.files.map((f) => <code key={f} title={f}>{f.split("/").slice(-3).join("/")}</code>)}
        </div>
      )}
      {a.command && (
        <details className="perm-command">
          <summary>{tool === "Bash" ? "Show the exact command" : "Show the details"}</summary>
          <pre>{a.command}</pre>
        </details>
      )}
      <div className="decision-more strong">
        <button className="primary" onClick={() => store.answer(d.id, { allow: true })}>Allow once</button>
        {a.subject && <button onClick={() => store.answer(d.id, { allow: true, always: true })}>Always allow {a.subject} in this chat</button>}
        {!a.footage && <button onClick={() => store.answer(d.id, { allow: true, all: true })}>Allow everything in this chat</button>}
        <button onClick={() => store.answer(d.id, { allow: false })}>Don't allow</button>
      </div>
      <small className="perm-foot">{a.footage ? "Changes to your original footage always ask." : "To stop these for every chat, turn off Ask before risky steps in Settings → Account."}</small>
    </div>
  );
}

export function DecisionCards({ list, editorName }: { list: EngineDecision[]; editorName: string }) {
  return (
    <>
      {list.map((d) => (d.kind === "question" ? <QuestionCard key={d.id} d={d} /> : d.kind === "permission" ? <PermissionCard key={d.id} d={d} /> : <ChoiceCard key={d.id} d={d} editorName={editorName} />))}
    </>
  );
}
