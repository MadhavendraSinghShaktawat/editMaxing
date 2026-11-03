import { Moon, Plus, Sun, Sunset } from "lucide-react";
import { useState } from "react";
import { LOOKS, STAGES } from "../sim/data";
import { resetLabel } from "../sim/engine";
import { Editor, MAX_EDITORS, Theme, stateLabel, store, useStore } from "../sim/store";
import { Icon } from "./Icon";
import { Portrait } from "./Pixel";

const fmt = (min: number) => {
  if (min >= 1440) return `${Math.round(min / 1440)}d`;
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

function LifeBar({ label, value, reset, tone, icon }: { label: string; value: number; reset: string; tone: string; icon: string; sub?: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className={`life ${tone} ${value < 0.2 ? "low" : ""}`} title={`${label}: ${pct}% left. Resets in ${reset}.`}>
      <Icon name={icon} size={15} color="var(--tone)" fill="var(--tone)" />
      <div className="life-body">
        <div className="life-row">
          <b>{label}</b>
          <span>{pct}%</span>
        </div>
        <div className="life-track" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <small>Resets in {reset}</small>
      </div>
    </div>
  );
}

const THEMES: { id: Theme; label: string; Icon: typeof Sun }[] = [
  { id: "day", label: "Day", Icon: Sun },
  { id: "evening", label: "Evening", Icon: Sunset },
  { id: "night", label: "Night", Icon: Moon },
];

function ThemeSwitch() {
  const s = useStore();
  const move = (dir: number) => {
    const i = THEMES.findIndex((t) => t.id === s.theme);
    s.setTheme(THEMES[(i + dir + THEMES.length) % THEMES.length].id);
  };
  return (
    <div
      className="theme-switch"
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1);
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1);
      }}
    >
      {THEMES.map(({ id, label, Icon }) => (
        <button key={id} role="radio" aria-checked={s.theme === id} aria-label={label} title={label} tabIndex={s.theme === id ? 0 : -1} className={s.theme === id ? "on" : ""} onClick={() => s.setTheme(id)}>
          <Icon size={15} strokeWidth={2.2} />
        </button>
      ))}
    </div>
  );
}

export function TopBar({ onAccounts }: { onAccounts: () => void }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const account = s.live ? s.activeAccount() : null;
  const limits = account?.limits ?? [];
  const model = limits.filter((l) => l.kind === "model");
  const reset = (min: number) => (s.live ? (min ? fmt(min) : "unknown") : fmt(min));
  return (
    <header className="topbar glass">
      <div className="brand">
        <b>Shifu Dojo</b>
      </div>

      {s.live && !limits.length ? (
        <div className="lifebars none">{!s.online ? "Connecting to the engine…" : account?.kind === "api_key" ? "This account is billed by API usage" : account?.signedIn === false ? "Sign in to a Claude account to start" : "Reading your limits…"}</div>
      ) : (
        <div className="lifebars">
          <LifeBar label="5-hour session" value={s.usage.session} reset={reset(s.usage.sessionResetMin)} tone="green" icon="heart" />
          <LifeBar label="Weekly" value={s.usage.weekly} reset={reset(s.usage.weeklyResetMin)} tone="blue" icon="bolt" />
          {s.live ? model.map((m) => <LifeBar key={m.id} label={m.label} value={1 - m.usedPercent / 100} reset={resetLabel(m.resetsAt)} tone="gold" icon="star" />) : <LifeBar label="Fable" value={s.usage.fable} reset={fmt(s.usage.fableResetMin)} tone="gold" icon="star" />}
        </div>
      )}

      <ThemeSwitch />

      <div className="account">
        <button className="account-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`dot ${account?.signedIn === false ? "off" : ""}`} /> {account?.label ?? "Maddy"} <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="account-menu glass" role="menu">
            {s.accounts.map((a) => (
              <button
                key={a.id}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  s.useAccount(a.id);
                }}
              >
                <span className={`dot ${a.signedIn ? "" : "off"}`} /> {a.label}
                {a.plan ? ` · ${a.plan}` : ""}
                {a.limits[0] ? ` · ${Math.round(a.limits[0].usedPercent)}% used` : ""}
              </button>
            ))}
            <button
              role="menuitem"
              className="muted"
              onClick={() => {
                setOpen(false);
                onAccounts();
              }}
            >
              Manage accounts
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function CrewRow({ e }: { e: Editor }) {
  const s = store;
  const stage = STAGES[e.stage];
  const review = !!e.mission && stage.id === "review";
  const needs = e.activity === "needs" || review;
  const pct = Math.round(e.overall * 100);
  const C = 2 * Math.PI * 25;
  return (
    <button className={`crew-row ${s.selectedId === e.id ? "on" : ""} ${needs ? "needs" : ""}`} aria-label={`${e.name}: ${review ? "ready for review" : stateLabel[e.activity]}`} onClick={() => s.select(s.selectedId === e.id ? null : e.id)}>
      <span className="crew-face">
        <Portrait editor={e} scale={2} />
        <svg viewBox="0 0 54 54" aria-hidden="true">
          <circle cx="27" cy="27" r="25" className="ring-bg" />
          {e.mission && <circle cx="27" cy="27" r="25" className="ring" strokeDasharray={`${(pct / 100) * C} ${C}`} style={{ stroke: LOOKS[e.look].shirt }} />}
        </svg>
        <i className={`crew-dot ${e.activity}`} />
      </span>
      <span className="crew-card">
        <span className="crew-top">
          <b>{e.name}</b>
          <em className={`state ${e.activity}`}>{review ? "Review" : stateLabel[e.activity]}</em>
        </span>
        <span className="crew-mission">{e.mission?.title ?? "Free for a new video"}</span>
        <span className="crew-detail">{e.mission ? `${stage.label} · ${pct}%` : e.detail}</span>
      </span>
    </button>
  );
}

export function Crew() {
  const s = useStore();
  return (
    <aside className="crew" aria-label="Crew">
      {s.editors.map((e) => (
        <CrewRow key={e.id} e={e} />
      ))}
      {s.editors.length > 0 && s.editors.length < MAX_EDITORS && (
        <button className="crew-add glass" aria-label="New chat" title="New chat" onClick={() => s.newChat()}>
          <Plus size={20} />
        </button>
      )}
    </aside>
  );
}

export function EmptyStudio() {
  const s = useStore();
  if (s.editors.length) return null;
  return (
    <div className="empty-studio glass">
      <b>Your studio is quiet</b>
      <span>Start a chat and an editor will arrive to help.</span>
    </div>
  );
}

export type BoardId = "styles" | "motion" | "prompts" | "library" | "tools" | "settings";

export function Dock({ onBoard, onVideo }: { onBoard: (b: BoardId) => void; onVideo: () => void }) {
  const s = useStore();
  const items: { id: BoardId; label: string; icon: string }[] = [
    { id: "styles", label: "Styles", icon: "pen" },
    { id: "motion", label: "Motion", icon: "wand" },
    { id: "prompts", label: "Prompts", icon: "text" },
    { id: "library", label: "B-roll", icon: "book" },
    { id: "tools", label: "Tools", icon: "sparkles" },
    { id: "settings", label: "Settings", icon: "gear" },
  ];
  const queue = s.needsYou();
  return (
    <nav className="dock glass" aria-label="Studio">
      <button className="mission-btn" disabled={s.editors.length >= MAX_EDITORS} onClick={onVideo}>
        <Plus size={17} strokeWidth={2.4} />
        New video
      </button>
      {items.map((it) => (
        <button key={it.id} className="dock-btn" onClick={() => onBoard(it.id)}>
          <Icon name={it.icon} size={16} />
          {it.label}
        </button>
      ))}
      <button
        className={`needs-btn ${queue.length ? "active" : ""}`}
        disabled={!queue.length}
        onClick={() => queue[0] && s.select(queue[0].id)}
      >
        <Icon name="alert" size={16} />
        {queue.length ? `${queue.length} needs you` : "All clear"}
      </button>
    </nav>
  );
}
