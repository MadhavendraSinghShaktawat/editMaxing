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

function PermissionCard({ d }: { d: EngineDecision }) {
  const { tool, reason } = d.payload as { tool: string; reason?: string };
  return (
    <div className="decision">
      <div className="decision-head">
        <span>Needs your approval</span>
        <p>This step {reason ?? `uses ${tool}`}.</p>
      </div>
      <div className="decision-more strong">
        <button className="primary" onClick={() => store.answer(d.id, { allow: true })}>Allow once</button>
        <button onClick={() => store.answer(d.id, { allow: true, always: true })}>Allow for this chat</button>
        <button onClick={() => store.answer(d.id, { allow: false })}>Don't allow</button>
      </div>
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
