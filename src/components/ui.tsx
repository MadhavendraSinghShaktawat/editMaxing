import { ButtonHTMLAttributes, ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";

/* A small set of building blocks so every modal and settings page looks and behaves the same. */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

type ModalProps = {
  title?: string;
  description?: ReactNode;
  onClose: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: ReactNode;
  children: ReactNode;
  /** Settings draws its own header and sidebar. */
  bare?: boolean;
  label?: string;
};

/**
 * A dialog that animates in and out, traps focus, closes on Escape or a click outside,
 * and gives focus back to whatever opened it.
 */
export function Modal({ title, description, onClose, size = "md", footer, children, bare, label }: ModalProps) {
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const close = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 140);
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("[autofocus]") ?? panel.current;
    first?.focus({ preventScroll: true });
    return () => opener?.focus?.({ preventScroll: true });
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const [a, b] = [items[0], items[items.length - 1]];
      if (e.shiftKey && (document.activeElement === a || document.activeElement === panel.current)) {
        e.preventDefault();
        b.focus();
      } else if (!e.shiftKey && document.activeElement === b) {
        e.preventDefault();
        a.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [close]);

  return (
    <div className={`ui-scrim ${closing ? "is-closing" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section
        ref={panel}
        tabIndex={-1}
        className={`ui-modal size-${size} ${bare ? "is-bare" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : label}
      >
        {!bare && (
          <header className="ui-modal-head">
            <div>
              {title && <h2 id={titleId}>{title}</h2>}
              {description && <p>{description}</p>}
            </div>
            <IconButton label="Close" onClick={close}><X size={18} /></IconButton>
          </header>
        )}
        {bare && <IconButton className="ui-modal-x" label="Close" onClick={close}><X size={18} /></IconButton>}
        <div className="ui-modal-body">{children}</div>
        {footer && <footer className="ui-modal-foot">{footer}</footer>}
      </section>
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "light";
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", icon, loading, children, className = "", disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`ui-btn v-${variant} ${size} ${loading ? "is-loading" : ""} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Loader2 className="ui-spin" size={size === "sm" ? 13 : 15} /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ label, children, className = "", tone, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: "danger" }) {
  return (
    <button type="button" className={`ui-icon-btn ${tone ?? ""} ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/** A real button that opens the file picker, so it works from the keyboard too. */
export function FileButton({ accept, multiple, onFiles, children, ...rest }: Omit<ButtonProps, "onClick"> & { accept?: string; multiple?: boolean; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button {...rest} onClick={() => input.current?.click()}>{children}</Button>
      <input ref={input} type="file" hidden accept={accept} multiple={multiple} onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = ""; }} />
    </>
  );
}

type DropzoneProps = {
  icon: ReactNode;
  title: string;
  action?: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  compact?: boolean;
  disabled?: boolean;
  children?: ReactNode;
};

/** Drop files here, or click (or press Enter) to browse. */
export function Dropzone({ icon, title, action = "Click to browse", accept, multiple, onFiles, compact, disabled, children }: DropzoneProps) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const open = () => !disabled && input.current?.click();
  const accepts = (f: File) => !accept || accept.split(",").some((a) => (a.endsWith("/*") ? f.type.startsWith(a.slice(0, -1)) : f.type === a || f.name.toLowerCase().endsWith(a)));
  return (
    <div
      className={`ui-drop ${over ? "is-over" : ""} ${compact ? "is-compact" : ""} ${disabled ? "is-disabled" : ""}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={open}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        const files = [...e.dataTransfer.files].filter(accepts);
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
    >
      {children ?? (
        <>
          <span className="ui-drop-art" aria-hidden>{icon}</span>
          <span className="ui-drop-title">{title}</span>
          <span className="ui-drop-action">{action}</span>
        </>
      )}
      <input ref={input} type="file" hidden accept={accept} multiple={multiple} onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = ""; }} />
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad" | "accent"; children: ReactNode }) {
  return <span className={`ui-badge ${tone}`}>{children}</span>;
}

/** A bordered row: an icon tile, a title, one line of detail and actions on the right. */
export function Item({ icon, title, meta, actions, onClick, selected, children }: { icon?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode; onClick?: () => void; selected?: boolean; children?: ReactNode }) {
  const body = (
    <>
      {icon && <span className="ui-item-icon">{icon}</span>}
      <span className="ui-item-text">
        <span className="ui-item-title">{title}</span>
        {meta && <span className="ui-item-meta">{meta}</span>}
      </span>
    </>
  );
  return (
    <div className={`ui-item ${onClick ? "is-link" : ""} ${selected ? "is-on" : ""}`}>
      {onClick ? <button type="button" className="ui-item-main" onClick={onClick}>{body}</button> : <div className="ui-item-main">{body}</div>}
      {actions && <div className="ui-item-actions">{actions}</div>}
      {children && <div className="ui-item-extra">{children}</div>}
    </div>
  );
}

/** One line of meta, joined with dots. Falsy parts are dropped. */
export function Meta({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  return <>{shown.map((p, i) => <span key={i}>{i > 0 && <i className="ui-sep" aria-hidden>•</i>}{p}</span>)}</>;
}

/** A titled card of setting rows. */
export function Group({ title, action, children }: { title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ui-group">
      {(title || action) && (
        <div className="ui-group-head">
          {title && <h3>{title}</h3>}
          {action}
        </div>
      )}
      <div className="ui-group-card">{children}</div>
    </section>
  );
}

export function SettingRow({ title, meta, children, stack }: { title: ReactNode; meta?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`ui-row ${stack ? "is-stack" : ""}`}>
      <div className="ui-row-text">
        <span className="ui-row-title">{title}</span>
        {meta && <span className="ui-row-meta">{meta}</span>}
      </div>
      {children && <div className="ui-row-control">{children}</div>}
    </div>
  );
}

type Art = "list" | "grid" | "people";

/** An empty state with a faded preview of what will appear here. */
export function EmptyState({ title, text, action, art = "list", compact }: { title: string; text?: string; action?: ReactNode; art?: Art; compact?: boolean }) {
  return (
    <div className={`ui-empty ${compact ? "is-compact" : ""}`}>
      {!compact && (
        <div className={`ui-empty-art ${art}`} aria-hidden>
          {[0, 1, 2].map((i) => <span key={i}><i /><b /><em /></span>)}
        </div>
      )}
      <b>{title}</b>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function Field({ label, hint, children, optional }: { label: string; hint?: ReactNode; children: ReactNode; optional?: boolean }) {
  return (
    <label className="ui-field">
      <span className="ui-field-label">{label}{optional && <em>Optional</em>}</span>
      {children}
      {hint && <span className="ui-field-hint">{hint}</span>}
    </label>
  );
}

export function Select({ value, onChange, children, label, className = "", disabled }: { value: string; onChange: (v: string) => void; children: ReactNode; label: string; className?: string; disabled?: boolean }) {
  return (
    <span className={`ui-select ${className}`}>
      <select value={value} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{children}</select>
      <ChevronDown size={14} aria-hidden />
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ui-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? "is-on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, tone }: { value: number; tone?: "ok" | "warn" | "bad" }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <span className={`ui-progress ${tone ?? ""}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Two clicks for anything that can't be undone. The Mac app's web view has no confirm dialog. */
export function Confirm({ children, confirm, onConfirm, icon, size = "sm", label }: { children?: ReactNode; confirm: string; onConfirm: () => void; icon?: ReactNode; size?: "sm" | "md"; label?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  if (armed) return <Button variant="danger" size={size} className="ui-pop" autoFocus onClick={() => (setArmed(false), onConfirm())}>{confirm}</Button>;
  if (!children && icon) return <IconButton label={label ?? confirm} onClick={() => setArmed(true)}>{icon}</IconButton>;
  return <Button variant="ghost" size={size} icon={icon} onClick={() => setArmed(true)}>{children}</Button>;
}

/** Copies text and briefly says so. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); });
  return { copied, copy };
}

/** A steady colour per person, so the same teammate always looks the same. */
export function Avatar({ name, size }: { name: string; size?: "sm" | "lg" }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className={`ui-avatar ${size ?? ""}`} style={{ background: `linear-gradient(160deg, hsl(${h} 70% 62%), hsl(${(h + 28) % 360} 62% 46%))` }} aria-hidden>
      {name.trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}
