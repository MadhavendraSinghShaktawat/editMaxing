import { useRef, useState } from "react";
import { ArrowRight, CircleAlert, Minimize2 } from "lucide-react";
import { ContextUsage } from "../sim/engine";
import { Message } from "../sim/store";

/**
 * Context compaction, the way T3 Code does it: a context-window meter beside Send with a
 * "Compact context" action, a divider in the chat for each compaction, and a Compact chip
 * when a large chat comes back after Claude's prompt cache has expired.
 */

/** Context size below which compaction isn't suggested, matching Claude Code's 200K default. */
export const COMPACTION_SUGGESTION_MIN_TOKENS = 200_000;
/** Claude's prompt cache lasts about an hour on a subscription (plus slack) and 5 minutes with an API key. */
const CACHE_TTL_MS = { subscription: 70 * 60_000, api_key: 5 * 60_000 } as const;

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 999_500) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

export function formatContextWindowCompactionMessage(modelDisplayName: string | null | undefined, autoCompactThreshold?: number | null) {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  return modelDisplayName ? `Context for ${modelDisplayName} compacts automatically when needed.` : "Context compacts automatically when needed.";
}

/** A large chat whose prompt cache has expired: sending it again would re-read the whole history. */
export function shouldOfferResumeCompaction(usage: ContextUsage | null | undefined, accountKind: "subscription" | "api_key" | undefined, now = Date.now()) {
  if (!usage || usage.usedTokens < COMPACTION_SUGGESTION_MIN_TOKENS) return false;
  return now - usage.updatedAt >= CACHE_TTL_MS[accountKind ?? "subscription"];
}

const usedPercentOf = (u: ContextUsage) => (u.maxTokens ? Math.min(100, (u.usedTokens / u.maxTokens) * 100) : u.percentage);

export function ContextWindowMeter({ usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason }: { usage: ContextUsage; modelDisplayName?: string | null; onCompact?: () => void; compactDisabled?: boolean; compactDisabledReason?: string | null }) {
  const [open, setOpen] = useState(false);
  const close = useRef<number>(0);
  const percent = usedPercentOf(usage);
  const used = formatPercentage(percent);
  const normalized = Math.max(0, Math.min(100, percent ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const overloaded = normalized > 90;
  const color = overloaded ? "var(--bad, #e5484d)" : "color-mix(in oklab, var(--text-2, #999) 72%, transparent)";
  const show = () => (window.clearTimeout(close.current), setOpen(true));
  const hide = () => (close.current = window.setTimeout(() => setOpen(false), onCompact ? 150 : 0));
  return (
    <span className="ctx-meter" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button
        type="button"
        className="ctx-meter-ring"
        aria-label={usage.maxTokens !== null && used ? `Context window ${used} used` : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r={radius} fill="none" className="track" strokeWidth="3" />
          <circle cx="12" cy="12" r={radius} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - normalized / 100)} className="value" />
        </svg>
      </button>
      {open && (
        <div className="ctx-meter-pop" role="dialog" aria-label="Context window">
          <div className="ctx-meter-head">
            <span>Context Window</span>
            {usage.maxTokens !== null && used ? (
              <span className="num">{used}<i>·</i>{formatContextWindowTokens(usage.usedTokens)}/{formatContextWindowTokens(usage.maxTokens)}</span>
            ) : <span className="num">{formatContextWindowTokens(usage.usedTokens)}</span>}
          </div>
          {usage.maxTokens !== null && (
            <div className="ctx-meter-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(normalized)} aria-label="Context window usage">
              <i style={{ width: `${normalized}%`, background: color }} />
            </div>
          )}
          {usage.compactsAutomatically && <p>{formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}</p>}
          {onCompact && (
            <>
              <button type="button" className="ctx-meter-compact" disabled={compactDisabled} onClick={() => (setOpen(false), onCompact())}>
                <Minimize2 size={13} aria-hidden="true" /> Compact context
              </button>
              {compactDisabled && compactDisabledReason && <p>{compactDisabledReason}</p>}
            </>
          )}
        </div>
      )}
    </span>
  );
}

/** One compaction in the chat: a divider that shimmers while it runs, then shows the tokens before and after. */
export function ContextCompactionRow({ m }: { m: Message & { compaction: NonNullable<Message["compaction"]> } }) {
  const c = m.compaction;
  const failed = c.status === "failed";
  const counts = c.status === "done" && c.before !== undefined && c.after !== undefined ? { before: formatContextWindowTokens(c.before), after: formatContextWindowTokens(c.after) } : null;
  const label = failed ? "Context compaction failed" : c.status === "running" ? "Compacting context" : counts ? `Context compacted ${counts.before} → ${counts.after} tokens` : "Context compacted";
  return (
    <div role="separator" aria-label={c.error ? `${label}: ${c.error}` : label} className={`ctx-row ${failed ? "bad" : ""} ${c.status === "running" ? "active" : ""}`}>
      <span className="line" />
      <span className="ctx-row-text">
        {failed ? <CircleAlert size={12} aria-hidden="true" /> : <Minimize2 size={12} aria-hidden="true" />}
        {counts ? <>Context compacted {counts.before}<ArrowRight size={12} aria-hidden="true" />{counts.after} tokens</> : label}
        {c.error && <span className="why">· {c.error}</span>}
      </span>
      <span className="line" />
    </div>
  );
}

/** Beside Send when a large chat comes back after the cache expired. On: compact first. Off: keep everything. */
export function CompactChip({ tokens, keep, onToggle, disabled }: { tokens: number; keep: boolean; onToggle: () => void; disabled?: boolean }) {
  const n = formatContextWindowTokens(tokens);
  return (
    <button
      type="button"
      className="ctx-chip"
      aria-pressed={!keep}
      aria-label={`Compact ${n} tokens of history before sending`}
      title={`${keep ? `Next send keeps all ${n} tokens.` : `Next send compacts ${n} tokens first.`}\n${keep ? "Click to compact first" : "Click to keep full history"}`}
      disabled={disabled}
      onClick={onToggle}
    >
      <Minimize2 size={14} aria-hidden="true" />
      <span>{keep ? "Keep" : "Compact"}</span>
      <span className="n">{n}</span>
    </button>
  );
}
