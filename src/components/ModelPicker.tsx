import { Check, ChevronDown, Flame, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { modelOptions } from "../sim/data";
import { useStore } from "../sim/store";

export function ModelPicker({ model, effort, onChange, up = true, accountId }: { model: string; effort: string; onChange: (model: string, effort: string) => void; up?: boolean; accountId?: string }) {
  const s = useStore();
  const MODELS = useMemo(() => modelOptions(s.live ? s.modelsFor(accountId) : []), [s, s.accounts, accountId]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const current = MODELS.find((m) => m.id === model) ?? MODELS.find((m) => m.id === "sonnet") ?? MODELS[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const list = useMemo(() => {
    const q = query.toLowerCase();
    return MODELS.filter((m) => m.name.toLowerCase().includes(q) || m.id.includes(q) || m.note.toLowerCase().includes(q));
  }, [query, MODELS]);

  const pick = (id: string) => {
    const next = MODELS.find((m) => m.id === id)!;
    onChange(id, next.efforts.includes(effort) ? effort : next.defaultEffort);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="model-picker" ref={root}>
      <button type="button" className="model-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {current.usesFable && <Flame size={13} color="#e88a1d" />}
        <b>{current.name}</b>
        {effort && <span>{effort}</span>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className={`model-pop ${up ? "up" : "down"}`} role="dialog" aria-label="Choose a model">
          <label className="model-search">
            <Search size={14} />
            <input autoFocus value={query} placeholder="Search models" aria-label="Search models" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="model-list">
            {(["Recommended", "Older versions"] as const).map((group) => {
              const rows = list.filter((m) => m.group === group);
              if (!rows.length) return null;
              return (
                <div key={group}>
                  <h4>{group}</h4>
                  {rows.map((m) => (
                    <button key={m.id} type="button" className={m.id === model ? "on" : ""} onClick={() => pick(m.id)}>
                      <span>
                        <b>
                          {m.name} {m.usesFable && <Flame size={12} color="#e88a1d" />}
                        </b>
                        <small>{m.note}</small>
                      </span>
                      {m.id === model && <Check size={15} />}
                    </button>
                  ))}
                </div>
              );
            })}
            {!list.length && <p className="model-empty">No models match.</p>}
          </div>
          {current.efforts.length > 0 && (
            <div className="effort">
              <span>Effort</span>
              <div role="radiogroup" aria-label="Effort">
                {current.efforts.map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={v === effort} className={v === effort ? "on" : ""} onClick={() => onChange(model, v)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="model-hint">{current.usesFable ? "This chat will use your separate Fable allowance." : "Saved for this chat, and used next time you start a video."}</p>
        </div>
      )}
    </div>
  );
}
