import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { ArrowLeft, Brain, Check, Copy, Download, ExternalLink, Eye, Fingerprint, HardDrive, Laptop, Link2, LogOut, Monitor, Plug, Plus, Server, Share2, Trash2, UserRound, Users, Wifi } from "lucide-react";
import { Account, Client, EngineStyle, Grant, LibraryView, MemoryRule, MemoryScope, MotionItem, Role, StudioMode, api, isAdmin } from "../sim/engine";
import { store, useStore } from "../sim/store";
import { PackButton } from "./Modals";
import { ShareEditor, sharedLabel } from "./Share";
import { Avatar, Badge, Button, Confirm, EmptyState, FileButton, Group, IconButton, Item, Meta, Select, SettingRow, useCopy } from "./ui";

type Section = "account" | "memory" | "sharing" | "mode" | "integrations" | "team" | "users" | "mac";

const AREA_LABELS: Record<string, string> = {
  general: "General", pacing: "Pacing", editing: "Editing", audio: "Audio", captions: "Captions", positioning: "Positioning",
  motion: "Motion", animation: "Animation", effects: "Effects", broll: "B-roll",
};
const ROLE: Record<Role, string> = { owner: "Owner", admin: "Admin", editor: "Editor" };
const STATUS: Record<string, { label: string; tone: "accent" | "warn" | "neutral" | "ok" } | undefined> = {
  suggested: { label: "Suggested", tone: "accent" }, needs_review: { label: "Check", tone: "warn" }, stale: { label: "Paused", tone: "neutral" },
};

const when = (t: number | null | undefined) => (t ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never");
const ago = (t: number | null | undefined) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return when(t);
};

function Page({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="st-page">
      <header>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </header>
      {children}
    </div>
  );
}

const None = ({ text }: { text: string }) => <SettingRow title={<span className="t-muted">{text}</span>} />;

export function SettingsBoard() {
  const s = useStore();
  const hub = s.studio.mode === "hub";
  const admin = isAdmin(s.me);
  const [section, setSection] = useState<Section>("account");
  const groups: { label?: string; items: { id: Section; label: string; icon: ReactNode; show: boolean }[] }[] = [
    {
      items: [
        { id: "account", label: "Account", icon: <UserRound size={16} />, show: true },
        { id: "memory", label: "Memory", icon: <Brain size={16} />, show: true },
        { id: "sharing", label: "Sharing", icon: <Share2 size={16} />, show: true },
      ],
    },
    {
      label: "Studio",
      items: [
        { id: "mode", label: "Studio mode", icon: <Server size={16} />, show: true },
        { id: "integrations", label: "Integrations", icon: <Plug size={16} />, show: true },
        { id: "team", label: "Team", icon: <Users size={16} />, show: hub && admin },
        { id: "users", label: "Users", icon: <Eye size={16} />, show: hub && admin },
        { id: "mac", label: "This Mac", icon: <Laptop size={16} />, show: true },
      ],
    },
  ];
  const suggested = s.memory.some((m) => m.status === "suggested");
  return (
    <div className="st">
      <nav className="st-nav" aria-label="Settings">
        <h2>Settings</h2>
        {groups.map((g, i) => (
          <div key={i} style={{ display: "contents" }}>
            {g.label && <small>{g.label}</small>}
            {g.items.filter((x) => x.show).map((x) => (
              <button key={x.id} type="button" className={section === x.id ? "is-on" : ""} aria-current={section === x.id ? "page" : undefined} onClick={() => setSection(x.id)}>
                {x.icon}
                {x.label}
                {x.id === "memory" && suggested && <i className="st-dot" aria-label="Suggestions waiting" />}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="st-main">
        {section === "account" && <MyAccount key="account" />}
        {section === "mode" && <StudioModeSection key="mode" />}
        {section === "memory" && <MemorySection key="memory" />}
        {section === "sharing" && <SharingSection key="sharing" go={setSection} />}
        {section === "integrations" && <IntegrationsSection key="integrations" />}
        {section === "team" && <TeamSection key="team" go={setSection} />}
        {section === "users" && <UsersSection key="users" />}
        {section === "mac" && <ThisMac key="mac" />}
      </div>
    </div>
  );
}

// ── Account ────────────────────────────────────────────────────

type MeDetail = { id: string; name: string; role: Role; local: boolean; passkeys: { id: string; label: string | null; site: string; createdAt: number; lastUsedAt: number | null }[]; devices: { id: string; device: string | null; lastSeenAt: number }[]; currentSession: string | null };

function MyAccount() {
  const s = useStore();
  const hub = s.studio.mode === "hub";
  const [me, setMe] = useState<MeDetail | null>(null);
  const [name, setName] = useState("");
  const [epidemic, setEpidemic] = useState("");
  const [scrape, setScrape] = useState("");
  const [credits, setCredits] = useState<number | null>(null);
  useEffect(() => {
    if (s.keys.scrapecreators) void api<{ credits: number }>("GET", "/api/social/credits").then((r) => setCredits(r.credits)).catch(() => setCredits(null));
  }, [s.keys.scrapecreators]);
  const load = useCallback(() => void store.attempt(async () => {
    const m = await api<MeDetail>("GET", "/api/me");
    setMe(m);
    setName(m.name);
  }), []);
  useEffect(load, [load]);
  const addPasskey = () =>
    void s.attempt(async () => {
      const { ticket, options } = await api<{ ticket: string; options: never }>("POST", "/api/me/passkeys/options");
      const response = await startRegistration({ optionsJSON: options });
      await api("POST", "/api/me/passkeys", { ticket, response });
      s.notify("Passkey added");
      load();
    });
  const current = me?.name ?? s.me?.name ?? "";
  return (
    <Page title="Account">
      {s.studio.closingAt && <div className="ui-callout bad"><Server size={17} /><span>This Hub closes on {when(s.studio.closingAt)}. Export your work before then.</span></div>}
      <Group>
        <div className="ui-row">
          <div className="st-person">
            <Avatar name={current || "You"} size="lg" />
            <div className="ui-row-text">
              <span className="ui-row-title">{current} <Badge>{ROLE[s.me?.role ?? "editor"]}</Badge></span>
              <span className="ui-row-meta">{me?.local ? "Mac app" : "Passkey"}{hub ? " · Admins can see your work and usage" : ""}</span>
            </div>
          </div>
        </div>
        <SettingRow title="Name">
          <form className="ui-inline" onSubmit={(e) => { e.preventDefault(); void s.attempt(async () => { await api("PATCH", "/api/me", { name }); await s.refresh(); load(); }); }}>
            <input className="ui-input" value={name} aria-label="Your name" onChange={(e) => setName(e.target.value)} />
            {name.trim() && name !== me?.name && <Button type="submit" size="sm" variant="primary" className="ui-pop">Save</Button>}
          </form>
        </SettingRow>
      </Group>

      <Group title="Claude">
        {s.accounts.map((a) => (
          <SettingRow key={a.id} title={<>{a.label} {a.plan && <Badge>{a.plan}</Badge>}</>} meta={a.email ?? (a.kind === "api_key" ? "API key" : undefined)}>
            {a.signedIn ? <Badge tone="ok">Signed in</Badge> : <Badge>Signed out</Badge>}
          </SettingRow>
        ))}
        <SettingRow title="Pause background work at" meta="Library analysis and learning wait past this share of your 5-hour limit.">
          <Select className="sm" label="Usage ceiling" value={String(s.settings.usageCeiling ?? 85)} onChange={(v) => void s.attempt(async () => { await api("POST", "/api/settings", { usage_ceiling: v }); await s.refresh(); })}>
            {[60, 70, 80, 85, 90, 95].map((n) => <option key={n} value={n}>{n}%</option>)}
          </Select>
        </SettingRow>
      </Group>

      <Group title="Epidemic Sound">
        <KeyRow
          title="Your API key"
          meta={s.keys.epidemic ? "Connected · Keychain" : "Per person. Needs a paid plan."}
          set={!!s.keys.epidemic}
          value={epidemic}
          onChange={setEpidemic}
          onSave={() => void s.attempt(async () => { await api("POST", "/api/keys/epidemic", { value: epidemic }); setEpidemic(""); await s.refresh(); })}
          onRemove={() => void s.attempt(async () => { await api("DELETE", "/api/keys/epidemic"); await s.refresh(); })}
        />
      </Group>

      <Group title="Scrape Creators">
        <KeyRow
          title="Your API key"
          meta={s.keys.scrapecreators ? `Connected · ${credits === null ? "Keychain" : `${credits.toLocaleString()} credits left`}` : "Per person. Lets you paste TikTok, Instagram, Facebook, X and other video links. About 1 credit a link."}
          set={!!s.keys.scrapecreators}
          value={scrape}
          onChange={setScrape}
          onSave={() => void s.attempt(async () => { await api("POST", "/api/keys/scrapecreators", { value: scrape }); setScrape(""); await s.refresh(); s.notify("Scrape Creators connected"); })}
          onRemove={() => void s.attempt(async () => { await api("DELETE", "/api/keys/scrapecreators"); await s.refresh(); })}
        />
      </Group>

      {hub && (
        <>
          <Group title="Passkeys" action={!me?.local && <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={addPasskey}>Add</Button>}>
            {me?.passkeys.map((p) => (
              <SettingRow key={p.id} title={<><Fingerprint size={15} className="t-muted" /> {p.label ?? "Passkey"}</>} meta={<Meta parts={[p.site, `Last used ${ago(p.lastUsedAt)}`]} />}>
                <Confirm icon={<Trash2 size={15} />} label="Remove passkey" confirm="Remove" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/me/passkeys/${p.id}`); load(); })} />
              </SettingRow>
            ))}
            {!me?.passkeys.length && <None text={me?.local ? "Not needed in the Mac app" : "None"} />}
          </Group>

          <Group title="Devices">
            {me?.devices.map((d) => (
              <SettingRow key={d.id} title={<>{d.device ?? "Browser"} {d.id === me.currentSession && <Badge tone="accent">This device</Badge>}</>} meta={`Active ${ago(d.lastSeenAt)}`}>
                <Confirm icon={<LogOut size={15} />} label="Sign out" confirm="Sign out" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/me/sessions/${d.id}`); if (d.id === me.currentSession) location.reload(); else load(); })} />
              </SettingRow>
            ))}
            {!me?.devices.length && <None text="No browser sessions" />}
          </Group>
        </>
      )}

      <Group title="Data">
        <SettingRow title="Export my work" meta="Chats, renders, memory, styles, saved motion and recipes.">
          <a className="ui-btn v-secondary sm" href="/api/me/export" download><Download size={13} /><span>Export</span></a>
        </SettingRow>
        {hub && !me?.local && (
          <SettingRow title="Sign out of this device">
            <Button size="sm" variant="ghost" icon={<LogOut size={14} />} onClick={() => void s.attempt(async () => { await api("POST", "/api/auth/logout"); location.reload(); })}>Sign out</Button>
          </SettingRow>
        )}
      </Group>
    </Page>
  );
}

/** A secret: paste once, never shown again. */
function KeyRow({ title, meta, set, value, onChange, onSave, onRemove, disabled }: { title: ReactNode; meta?: ReactNode; set: boolean; value: string; onChange: (v: string) => void; onSave: () => void; onRemove: () => void; disabled?: boolean }) {
  return (
    <SettingRow title={<>{title} {set && <Badge tone="ok">Connected</Badge>}</>} meta={meta}>
      {!disabled && (
        <form className="ui-inline" onSubmit={(e) => (e.preventDefault(), value.trim() && onSave())}>
          <input className="ui-input" type="password" value={value} placeholder={set ? "Replace key" : "Paste key"} aria-label={typeof title === "string" ? title : "Key"} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
          {value.trim() ? <Button type="submit" size="sm" variant="primary" className="ui-pop">Save</Button> : set && <Confirm icon={<Trash2 size={15} />} label="Remove key" confirm="Remove" onConfirm={onRemove} />}
        </form>
      )}
    </SettingRow>
  );
}

// ── Studio mode ────────────────────────────────────────────────

function StudioModeSection() {
  const s = useStore();
  const owner = s.me?.role === "owner";
  const local = !!s.me?.local;
  const canChange = owner && local;
  const [address, setAddress] = useState(s.studio.hubOrigin ?? "");
  const [joined, setJoined] = useState(s.studio.joinedHub ?? "");
  const choose = (mode: StudioMode) => void s.attempt(async () => { await api("POST", "/api/studio/mode", { mode, ...(mode === "joined" ? { joinedHub: joined || null } : {}) }); await s.refresh(); });
  const modes: { id: StudioMode; title: string; note: string; icon: ReactNode }[] = [
    { id: "single", title: "Single user", note: "Just you, on this Mac.", icon: <Monitor size={18} /> },
    { id: "hub", title: "Studio Hub", note: "Host your team. They sign in from a browser.", icon: <Server size={18} /> },
    { id: "joined", title: "Join a Hub", note: "Your team's Hub runs on another Mac.", icon: <Link2 size={18} /> },
  ];
  return (
    <Page title="Studio mode" description="How this Mac is used.">
      {!canChange && <div className="ui-callout"><Server size={17} /><span>{owner ? "Change this from the Mac app on the Hub." : "Only the Owner can change this."}</span></div>}
      <div className="ui-mode-cards" role="radiogroup" aria-label="Studio mode">
        {modes.map((m) => {
          const on = s.studio.mode === m.id;
          return (
            <button key={m.id} type="button" role="radio" aria-checked={on} className={`ui-card ${on ? "is-on" : ""}`} disabled={!canChange || on || (m.id === "joined" && !joined && !s.studio.joinedHub)} onClick={() => choose(m.id)}>
              <span className="ui-item-icon">{m.icon}</span>
              <b>{m.title}</b>
              <small>{m.note}</small>
              {on && <span className="ui-card-check"><Check size={12} strokeWidth={3} /></span>}
            </button>
          );
        })}
      </div>

      <div className="ui-divider" />

      {s.studio.mode === "hub" && (
        <Group title="Hub address">
          <SettingRow title="Address" meta={<>Point it at <code>127.0.0.1:51791</code>. Changing it needs new invites.</>} stack>
            <form className="ui-inline" onSubmit={(e) => { e.preventDefault(); void s.attempt(async () => { await api("POST", "/api/studio/address", { hubOrigin: address || null }); await s.refresh(); }); }}>
              <input className="ui-input" value={address} placeholder="https://studio.socialshifu.com" aria-label="Hub address" disabled={!canChange} onChange={(e) => setAddress(e.target.value)} />
              <Button type="submit" size="sm" variant="primary" disabled={!canChange || address === (s.studio.hubOrigin ?? "")}>Save</Button>
            </form>
          </SettingRow>
        </Group>
      )}

      {s.studio.mode === "hub" && owner && (
        <Group title="Close the Hub">
          {s.studio.closingAt ? (
            <SettingRow title={<>Closing {when(s.studio.closingAt)} <Badge tone="warn">Export window</Badge></>} meta="Members can export until then.">
              <Button size="sm" variant="secondary" onClick={() => void s.attempt(async () => { await api("POST", "/api/studio/close/cancel"); await s.refresh(); })}>Keep open</Button>
            </SettingRow>
          ) : (
            <SettingRow title="Back to single user" meta="Members get 14 days to export. Their data is archived, not deleted.">
              <Confirm confirm="Start 14 days" onConfirm={() => void s.attempt(async () => { await api("POST", "/api/studio/close"); await s.refresh(); })}>Close Hub</Confirm>
            </SettingRow>
          )}
        </Group>
      )}

      {s.studio.mode !== "hub" && (
        <Group title="Team Hub">
          <SettingRow title="Hub address" meta={s.studio.joinedHub ? "Opens in your browser." : "Ask your admin for it."} stack>
            <div className="ui-inline">
              <input className="ui-input" value={joined} placeholder="https://studio.socialshifu.com" aria-label="Team Hub address" disabled={!canChange} onChange={(e) => setJoined(e.target.value)} />
              {s.studio.mode === "joined" && <Button size="sm" variant="primary" icon={<ExternalLink size={13} />} disabled={!local} onClick={() => void s.attempt(() => api("POST", "/api/studio/open-hub"))}>Open</Button>}
            </div>
          </SettingRow>
        </Group>
      )}
    </Page>
  );
}

// ── Memory ─────────────────────────────────────────────────────

function RuleRow({ r, canEdit }: { r: MemoryRule; canEdit: boolean }) {
  const s = useStore();
  const [text, setText] = useState(r.text);
  const client = s.clients.find((c) => c.id === r.clientId);
  const status = STATUS[r.status];
  const patch = (body: Record<string, unknown>) => void s.attempt(() => api("PATCH", `/api/memory/${r.id}`, body));
  const confirm = (choice: string) => void s.attempt(() => api("POST", `/api/memory/${r.id}/confirm`, { choice }));
  return (
    <div className={`ui-row mem-row is-${r.status}`}>
      <div className="ui-row-text">
        {canEdit ? (
          <input className="ui-inplace" value={text} aria-label="Edit memory" onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text !== r.text && patch({ text })} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        ) : <span className="ui-row-title">{r.text}</span>}
        <span className="ui-row-meta">
          <Meta parts={[AREA_LABELS[r.area] ?? r.area, r.scope === "client" && client ? client.name : null, r.uses ? `Used ${r.uses}×` : null, status && <Badge tone={status.tone}>{status.label}</Badge>]} />
        </span>
      </div>
      {canEdit && (
        <div className="ui-row-control">
          {r.status === "suggested" ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => confirm("dismiss")}>Dismiss</Button>
              {r.clientId && client && <Button size="sm" variant="secondary" onClick={() => confirm("client")}>For {client.name}</Button>}
              <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={() => confirm("personal")}>Keep</Button>
            </>
          ) : (
            <>
              {r.status === "stale" ? <Button size="sm" variant="ghost" onClick={() => patch({ status: "active" })}>Resume</Button> : r.status === "active" && <Button size="sm" variant="ghost" onClick={() => patch({ status: "stale" })}>Pause</Button>}
              <Confirm icon={<Trash2 size={15} />} label="Delete memory" confirm="Delete" onConfirm={() => void s.attempt(() => api("DELETE", `/api/memory/${r.id}`))} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MemorySection() {
  const s = useStore();
  const hub = s.studio.mode === "hub";
  const admin = isAdmin(s.me);
  const [text, setText] = useState("");
  const [area, setArea] = useState("general");
  const [scope, setScope] = useState<MemoryScope>("personal");
  const [clientId, setClientId] = useState(s.clients[0]?.id ?? "");
  const mine = s.memory.filter((m) => m.scope === "personal");
  const clientRules = s.memory.filter((m) => m.scope === "client");
  const team = s.memory.filter((m) => m.scope === "team");
  const myClients = s.clients.filter((c) => admin || c.members.includes(s.me?.id ?? ""));
  const canEditClient = (r: MemoryRule) => admin || myClients.some((c) => c.id === r.clientId);
  const order = (list: MemoryRule[]) => [...list].sort((a, b) => Number(b.status === "suggested") - Number(a.status === "suggested"));
  const add = () => void s.attempt(async () => {
    await api("POST", "/api/memory", { text, area, scope, clientId: scope === "client" ? clientId : null });
    setText("");
  });
  return (
    <Page title="Memory" description="What your editors learned from your edits and picks.">
      <form className="mem-add" onSubmit={(e) => (e.preventDefault(), text.trim() && add())}>
        <input className="ui-input" value={text} placeholder="Add a rule, e.g. Keep B-roll under 1.5s in Reels" aria-label="New rule" onChange={(e) => setText(e.target.value)} />
        <div className="ui-inline">
          <Select className="sm" label="Area" value={area} onChange={setArea}>
            {(s.memoryAreas.length ? s.memoryAreas : Object.keys(AREA_LABELS)).map((a) => <option key={a} value={a}>{AREA_LABELS[a] ?? a}</option>)}
          </Select>
          {hub && (
            <Select className="sm" label="Applies to" value={scope} onChange={(v) => setScope(v as MemoryScope)}>
              <option value="personal">Just me</option>
              {myClients.length > 0 && <option value="client">A client</option>}
              {admin && <option value="team">Whole team</option>}
            </Select>
          )}
          {scope === "client" && (
            <Select className="sm" label="Client" value={clientId} onChange={setClientId}>
              {myClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
          <span style={{ flex: 1 }} />
          <Button type="submit" size="sm" variant="primary" icon={<Plus size={14} />} disabled={!text.trim()}>Add</Button>
        </div>
      </form>

      <Group title={<>Personal <span className="t-muted">{mine.length || ""}</span></>}>
        {mine.length ? order(mine).map((r) => <RuleRow key={r.id} r={r} canEdit />) : <EmptyState compact title="Nothing learned yet" text="Lessons appear as you edit." />}
      </Group>

      {hub && (clientRules.length > 0 || myClients.length > 0) && (
        <Group title={<>Clients <span className="t-muted">{clientRules.length || ""}</span></>}>
          {clientRules.length ? order(clientRules).map((r) => <RuleRow key={r.id} r={r} canEdit={canEditClient(r)} />) : <None text="No client rules" />}
        </Group>
      )}
      {hub && (
        <Group title={<>Team <span className="t-muted">{team.length || ""}</span></>}>
          {team.length ? team.map((r) => <RuleRow key={r.id} r={r} canEdit={admin} />) : <None text={admin ? "No team rules" : "None set by admins"} />}
        </Group>
      )}
    </Page>
  );
}

// ── Sharing ────────────────────────────────────────────────────

function SharingSection({ go }: { go: (s: Section) => void }) {
  const s = useStore();
  const names = useMemo(() => new Map(s.members.map((m) => [m.id, m.name])), [s.members]);
  const [open, setOpen] = useState<string | null>(null);
  const libraries = s.libraries.filter((l) => l.access === "own");
  const styles = s.styles.filter((v) => v.access === "own");
  if (s.studio.mode !== "hub") {
    return (
      <Page title="Sharing">
        <EmptyState art="people" title="Sharing needs a Studio Hub" text="In single-user mode everything stays yours." action={<Button variant="secondary" onClick={() => go("mode")}>Studio mode</Button>} />
      </Page>
    );
  }
  const shareLibrary = (l: LibraryView, grants: Grant[]) => void s.attempt(async () => { await api("PUT", `/api/libraries/${l.id}/shares`, { grants }); await s.refresh(); setOpen(null); s.notify(grants.length ? `${l.name} shared` : `${l.name} is private`); });
  const shareStyle = (v: EngineStyle, grants: Grant[]) => void s.attempt(async () => { await api("PUT", `/api/styles/${v.id}/shares`, { grants }); await s.refresh(); setOpen(null); });
  const shareMotion = (v: MotionItem, grants: Grant[]) => void s.attempt(async () => { await api("PUT", `/api/motion/${v.id}/shares`, { grants }); await s.refreshMotion(); setOpen(null); });
  const motion = s.motion.filter((v) => v.access === "own");
  const toggle = (id: string) => <Button size="sm" variant={open === id ? "ghost" : "secondary"} icon={open === id ? undefined : <Share2 size={13} />} onClick={() => setOpen(open === id ? null : id)}>{open === id ? "Close" : "Share"}</Button>;
  const shared = [...s.libraries.filter((l) => l.access !== "own"), ...s.styles.filter((v) => v.access === "use" || v.access === "edit"), ...s.motion.filter((v) => v.access !== "own")];
  return (
    <Page title="Sharing" description="Private until you share. Picks still follow each person's taste.">
      <Group title="My libraries">
        {libraries.map((l) => (
          <div key={l.id}>
            <SettingRow title={l.name} meta={<Meta parts={[`${l.clips} clips`, sharedLabel(l.sharedWith, names), l.drive && "On Drive"]} />}>{toggle(l.id)}</SettingRow>
            {open === l.id && <ShareEditor kind="library" grants={l.sharedWith} onSave={(g) => shareLibrary(l, g)} onCancel={() => setOpen(null)} />}
          </div>
        ))}
      </Group>
      <Group title="My styles">
        {styles.map((v) => (
          <div key={v.id}>
            <SettingRow title={v.name} meta={sharedLabel(v.sharedWith, names)}>{toggle(v.id)}</SettingRow>
            {open === v.id && <ShareEditor kind="style" grants={v.sharedWith ?? []} onSave={(g) => shareStyle(v, g)} onCancel={() => setOpen(null)} />}
          </div>
        ))}
        {!styles.length && <None text="No styles yet" />}
      </Group>
      <Group title="My motion">
        {motion.map((v) => (
          <div key={v.id}>
            <SettingRow title={v.name} meta={<Meta parts={[v.kind === "animation" ? v.technique?.label ?? "Animation" : v.kind === "caption" ? "Caption preset" : "Thumbnail", v.styleName, sharedLabel(v.sharedWith, names)]} />}>{toggle(v.id)}</SettingRow>
            {open === v.id && <ShareEditor kind="motion" grants={v.sharedWith} onSave={(g) => shareMotion(v, g)} onCancel={() => setOpen(null)} />}
          </div>
        ))}
        {!motion.length && <None text="Nothing saved yet" />}
      </Group>
      <Group title="Shared with me">
        {shared.map((x) => (
          <SettingRow key={x.id} title={x.name} meta={<Meta parts={["clips" in x ? "Library" : "kind" in x ? "Motion" : "Style", names.get(x.ownerId ?? "") ?? "Colleague"]} />}>
            <Badge>{x.access === "use" ? "Can use" : x.access === "add" ? "Can add" : "Can edit"}</Badge>
          </SettingRow>
        ))}
        {!shared.length && <None text="Nothing yet" />}
      </Group>
    </Page>
  );
}

// ── Integrations ───────────────────────────────────────────────

type Integrations = {
  drive: { connected: boolean; sharedDriveId: string | null; driveName: string | null };
  envato: { connected: boolean };
  scrapecreators: { key: boolean; connected: boolean };
  tailscale: { installed: false } | { installed: true; running: boolean; state: string; name: string | null; address: string | null; serving: boolean };
};

const STUDIO_KEYS = [
  { id: "openrouter", name: "OpenRouter", note: "Meaning search for B-roll" },
  { id: "google_api_key", name: "Google API key", note: "Imports public Drive folders" },
];

function IntegrationsSection() {
  const s = useStore();
  const hub = s.studio.mode === "hub";
  const manage = hub ? isAdmin(s.me) : s.me?.role === "owner";
  const [info, setInfo] = useState<Integrations | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [key, setKey] = useState<{ name: string; text: string } | null>(null);
  const [driveId, setDriveId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const load = useCallback(() => void store.attempt(async () => setInfo(await api<Integrations>("GET", "/api/integrations"))), []);
  useEffect(load, [load]);
  const ts = info?.tailscale;
  const [envatoBusy, setEnvatoBusy] = useState(false);
  const envato = (on: boolean) => void s.attempt(async () => {
    setEnvatoBusy(true);
    try {
      await api("POST", "/api/integrations/envato", { on });
      s.notify(on ? "Envato Elements connected" : "Envato Elements disconnected");
      load();
    } finally {
      setEnvatoBusy(false);
    }
  });
  const scrapeTools = (on: boolean) => void s.attempt(async () => {
    await api("POST", "/api/integrations/scrapecreators", { on });
    s.notify(on ? "Scrape Creators tools on for new chats" : "Scrape Creators tools off");
    load();
  });
  const connect = () => void s.attempt(async () => {
    setConnecting(true);
    try {
      const r = await api<{ driveName: string }>("POST", "/api/integrations/drive", { key: key!.text, sharedDriveId: driveId });
      setKey(null);
      s.notify(`Connected to ${r.driveName}`);
      load();
    } finally {
      setConnecting(false);
    }
  });
  return (
    <Page title="Integrations" description={manage ? undefined : "Managed by your admin."}>
      <Group title="API keys">
        {STUDIO_KEYS.map((k) => (
          <KeyRow
            key={k.id}
            title={k.name}
            meta={k.note}
            set={!!s.keys[k.id]}
            disabled={!manage}
            value={values[k.id] ?? ""}
            onChange={(v) => setValues({ ...values, [k.id]: v })}
            onSave={() => void s.attempt(async () => { await api("POST", `/api/keys/${k.id}`, { value: values[k.id] }); setValues({ ...values, [k.id]: "" }); await s.refresh(); })}
            onRemove={() => void s.attempt(async () => { await api("DELETE", `/api/keys/${k.id}`); await s.refresh(); })}
          />
        ))}
      </Group>

      <Group title="Envato Elements">
        <SettingRow
          title={<>Envato Elements {info?.envato.connected && <Badge tone="ok">Connected</Badge>}</>}
          meta={info?.envato.connected ? "Editors suggest stock video, music and templates. New chats only." : "Lets editors search stock video, music and templates. You download from Envato."}
        >
          {info?.envato.connected
            ? <Confirm confirm="Disconnect" onConfirm={() => envato(false)}>Disconnect</Confirm>
            : <Button size="sm" variant="primary" loading={envatoBusy} disabled={!info} onClick={() => envato(true)}>Connect</Button>}
        </SettingRow>
      </Group>

      <Group title="Scrape Creators">
        <SettingRow
          title={<>Tools in chats {info?.scrapecreators.connected && <Badge tone="ok">On</Badge>}</>}
          meta={!info?.scrapecreators.key ? "Add your API key in Account first." : info.scrapecreators.connected ? "Editors can look up posts, creators and transcripts. It spends your credits. New chats only." : "Let editors look up posts, creators and transcripts. Off by default, because it spends your credits."}
        >
          {info?.scrapecreators.connected
            ? <Confirm confirm="Turn off" onConfirm={() => scrapeTools(false)}>Turn off</Confirm>
            : <Button size="sm" variant="primary" disabled={!info?.scrapecreators.key} onClick={() => scrapeTools(true)}>Turn on</Button>}
        </SettingRow>
      </Group>

      <Group title="Google Drive">
        {info?.drive.connected ? (
          <SettingRow title={<><HardDrive size={15} className="t-muted" /> {info.drive.driveName ?? "Shared Drive"} <Badge tone="ok">Connected</Badge></>} meta="Shared libraries sync here.">
            {manage && <Confirm confirm="Disconnect" onConfirm={() => void s.attempt(async () => { await api("DELETE", "/api/integrations/drive"); load(); })}>Disconnect</Confirm>}
          </SettingRow>
        ) : manage ? (
          <SettingRow title="Company Shared Drive" meta="Shared libraries sync here." stack>
            <ol className="ui-steps">
              <li><span>In Google Cloud, enable the Drive API and create a service account with a JSON key.</span></li>
              <li><span>Add the service account to your Shared Drive as Content manager.</span></li>
              <li>
                <div className="ui-inline grow">
                  <FileButton size="sm" variant="secondary" icon={key ? <Check size={13} /> : undefined} accept="application/json,.json" onFiles={(f) => void f[0].text().then((text) => setKey({ name: f[0].name, text }))}>{key ? key.name : "JSON key"}</FileButton>
                  <input className="ui-input" value={driveId} placeholder="Shared Drive ID" aria-label="Shared Drive ID" onChange={(e) => setDriveId(e.target.value)} />
                  <Button size="sm" variant="primary" loading={connecting} disabled={!key || !driveId.trim()} onClick={connect}>Connect</Button>
                </div>
              </li>
            </ol>
          </SettingRow>
        ) : (
          <SettingRow title="Shared Drive" meta="Shared libraries sync here."><Badge>Not connected</Badge></SettingRow>
        )}
      </Group>

      <Group title="Tailscale">
        {!ts ? <None text="Checking…" /> : !ts.installed ? (
          <SettingRow title={<><Wifi size={15} className="t-muted" /> Tailscale</>} meta="Reach a Hub from other networks.">
            <a className="ui-btn v-secondary sm" href="https://tailscale.com/download" target="_blank" rel="noreferrer"><ExternalLink size={13} /><span>Get Tailscale</span></a>
          </SettingRow>
        ) : (
          <>
            <SettingRow title={<><Wifi size={15} className="t-muted" /> Tailscale {ts.running ? <Badge tone="ok">Connected</Badge> : <Badge tone="warn">{ts.state}</Badge>}</>} meta={ts.running ? ts.address ?? ts.name : "Open Tailscale and sign in."}>
              {ts.running && s.me?.role === "owner" && s.me.local && hub && (
                ts.serving
                  ? <Confirm confirm="Stop sharing" onConfirm={() => void s.attempt(async () => { await api("POST", "/api/integrations/tailscale/serve", { on: false }); load(); })}>Stop sharing</Confirm>
                  : <Button size="sm" variant="primary" onClick={() => void s.attempt(async () => { await api("POST", "/api/integrations/tailscale/serve", { on: true }); load(); })}>Share Hub</Button>
              )}
              {!hub && <span className="ui-row-meta">Needs a Studio Hub</span>}
            </SettingRow>
            {ts.running && ts.address && hub && s.me?.role === "owner" && s.studio.hubOrigin !== ts.address && (
              <SettingRow title="Use as Hub address" meta={ts.address}>
                <Button size="sm" variant="secondary" disabled={!s.me.local} onClick={() => void s.attempt(async () => { await api("POST", "/api/studio/address", { hubOrigin: ts.address }); await s.refresh(); })}>Use</Button>
              </SettingRow>
            )}
          </>
        )}
      </Group>

      <Group title="Tool packs">
        {s.packs.map((p) => (
          <SettingRow key={p.id} title={<>{p.name} {p.installed && <Badge tone="ok">Installed</Badge>}</>} meta={<Meta parts={[p.about, p.size]} />}>
            {!p.installed && manage && <PackButton id={p.id} name={p.name} />}
          </SettingRow>
        ))}
      </Group>
    </Page>
  );
}

// ── Team ───────────────────────────────────────────────────────

type TeamView = {
  members: { id: string; name: string; role: Role; status: string; createdAt: number; lastSeenAt: number | null; endedAt: number | null; passkeys: number; devices: number }[];
  invites: { id: string; name: string; role: Role; createdAt: number; expiresAt: number }[];
  clients: Client[];
  suggestions: { text: string; area: string; people: number }[];
};
type AuditEntry = { id: number; actorId: string | null; action: string; targetType: string | null; detail: unknown; at: number };

const ACTIONS: Record<string, string> = {
  "studio.mode": "changed the studio mode", "hub.address": "changed the Hub address", "hub.closing": "started closing the Hub", "hub.closing.cancelled": "kept the Hub open", "hub.closed": "closed the Hub",
  "member.join": "joined", "member.role": "changed a role", "member.remove": "removed someone", "member.rename": "renamed someone", "invite.create": "sent an invite", "invite.revoke": "cancelled an invite",
  "session.revoke": "signed out a device", "passkey.add": "added a passkey", "passkey.remove": "removed a passkey", "client.create": "added a client", "client.update": "changed a client", "client.archive": "removed a client",
  "library.share": "changed library sharing", "style.share": "changed style sharing", "library.remove": "removed a library", "library.clip.remove": "removed a clip", "style.remove": "removed a style", "style.update": "edited a shared style",
  "motion.share": "changed motion sharing", "motion.remove": "removed a saved animation", "motion.update": "renamed a shared animation", "motion.term.merge": "merged a motion technique",
  "memory.add": "added a memory", "memory.update": "edited a memory", "memory.remove": "removed a memory", "memory.confirm": "kept a memory", "recipe.remove": "removed a recipe",
  "user.chat.view": "opened someone's chat", "user.chat.remove": "removed a chat", "user.export": "exported someone's work", "drive.connect": "connected Google Drive", "drive.disconnect": "disconnected Google Drive",
  "key.set": "changed a studio key", "key.remove": "removed a studio key", "tailscale.serve.on": "shared the Hub on Tailscale", "tailscale.serve.off": "stopped Tailscale sharing",
};

function TeamSection({ go }: { go: (s: Section) => void }) {
  const s = useStore();
  const owner = s.me?.role === "owner";
  const [team, setTeam] = useState<TeamView | null>(null);
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [logShown, setLogShown] = useState(8);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"editor" | "admin">("editor");
  const [link, setLink] = useState<string | null>(null);
  const [client, setClient] = useState("");
  const { copied, copy } = useCopy();
  const load = useCallback(() => void store.attempt(async () => {
    setTeam(await api<TeamView>("GET", "/api/team"));
    setLog(await api<AuditEntry[]>("GET", "/api/team/audit"));
  }), []);
  useEffect(load, [load, s.teamVersion]);
  const names = new Map(team?.members.map((m) => [m.id, m.name]) ?? []);
  const invite = () => void s.attempt(async () => {
    const r = await api<{ link: string }>("POST", "/api/team/invites", { name, role });
    setLink(r.link);
    setName("");
    load();
  });
  if (!team) return <Page title="Team"><None text="Loading…" /></Page>;
  const active = team.members.filter((m) => m.status === "active");
  const former = team.members.filter((m) => m.status !== "active");
  return (
    <Page title="Team" description={`${active.length} ${active.length === 1 ? "member" : "members"}`}>
      <Group title="Invite">
        {!s.studio.hubOrigin ? (
          <SettingRow title="Set the Hub address first" meta="Invite links need somewhere to go.">
            <Button size="sm" variant="secondary" onClick={() => go("mode")}>Studio mode</Button>
          </SettingRow>
        ) : (
          <div className="ui-row">
            <form className="ui-inline" style={{ flex: 1 }} onSubmit={(e) => (e.preventDefault(), name.trim() && invite())}>
              <input className="ui-input" value={name} placeholder="Name" aria-label="Name" onChange={(e) => setName(e.target.value)} />
              <Select className="sm" label="Role" value={role} onChange={(v) => setRole(v as "editor" | "admin")}>
                <option value="editor">Editor</option>
                {owner && <option value="admin">Admin</option>}
              </Select>
              <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>Create link</Button>
            </form>
          </div>
        )}
        {link && (
          <div className="ui-row is-stack ui-pop">
            <div className="ui-code">
              <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
              <Button size="sm" variant={copied ? "secondary" : "primary"} icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => copy(link)}>{copied ? "Copied" : "Copy"}</Button>
              <IconButton label="Done" onClick={() => setLink(null)}><Check size={15} /></IconButton>
            </div>
            <span className="ui-row-meta">Single use, expires in 7 days. Shown only once.</span>
          </div>
        )}
        {team.invites.map((i) => (
          <SettingRow key={i.id} title={<>{i.name} <Badge>{ROLE[i.role]}</Badge> <Badge tone="warn">Pending</Badge></>} meta={`Expires ${when(i.expiresAt)}`}>
            <Confirm confirm="Cancel invite" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/team/invites/${i.id}`); load(); })}>Cancel</Confirm>
          </SettingRow>
        ))}
      </Group>

      <Group title="Members">
        {active.map((m) => (
          <div key={m.id} className="ui-row">
            <div className="st-person" style={{ flex: 1, minWidth: 0 }}>
              <Avatar name={m.name} />
              <div className="ui-row-text">
                <span className="ui-row-title">{m.name} {m.id === s.me?.id && <span className="t-muted">(you)</span>}</span>
                <span className="ui-row-meta">{m.role === "owner" && !m.lastSeenAt ? "Mac app" : <Meta parts={[`Seen ${ago(m.lastSeenAt)}`, `${m.devices} ${m.devices === 1 ? "device" : "devices"}`]} />}</span>
              </div>
            </div>
            <div className="ui-row-control">
              {owner && m.role !== "owner" ? (
                <Select className="sm" label={`${m.name}'s role`} value={m.role} onChange={(v) => void s.attempt(async () => { await api("PATCH", `/api/team/members/${m.id}`, { role: v }); load(); })}>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </Select>
              ) : <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{ROLE[m.role]}</Badge>}
              {m.role !== "owner" && m.id !== s.me?.id && (owner || m.role === "editor") && (
                <Confirm icon={<Trash2 size={15} />} label={`Remove ${m.name}`} confirm="Remove" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/team/members/${m.id}`); load(); })} />
              )}
            </div>
          </div>
        ))}
      </Group>

      {former.length > 0 && (
        <Group title="Former members">
          {former.map((m) => <SettingRow key={m.id} title={m.name} meta={`${m.status === "archived" ? "Archived" : "Removed"} ${when(m.endedAt)} · Work kept in Users`} />)}
        </Group>
      )}

      <Group title="Clients">
        <div className="ui-row">
          <form className="ui-inline" style={{ flex: 1 }} onSubmit={(e) => { e.preventDefault(); if (!client.trim()) return; void s.attempt(async () => { await api("POST", "/api/clients", { name: client }); setClient(""); load(); await s.refresh(); }); }}>
            <input className="ui-input" value={client} placeholder="Client or brand" aria-label="Client name" onChange={(e) => setClient(e.target.value)} />
            <Button type="submit" size="sm" variant="secondary" icon={<Plus size={14} />} disabled={!client.trim()}>Add</Button>
          </form>
        </div>
        {team.clients.map((c) => (
          <div key={c.id} className="ui-row is-stack">
            <div className="ui-inline">
              <span className="ui-row-title" style={{ flex: 1 }}>{c.name}</span>
              <Confirm icon={<Trash2 size={15} />} label={`Remove ${c.name}`} confirm="Remove" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/clients/${c.id}`); load(); await s.refresh(); })} />
            </div>
            <div className="ui-chips">
              {active.map((m) => {
                const on = c.members.includes(m.id);
                return (
                  <button key={m.id} type="button" className={`ui-chip ${on ? "is-on" : ""}`} aria-pressed={on} onClick={() => void s.attempt(async () => { await api("PATCH", `/api/clients/${c.id}`, { members: on ? c.members.filter((x) => x !== m.id) : [...c.members, m.id] }); load(); await s.refresh(); })}>
                    {on && <Check size={12} strokeWidth={3} />} {m.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </Group>

      {team.suggestions.length > 0 && (
        <Group title="Suggested team rules">
          {team.suggestions.map((g) => (
            <SettingRow key={g.text} title={g.text} meta={<Meta parts={[AREA_LABELS[g.area] ?? g.area, `Learned by ${g.people} people`]} />}>
              <Button size="sm" variant="secondary" onClick={() => void s.attempt(async () => { await api("POST", "/api/memory", { text: g.text, area: g.area, scope: "team" }); load(); })}>Make team rule</Button>
            </SettingRow>
          ))}
        </Group>
      )}

      <Group title="Activity">
        {log.slice(0, logShown).map((l) => (
          <SettingRow key={l.id} title={<span className="act"><b>{l.actorId ? names.get(l.actorId) ?? "Someone" : "Studio"}</b> {ACTIONS[l.action] ?? l.action}</span>}>
            <span className="ui-row-meta">{ago(l.at)}</span>
          </SettingRow>
        ))}
        {!log.length && <None text="No activity yet" />}
        {log.length > logShown && <div className="ui-row"><Button size="sm" variant="ghost" onClick={() => setLogShown((n) => n + 20)}>Show more</Button></div>}
      </Group>
    </Page>
  );
}

// ── Users ──────────────────────────────────────────────────────

type UserView = {
  member: { id: string; name: string; role: Role; status: string; lastSeenAt: number | null };
  chats: { id: string; name: string; mission: { title?: string } | null; createdAt: number; endedAt: number | null; status: string }[];
  styles: EngineStyle[];
  memory: MemoryRule[];
  libraries: LibraryView[];
  motion: MotionItem[];
  recipes: { id: string; title: string; text: string; uses: number }[];
  usage: Pick<Account, "id" | "label" | "kind" | "email" | "plan" | "signedIn" | "limits" | "limitsAt">[];
  devices: { id: string; device: string | null; lastSeenAt: number }[];
};

function UsersSection() {
  const s = useStore();
  const [people, setPeople] = useState<TeamView["members"]>([]);
  const [id, setId] = useState<string | null>(null);
  const [user, setUser] = useState<UserView | null>(null);
  const [chat, setChat] = useState<{ id: string; title: string; messages: { id: number; role: string; kind: string; text: string }[] } | null>(null);
  const [clips, setClips] = useState<{ libraryId: string; list: { id: string; name: string; duration: number }[] } | null>(null);
  useEffect(() => void store.attempt(async () => setPeople((await api<TeamView>("GET", "/api/team")).members)), [s.teamVersion]);
  const load = useCallback(() => id && void store.attempt(async () => setUser(await api<UserView>("GET", `/api/users/${id}`))), [id]);
  useEffect(() => {
    setUser(null);
    setChat(null);
    setClips(null);
    load();
  }, [load]);
  const remove = (path: string) => void s.attempt(async () => { await api("DELETE", `/api/users/${id}/${path}`); load(); });
  const del = (confirm: string, path: string) => <Confirm icon={<Trash2 size={15} />} label={confirm} confirm={confirm} onConfirm={() => remove(path)} />;

  if (!id) {
    return (
      <Page title="Users" description="View or remove anyone's work. Every view is logged.">
        <div className="ui-list">
          {people.map((m) => (
            <Item key={m.id} icon={<Avatar name={m.name} />} title={<>{m.name} <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{ROLE[m.role]}</Badge> {m.status !== "active" && <Badge tone="warn">Former</Badge>}</>} meta={`Seen ${ago(m.lastSeenAt)}`} onClick={() => setId(m.id)} />
          ))}
        </div>
      </Page>
    );
  }

  if (user && chat) {
    return (
      <div className="st-page">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => setChat(null)}>{user.member.name}</Button>
        <header style={{ marginTop: 12 }}><h1>{chat.title}</h1></header>
        <div className="user-chat">
          {chat.messages.filter((m) => m.kind === "text" || m.kind === "error").map((m) => (
            <div key={m.id} className={`user-msg ${m.role}`}><b>{m.role === "user" ? user.member.name : m.role === "editor" ? "Editor" : "Studio"}</b><span>{m.text}</span></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="st-page">
      <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => setId(null)}>All users</Button>
      {user && (
        <>
          <header className="st-person" style={{ margin: "14px 0 22px" }}>
            <Avatar name={user.member.name} size="lg" />
            <div style={{ flex: 1 }}>
              <h1 style={{ margin: 0, fontFamily: "var(--font-title)", fontSize: 22, letterSpacing: "-0.02em" }}>{user.member.name}</h1>
              <span className="ui-row-meta"><Meta parts={[ROLE[user.member.role], `Seen ${ago(user.member.lastSeenAt)}`]} /></span>
            </div>
            <a className="ui-btn v-secondary sm" href={`/api/users/${user.member.id}/export`} download><Download size={13} /><span>Export</span></a>
          </header>

          <Group title="Usage">
            {user.usage.map((a) => (
              <SettingRow key={a.id} title={<>{a.label} {a.plan && <Badge>{a.plan}</Badge>}</>} meta={a.limits.length ? <Meta parts={a.limits.map((l) => `${l.label} ${Math.round(l.usedPercent)}%`)} /> : a.signedIn ? "No limits reported" : "Signed out"} />
            ))}
            {!user.usage.length && <None text="No Claude account" />}
          </Group>

          <Group title={`Chats · ${user.chats.length}`}>
            {user.chats.map((c) => (
              <SettingRow key={c.id} title={c.mission?.title ?? `Chat with ${c.name}`} meta={<Meta parts={[when(c.createdAt), c.endedAt ? "Ended" : <span className="t-ok">Open</span>]} />}>
                <Button size="sm" variant="secondary" onClick={() => void s.attempt(async () => { const r = await api<{ messages: { id: number; role: string; kind: string; text: string }[] }>("GET", `/api/users/${id}/chats/${c.id}/messages`); setChat({ id: c.id, title: c.mission?.title ?? c.name, messages: r.messages }); })}>Open</Button>
                {del("Delete chat", `chats/${c.id}`)}
              </SettingRow>
            ))}
            {!user.chats.length && <None text="No chats" />}
          </Group>

          <Group title={`Memory · ${user.memory.length}`}>
            {user.memory.map((r) => <SettingRow key={r.id} title={r.text} meta={<Meta parts={[AREA_LABELS[r.area] ?? r.area, STATUS[r.status]?.label]} />}>{del("Delete", `memory/${r.id}`)}</SettingRow>)}
            {!user.memory.length && <None text="Nothing learned yet" />}
          </Group>

          <Group title={`Styles · ${user.styles.length}`}>
            {user.styles.map((v) => <SettingRow key={v.id} title={v.name} meta={v.status === "draft" ? "Draft" : "Approved"}>{del("Delete", `styles/${v.id}`)}</SettingRow>)}
            {!user.styles.length && <None text="No styles" />}
          </Group>

          <Group title={`Motion · ${user.motion.length}`}>
            {user.motion.map((v) => <SettingRow key={v.id} title={v.name} meta={<Meta parts={[v.kind === "animation" ? v.technique?.label ?? "Animation" : v.kind === "caption" ? "Caption preset" : "Thumbnail", v.styleName]} />}>{del("Delete", `motion/${v.id}`)}</SettingRow>)}
            {!user.motion.length && <None text="Nothing saved" />}
          </Group>

          <Group title={`Libraries · ${user.libraries.length}`}>
            {user.libraries.map((l) => (
              <div key={l.id}>
                <SettingRow title={l.name} meta={`${l.clips} clips`}>
                  <Button size="sm" variant="ghost" onClick={() => void s.attempt(async () => setClips(clips?.libraryId === l.id ? null : { libraryId: l.id, list: await api("GET", `/api/users/${id}/library/${l.id}/clips`) }))}>{clips?.libraryId === l.id ? "Hide" : "Clips"}</Button>
                  {del("Delete library", `libraries/${l.id}`)}
                </SettingRow>
                {clips?.libraryId === l.id && clips.list.map((c) => (
                  <SettingRow key={c.id} title={<span className="t-muted">{c.name}</span>} meta={`${Math.round(c.duration ?? 0)}s`}>
                    <Confirm icon={<Trash2 size={15} />} label="Remove clip" confirm="Remove" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/users/${id}/libraries/${l.id}/clips/${c.id}`); setClips({ ...clips, list: clips.list.filter((x) => x.id !== c.id) }); load(); })} />
                  </SettingRow>
                ))}
              </div>
            ))}
          </Group>

          <Group title={`Recipes · ${user.recipes.length}`}>
            {user.recipes.map((r) => <SettingRow key={r.id} title={r.title} meta={r.text}>{del("Delete", `recipes/${r.id}`)}</SettingRow>)}
            {!user.recipes.length && <None text="No recipes" />}
          </Group>

          <Group title="Devices">
            {user.devices.map((d) => (
              <SettingRow key={d.id} title={d.device ?? "Browser"} meta={`Active ${ago(d.lastSeenAt)}`}>
                <Confirm icon={<LogOut size={15} />} label="Sign out" confirm="Sign out" onConfirm={() => void s.attempt(async () => { await api("DELETE", `/api/team/sessions/${d.id}`); load(); })} />
              </SettingRow>
            ))}
            {!user.devices.length && <None text="Not signed in anywhere" />}
          </Group>
        </>
      )}
    </div>
  );
}

// ── This Mac ───────────────────────────────────────────────────

type Doctor = Record<string, { ok: boolean; detail: string }>;
const DOCTOR: Record<string, string> = { claude: "Claude Code", ffmpeg: "FFmpeg", native: "Native tools", python: "Python" };

function ThisMac() {
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  useEffect(() => void store.attempt(async () => setDoctor(await api<Doctor>("GET", "/api/doctor"))), []);
  return (
    <Page title="This Mac">
      <Group title="Components">
        {!doctor && <None text="Checking…" />}
        {doctor && Object.keys(DOCTOR).filter((k) => doctor[k]).map((k) => (
          <SettingRow key={k} title={DOCTOR[k]} meta={doctor[k].detail}>
            {doctor[k].ok ? <Badge tone="ok"><Check size={11} strokeWidth={3} /> Ready</Badge> : <Badge tone="bad">Missing</Badge>}
          </SettingRow>
        ))}
      </Group>
    </Page>
  );
}
