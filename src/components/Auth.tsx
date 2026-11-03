import { ReactNode, useEffect, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, ShieldCheck, Sparkles } from "lucide-react";
import { AuthStatus, api } from "../sim/engine";
import { Button } from "./ui";

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", editor: "Editor" };

/** Reads an invite from the address. The token sits after # so it never reaches a server log. */
const inviteToken = () => new URLSearchParams(location.hash.slice(1)).get("join");

function Shell({ title = "Shifu Dojo", children }: { title?: string; children: ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-live="polite">
        <span className="auth-mark" aria-hidden><Sparkles size={24} /></span>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}

/** Tells people why a passkey prompt failed, in words rather than browser error names. */
function explain(e: unknown) {
  const name = (e as { name?: string }).name;
  if (name === "NotAllowedError") return "Passkey prompt closed. Try again.";
  if (name === "InvalidStateError") return "This device already has a passkey here. Sign in instead.";
  if (name === "SecurityError") return "Open the studio's https link to use passkeys.";
  return (e as Error).message || "Something went wrong. Try again.";
}

function Join({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ name: string; role: string; studio: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ name: string; role: string; studio: string }>("POST", "/api/auth/invite", { token }).then(setInvite, (e: Error) => setError(e.message));
  }, [token]);
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ticket, options } = await api<{ ticket: string; options: never }>("POST", "/api/auth/join/options", { token });
      const response = await startRegistration({ optionsJSON: options });
      await api("POST", "/api/auth/join", { token, ticket, response });
      history.replaceState(null, "", location.pathname);
      onDone();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  if (error && !invite) return <Shell title="Invite unavailable"><p>{error}</p></Shell>;
  if (!invite) return <Shell><p>Checking your invite…</p></Shell>;
  const supported = browserSupportsWebAuthn();
  return (
    <Shell title={`Join ${invite.studio}`}>
      <p>Hi {invite.name}, you're invited as {ROLE[invite.role] ?? invite.role}.</p>
      {!supported && <div className="ui-callout bad"><span>This browser can't create passkeys.</span></div>}
      {error && <div className="ui-callout bad"><span>{error}</span></div>}
      <Button variant="primary" size="lg" icon={<Fingerprint size={17} />} loading={busy} disabled={!supported} onClick={() => void join()}>{busy ? "Waiting for passkey" : "Join with a passkey"}</Button>
      <p className="auth-fine"><ShieldCheck size={12} style={{ verticalAlign: -2 }} /> Admins can see your work and usage. You'll use your own Claude account.</p>
    </Shell>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const { ticket, options } = await api<{ ticket: string; options: never }>("POST", "/api/auth/login/options");
      const response = await startAuthentication({ optionsJSON: options });
      await api("POST", "/api/auth/login", { ticket, response });
      onDone();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Sign in">
      <p>Use the passkey for this studio.</p>
      {error && <div className="ui-callout bad"><span>{error}</span></div>}
      <Button variant="primary" size="lg" icon={<Fingerprint size={17} />} loading={busy} disabled={!browserSupportsWebAuthn()} onClick={() => void signIn()}>{busy ? "Waiting for passkey" : "Sign in with passkey"}</Button>
      <p className="auth-fine">New here? Ask your admin for an invite.</p>
    </Shell>
  );
}

/**
 * The studio only appears for a signed-in person. In a single-user studio the Mac app already is
 * that person, so this passes straight through. A reload after signing in starts the live stream fresh.
 */
export function Gate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const done = () => location.reload();
  useEffect(() => {
    if (new URLSearchParams(location.search).has("demo")) return setStatus({ signedIn: true } as AuthStatus);
    api<AuthStatus>("GET", "/api/auth/status").then(setStatus, () => setFailed(true));
  }, []);
  const [token, setToken] = useState(inviteToken);
  useEffect(() => {
    const read = () => setToken(inviteToken());
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  if (failed) return <Shell title="Can't reach the studio"><p>Check your connection, then reload.</p></Shell>;
  if (!status) return null;
  if (token && status.mode === "hub") return <Join token={token} onDone={done} />;
  if (!status.signedIn) return status.mode === "hub" ? <SignIn onDone={done} /> : <Shell><p>Open Shifu Dojo from the Mac app.</p></Shell>;
  return <>{children}</>;
}
