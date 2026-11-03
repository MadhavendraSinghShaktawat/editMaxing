import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Pencil, Share2, Trash2 } from "lucide-react";
import { Grant, MotionItem, MotionKind, MotionTaxonomy, api, isAdmin } from "../sim/engine";
import { store, useStore } from "../sim/store";
import { ShareEditor, sharedLabel } from "./Share";
import { Badge, Button, Confirm, EmptyState, Group, Meta, Modal, Segmented, Select } from "./ui";

const KINDS: { id: MotionKind; label: string }[] = [
  { id: "animation", label: "Animations" },
  { id: "caption", label: "Captions" },
  { id: "thumbnail", label: "Thumbnails" },
];

/** A poster that plays its loop while the pointer is on it, so a full grid doesn't play at once. */
export function MotionPreview({ item, autoPlay = false }: { item: Pick<MotionItem, "id" | "kind" | "name">; autoPlay?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(autoPlay);
  if (item.kind === "thumbnail") return <img className="mo-media" src={`/api/motion/${item.id}/poster`} alt="" loading="lazy" />;
  return (
    <span className="mo-media" onMouseEnter={() => setLive(true)} onMouseLeave={() => { if (!autoPlay) { ref.current?.pause(); setLive(false); } }}>
      {live ? <video ref={ref} src={`/api/motion/${item.id}/loop`} poster={`/api/motion/${item.id}/poster`} autoPlay loop muted playsInline /> : <img src={`/api/motion/${item.id}/poster`} alt="" loading="lazy" />}
    </span>
  );
}

const pathOf = (v: MotionItem) => [v.operation?.label, v.domain?.label, v.technique?.label].filter(Boolean).join(" → ");

function MotionCard({ v, onOpen }: { v: MotionItem; onOpen: () => void }) {
  return (
    <button type="button" className="mo-card" onClick={onOpen}>
      <MotionPreview item={v} />
      <span className="mo-card-body">
        <b>{v.name}</b>
        <small>{v.kind === "animation" ? pathOf(v) || "Unsorted" : v.styleName ?? "No style"}</small>
        {v.technique?.status === "proposed" && <Badge tone="warn">New technique</Badge>}
      </span>
    </button>
  );
}

/** One saved item: the loop, where it sits in the taxonomy, and the spec the Motion agent rebuilds from. */
function MotionDetail({ v, onBack }: { v: MotionItem; onBack: () => void }) {
  const s = useStore();
  const names = useMemo(() => new Map(s.members.map((m) => [m.id, m.name])), [s.members]);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(v.name);
  const spec = v.card.spec;
  const caption = v.card.captions as Record<string, unknown> | undefined;
  const share = (grants: Grant[]) => void s.attempt(async () => { await api("PUT", `/api/motion/${v.id}/shares`, { grants }); await s.refreshMotion(); setSharing(false); });
  const rename = () => void s.attempt(async () => { await api("PATCH", `/api/motion/${v.id}`, { name }); await s.refreshMotion(); setRenaming(false); });
  const rows: [string, string | undefined][] = spec ? [["Enters", spec.enter], ["While on screen", spec.hold], ["Leaves", spec.exit], ["Easing", spec.easing], ["Stagger", spec.stagger], ["Lands on", spec.sync], ["Type", spec.typography], ["Camera", spec.camera]] : [];
  const captionRows: [string, unknown][] = caption ? [["Font", caption.suggestedFont], ["Feel", caption.fontFeel], ["Words at once", caption.maxWords], ["Reveal", caption.reveal], ["Animation", caption.animation], ["Colour", caption.color], ["Highlight", caption.highlight], ["Height from bottom", typeof caption.position === "number" ? `${Math.round(caption.position * 100)}%` : undefined]] : [];
  return (
    <div className="ui-stack">
      <div className="ui-toolbar">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={onBack}>All</Button>
        <div className="ui-grow" />
        {s.studio.mode === "hub" && v.access === "own" && <Button size="sm" variant="secondary" icon={<Share2 size={13} />} onClick={() => setSharing(!sharing)}>{sharedLabel(v.sharedWith, names)}</Button>}
        {(v.access === "own" || v.access === "edit") && !renaming && <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setRenaming(true)}>Rename</Button>}
        {v.access === "own" && <Confirm icon={<Trash2 size={15} />} label={`Delete ${v.name}`} confirm="Delete" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/motion/${v.id}`); onBack(); })} />}
      </div>
      {sharing && <ShareEditor kind="motion" grants={v.sharedWith} onSave={share} onCancel={() => setSharing(false)} />}
      <div className="mo-detail">
        <MotionPreview item={v} autoPlay />
        <div className="mo-detail-body">
          {renaming ? (
            <form className="ui-inline" onSubmit={(e) => (e.preventDefault(), name.trim() && rename())}>
              <input className="ui-input" autoFocus value={name} aria-label="Name" onChange={(e) => setName(e.target.value)} />
              <Button type="submit" size="sm" variant="primary" icon={<Check size={13} />} disabled={!name.trim()}>Save</Button>
            </form>
          ) : <h3>{v.name}</h3>}
          <p className="mo-path">{v.kind === "animation" ? pathOf(v) : v.kind === "caption" ? "Caption preset" : "Thumbnail"}</p>
          <Meta parts={[v.styleName ? `From ${v.styleName}` : null, v.seconds ? `${v.seconds.toFixed(1)}s` : null, v.layer?.replace(/_/g, " "), v.access !== "own" ? `Shared by ${names.get(v.ownerId) ?? "a colleague"}` : null, v.uses ? `Used ${v.uses}×` : null]} />
          {v.summary && <p className="sd-summary">{v.summary}</p>}
          {!!v.card.meanings?.length && <div className="ui-chips">{v.card.meanings.map((m) => <span key={m} className="ui-chip">{m}</span>)}</div>}
        </div>
      </div>
      {rows.some(([, x]) => x) && (
        <Group title="How it moves">
          {rows.filter(([, x]) => x && x !== "None").map(([k, x]) => <div key={k} className="sd-rule"><small>{k}</small><span>{x}</span></div>)}
        </Group>
      )}
      {!!spec?.rebuild?.length && (
        <Group title="Rebuild steps">
          {spec.rebuild.map((r, i) => <div key={i} className="sd-rule"><span>{i + 1}. {r.replace(/^\d+[.)]\s*/, "")}</span></div>)}
        </Group>
      )}
      {captionRows.some(([, x]) => x !== undefined && x !== "") && (
        <Group title="Caption preset">
          {captionRows.filter(([, x]) => x !== undefined && x !== "").map(([k, x]) => <div key={k} className="sd-rule"><small>{k}</small><span>{String(x)}</span></div>)}
        </Group>
      )}
      {!!v.card.goodFor?.length && (
        <Group title="Good for lines like">
          {v.card.goodFor.map((g) => <div key={g} className="sd-rule"><span>“{g}”</span></div>)}
        </Group>
      )}
    </div>
  );
}

/** New techniques Claude found. Admins approve them or fold them into one that exists. */
function Proposals({ taxonomy, onChange }: { taxonomy: MotionTaxonomy; onChange: () => void }) {
  const s = useStore();
  const [into, setInto] = useState<Record<string, string>>({});
  if (!taxonomy.proposals.length || !isAdmin(s.me)) return null;
  const domain = (id: string | null) => taxonomy.domains.find((d) => d.id === id)?.label ?? "";
  return (
    <Group title="New techniques Claude found">
      {taxonomy.proposals.map((p) => (
        <div key={p.id} className="ui-row mo-proposal">
          <div className="ui-grow">
            <b>{p.label}</b> <small className="t-muted">{domain(p.domain)} · {p.count} saved</small>
            {p.description && <p>{p.description}</p>}
          </div>
          <Select className="sm" label={`Merge ${p.label} into`} value={into[p.id] ?? ""} onChange={(v) => setInto({ ...into, [p.id]: v })}>
            <option value="">Merge into…</option>
            {taxonomy.techniques.filter((t) => t.domain === p.domain).concat(taxonomy.techniques.filter((t) => t.domain !== p.domain)).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
          {into[p.id]
            ? <Button size="sm" variant="secondary" onClick={() => void s.attempt(async () => { await api("POST", `/api/motion/terms/${p.id}/merge`, { into: into[p.id] }); onChange(); })}>Merge</Button>
            : <Button size="sm" variant="primary" onClick={() => void s.attempt(async () => { await api("POST", `/api/motion/terms/${p.id}/approve`); onChange(); })}>Approve</Button>}
        </div>
      ))}
    </Group>
  );
}

export function MotionBoard({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [kind, setKind] = useState<MotionKind>("animation");
  const [operation, setOperation] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [taxonomy, setTaxonomy] = useState<MotionTaxonomy | null>(null);
  const load = () => void store.attempt(async () => setTaxonomy((await api<{ taxonomy: MotionTaxonomy }>("GET", "/api/motion")).taxonomy));
  useEffect(load, [s.motionVersion]);

  const items = s.motion.filter((v) => v.kind === kind && (kind !== "animation" || !operation || v.operation?.id === operation));
  const shown = s.motion.find((v) => v.id === open);
  const ops = taxonomy?.operations.filter((o) => o.count > 0) ?? [];
  return (
    <Modal title="Motion library" description="Animations, caption presets and thumbnails saved from your references, sorted by what they do." onClose={onClose} size="lg">
      {shown ? <MotionDetail key={shown.id} v={shown} onBack={() => setOpen(null)} /> : (
        <div className="ui-stack">
          <div className="ui-toolbar">
            <Segmented label="Kind" value={kind} onChange={(k) => { setKind(k); setOperation(null); }} options={KINDS.map((k) => ({ id: k.id, label: <>{k.label} <small>{s.motion.filter((v) => v.kind === k.id).length}</small></> }))} />
          </div>
          {kind === "animation" && ops.length > 0 && (
            <div className="ui-chips" role="radiogroup" aria-label="What it does">
              <button type="button" role="radio" aria-checked={!operation} className={`ui-chip ${!operation ? "is-on" : ""}`} onClick={() => setOperation(null)}>Everything</button>
              {ops.map((o) => <button key={o.id} type="button" role="radio" aria-checked={operation === o.id} title={o.description} className={`ui-chip ${operation === o.id ? "is-on" : ""}`} onClick={() => setOperation(o.id)}>{o.label}<small>{o.count}</small></button>)}
            </div>
          )}
          {items.length
            ? <div className="mo-grid">{items.map((v) => <MotionCard key={v.id} v={v} onOpen={() => setOpen(v.id)} />)}</div>
            : <EmptyState art="grid" title={s.motion.length ? "Nothing here yet" : "No saved motion yet"} text="Learn a style from a reference video in Styles. Its animations, caption preset and thumbnail are saved here." />}
          {taxonomy && <Proposals taxonomy={taxonomy} onChange={() => { load(); void s.refreshMotion(); }} />}
        </div>
      )}
    </Modal>
  );
}
