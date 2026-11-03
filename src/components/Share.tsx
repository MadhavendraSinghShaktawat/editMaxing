import { useState } from "react";
import { Users } from "lucide-react";
import { Grant } from "../sim/engine";
import { useStore } from "../sim/store";
import { Avatar, Button, Select } from "./ui";

type Permission = Grant["permission"];

/**
 * Who something is shared with. Private by default; the whole team, or chosen colleagues.
 * The list is sent whole, so what's shown is exactly what's stored.
 */
export function ShareEditor({ kind, grants, onSave, onCancel }: { kind: "library" | "style" | "motion"; grants: Grant[]; onSave: (grants: Grant[]) => void; onCancel: () => void }) {
  const s = useStore();
  const levels: { id: Permission; label: string }[] = kind === "library" ? [{ id: "use", label: "Can use" }, { id: "add", label: "Can add" }] : [{ id: "use", label: "Can use" }, { id: "edit", label: "Can edit" }];
  const [list, setList] = useState<Grant[]>(grants);
  const team = list.find((g) => g.grantee === "team");
  const people = s.members.filter((m) => m.id !== s.me?.id);
  const set = (grantee: string, permission: Permission | null) => setList((l) => [...l.filter((g) => g.grantee !== grantee), ...(permission ? [{ grantee, permission }] : [])]);
  const sort = (g: Grant[]) => JSON.stringify([...g].sort((a, b) => a.grantee.localeCompare(b.grantee)));
  const changed = sort(list) !== sort(grants);
  const picker = (grantee: string, who: string, value: string) => (
    <Select className="sm" label={`Access for ${who}`} value={value} onChange={(v) => set(grantee, (v || null) as Permission | null)}>
      <option value="">No access</option>
      {levels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
    </Select>
  );
  return (
    <div className="ui-row is-stack share-panel ui-pop">
      <div className="ui-share">
        <div className="ui-row">
          <span className="ui-avatar" style={{ background: "var(--well-2)", color: "var(--text-2)" }} aria-hidden><Users size={16} /></span>
          <span className="ui-row-title" style={{ flex: 1 }}>Everyone</span>
          {picker("team", "everyone", team?.permission ?? "")}
        </div>
        {people.map((m) => (
          <div key={m.id} className="ui-row">
            <Avatar name={m.name} />
            <span className="ui-row-title" style={{ flex: 1 }}>{m.name}</span>
            {picker(m.id, m.name, list.find((g) => g.grantee === m.id)?.permission ?? "")}
          </div>
        ))}
      </div>
      {!people.length && <span className="ui-row-meta">No one else has joined yet.</span>}
      <div className="ui-share-foot">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!changed} onClick={() => onSave(list)}>Save</Button>
      </div>
    </div>
  );
}

/** A short line saying who can see something. */
export function sharedLabel(grants: Grant[] | undefined, names: Map<string, string>) {
  if (!grants?.length) return "Private";
  if (grants.some((g) => g.grantee === "team")) return "Everyone";
  const who = grants.map((g) => names.get(g.grantee) ?? "Someone");
  return `${who.slice(0, 2).join(", ")}${who.length > 2 ? ` +${who.length - 2}` : ""}`;
}
