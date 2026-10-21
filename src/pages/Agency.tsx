import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useSearchParams } from "react-router";
import { formatDistanceToNow } from "date-fns";
import {
  Archive,
  ArchiveRestore,
  Building2,
  CheckCircle2,
  Copy,
  Globe,
  Loader2,
  Mail,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  MAX_CLIENTS_PER_AGENCY,
  MAX_MEMBERS_PER_AGENCY,
  MAX_WEBSITES_PER_CLIENT,
} from "@/lib/agency";

// ── /agency — Phase 6: agency workspace MVP ──────────────────────────────────
// One page, four surfaces, all driven by server-side membership:
//   1. create a workspace (no workspace yet),
//   2. accept an invitation (?invite=<token> link, previewed then accepted),
//   3. the agency dashboard (clients → websites → uptime + latest report),
//   4. the client detail panel (assign/unassign the acting user's own monitors).
// Team invites and branding are owner-only in the backend; this page hides the
// controls for members but the enforcement lives in src/convex/agency.ts.

const STATE_STYLES: Record<string, string> = {
  up: "border-emerald-300 bg-emerald-50 text-emerald-700",
  down: "border-red-300 bg-red-50 text-red-700",
  suspect: "border-amber-300 bg-amber-50 text-amber-700",
  unknown: "border-border bg-muted text-muted-foreground",
};

function StatePill({ state }: { state: string }) {
  return (
    <span
      className={`inline-flex items-center border px-1.5 py-0.5 text-[10px] font-bold uppercase ${STATE_STYLES[state] ?? STATE_STYLES.unknown}`}
    >
      {state}
    </span>
  );
}

function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  return formatDistanceToNow(ms, { addSuffix: true });
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export default function Agency() {
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get("invite");

  const myAgency = useQuery(api.agency.getMyAgency);
  const invitePreview = useQuery(
    api.agency.previewInvite,
    inviteToken ? { token: inviteToken } : "skip",
  );

  const createAgency = useMutation(api.agency.createAgency);
  const acceptInvite = useMutation(api.agency.acceptInvite);

  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (myAgency === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  // ── Invitation surface (shown regardless of workspace state so the invitee
  //    always sees why accepting failed and what account it went to). ────────
  const inviteBanner = inviteToken ? (
    <InviteBanner
      token={inviteToken}
      preview={invitePreview}
      alreadyInAgency={myAgency !== null}
      onAccept={async () => {
        setBusy(true);
        setError(null);
        try {
          await acceptInvite({ token: inviteToken });
          window.history.replaceState(null, "", "/agency");
          window.location.reload();
        } catch (err) {
          setError(errorMessage(err, "Could not accept the invitation."));
        } finally {
          setBusy(false);
        }
      }}
      busy={busy}
    />
  ) : null;

  // ── 1. No workspace yet: create one (or read the invite). ────────────────
  if (myAgency === null) {
    return (
      <main className="min-h-screen bg-background px-6 py-10 text-foreground">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
          <header className="flex flex-col gap-2">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:underline">
              ← Back to dashboard
            </Link>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Building2 className="size-6" /> Agency workspace
            </h1>
            <p className="text-sm text-muted-foreground">
              Run every client site from one place: shared client lists, uptime status and the
              latest report for each website you monitor.
            </p>
          </header>

          {inviteBanner}
          {error && (
            <div className="flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
              <XCircle className="size-4 shrink-0" /> {error}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Create a workspace</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-3"
                onSubmit={async (event: FormEvent) => {
                  event.preventDefault();
                  setBusy(true);
                  setError(null);
                  try {
                    await createAgency({
                      name,
                      ...(logoUrl.trim() ? { logoUrl: logoUrl.trim() } : {}),
                    });
                  } catch (err) {
                    setError(errorMessage(err, "Could not create the workspace."));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Agency name (e.g. Northwind Digital)"
                  maxLength={80}
                  required
                />
                <Input
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="Logo image URL (optional, http/https)"
                  inputMode="url"
                />
                <Button type="submit" disabled={busy} className="gap-2">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  Create workspace
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  // ── 2. In a workspace: the dashboard. ────────────────────────────────────
  return (
    <AgencyDashboard
      agencyId={myAgency.agency._id}
      inviteBanner={inviteBanner}
      globalError={error}
    />
  );
}

/* ── Invitation banner ─────────────────────────────────────────────────────── */

function InviteBanner({
  token,
  preview,
  alreadyInAgency,
  onAccept,
  busy,
}: {
  token: string;
  preview:
    | { status: string; agencyName?: string; email?: string }
    | undefined;
  alreadyInAgency: boolean;
  onAccept: () => Promise<void>;
  busy: boolean;
}) {
  if (preview === undefined) {
    return (
      <div className="flex items-center gap-2 border border-border bg-muted px-3 py-2 text-sm">
        <Loader2 className="size-4 animate-spin" /> Checking invitation…
      </div>
    );
  }
  if (preview.status !== "pending") {
    const why =
      preview.status === "accepted"
        ? "already been accepted"
        : preview.status === "revoked"
          ? "been revoked"
          : preview.status === "expired"
            ? "expired"
            : "not valid";
    return (
      <div className="flex items-center gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        <Mail className="size-4 shrink-0" /> This invitation has {why}. Ask the workspace owner for a
        new link.
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="size-5" /> Join {preview.agencyName ?? "a workspace"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p>
          This invitation was sent to <span className="font-semibold">{preview.email}</span>. To
          accept it, sign in with that email account — an invitation link alone never grants access.
        </p>
        {alreadyInAgency ? (
          <p className="text-amber-700">
            You already belong to a workspace. Leave it first to accept this invitation.
          </p>
        ) : (
          <Button onClick={() => void onAccept()} disabled={busy} className="gap-2 self-start">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            Accept invitation
          </Button>
        )}
        <p className="text-xs text-muted-foreground">Token: {token.slice(0, 8)}…</p>
      </CardContent>
    </Card>
  );
}

/* ── Dashboard ─────────────────────────────────────────────────────────────── */

function AgencyDashboard({
  agencyId,
  inviteBanner,
  globalError,
}: {
  agencyId: Id<"agencies">;
  inviteBanner: ReactNode;
  globalError: string | null;
}) {
  const dashboard = useQuery(api.agency.getDashboard, { agencyId });
  const monitors = useQuery(api.monitors.listMonitors);
  const members = useQuery(api.agency.listMembers, { agencyId });
  const invites = useQuery(api.agency.listInvites, { agencyId });

  const createClient = useMutation(api.agency.createClient);
  const updateClient = useMutation(api.agency.updateClient);
  const setArchived = useMutation(api.agency.setClientArchived);
  const assignWebsite = useMutation(api.agency.assignWebsite);
  const unassignWebsite = useMutation(api.agency.unassignWebsite);
  const inviteMember = useMutation(api.agency.inviteMember);
  const revokeInvite = useMutation(api.agency.revokeInvite);
  const updateAgency = useMutation(api.agency.updateAgency);

  const [selected, setSelected] = useState<Id<"clients"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientContact, setClientContact] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editingAgency, setEditingAgency] = useState(false);
  const [agencyName, setAgencyName] = useState("");
  const [agencyLogo, setAgencyLogo] = useState("");

  if (dashboard === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const isOwner = dashboard.role === "owner";
  const assignedMonitorIds = new Set(
    dashboard.clients.flatMap((c) => c.websites.map((w) => w.monitorId)),
  );
  // Assignable = the acting user's own monitors that are not assigned anywhere.
  const assignable = (monitors ?? []).filter((m) => !assignedMonitorIds.has(m._id));
  const selectedClient = selected
    ? (dashboard.clients.find((c) => c._id === selected) ?? null)
    : null;

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err, fallback));
    }
  };

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            {dashboard.agency.logoUrl ? (
              <img
                src={dashboard.agency.logoUrl}
                alt=""
                className="size-10 rounded border border-border object-cover"
              />
            ) : (
              <div className="flex size-10 items-center justify-center border border-border bg-muted">
                <Building2 className="size-5 text-muted-foreground" />
              </div>
            )}
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-bold">
                {dashboard.agency.name}
                <span className="border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                  {dashboard.role}
                </span>
              </h1>
              <p className="text-sm text-muted-foreground">
                {dashboard.stats.activeClients} active client
                {dashboard.stats.activeClients === 1 ? "" : "s"} · {dashboard.stats.websites} website
                {dashboard.stats.websites === 1 ? "" : "s"} ·{" "}
                {dashboard.stats.down > 0 ? (
                  <span className="font-semibold text-red-600">{dashboard.stats.down} down</span>
                ) : (
                  "all up"
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/monitors" className="text-sm text-muted-foreground hover:underline">
              My monitors
            </Link>
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:underline">
              Dashboard
            </Link>
          </div>
        </header>

        {inviteBanner}
        {(error || globalError) && (
          <div className="flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            <XCircle className="size-4 shrink-0" /> {error ?? globalError}
          </div>
        )}

        {/* ── Clients ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Users className="size-5" /> Clients
            </h2>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="size-4"
              />
              Show archived
            </label>
          </div>

          {isOwner && (
            <div className="flex items-center gap-2 border border-border bg-muted/50 p-3">
              <Pencil className="size-4 text-muted-foreground" />
              <Input
                value={editingAgency ? agencyName : dashboard.agency.name}
                onChange={(e) => {
                  setAgencyName(e.target.value);
                  setEditingAgency(true);
                }}
                maxLength={80}
                className="max-w-xs"
                aria-label="Workspace name"
              />
              <Input
                value={editingAgency ? agencyLogo : (dashboard.agency.logoUrl ?? "")}
                onChange={(e) => {
                  setAgencyLogo(e.target.value);
                  setEditingAgency(true);
                }}
                placeholder="Logo URL"
                className="max-w-xs"
                aria-label="Workspace logo URL"
              />
              {editingAgency && (
                <Button
                  size="sm"
                  onClick={() =>
                    void run(async () => {
                      await updateAgency({
                        agencyId,
                        name: agencyName || dashboard.agency.name,
                        logoUrl: agencyLogo,
                      });
                      setEditingAgency(false);
                    }, "Could not save workspace settings.")
                  }
                >
                  Save branding
                </Button>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {(showArchived ? dashboard.clients : dashboard.clients.filter((c) => !c.archived)).map(
              (client) => (
                <Card
                  key={client._id}
                  className={client.archived ? "opacity-60" : undefined}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="text-base">{client.name}</CardTitle>
                        {client.contact && (
                          <p className="text-xs text-muted-foreground">{client.contact}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={client.archived ? "Restore client" : "Archive client"}
                          onClick={() =>
                            void run(
                              () =>
                                setArchived({
                                  agencyId,
                                  clientId: client._id,
                                  archived: !client.archived,
                                }),
                              "Could not change the archive state.",
                            )
                          }
                        >
                          {client.archived ? (
                            <ArchiveRestore className="size-4" />
                          ) : (
                            <Archive className="size-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelected(client._id)}
                        >
                          Open
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 text-sm">
                    <p className="text-xs text-muted-foreground">
                      {client.websiteCount} website{client.websiteCount === 1 ? "" : "s"}
                      {client.down > 0 && (
                        <span className="font-semibold text-red-600"> · {client.down} down</span>
                      )}
                      {client.suspect > 0 && (
                        <span className="font-semibold text-amber-600"> · {client.suspect} suspect</span>
                      )}
                      {client.latestReportAt !== null && (
                        <> · last report {timeAgo(client.latestReportAt)}</>
                      )}
                    </p>
                    {client.websites.slice(0, 3).map((w) => (
                      <div key={w.assignmentId} className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs">{w.name}</span>
                        <StatePill state={w.state} />
                      </div>
                    ))}
                    {client.websites.length > 3 && (
                      <p className="text-xs text-muted-foreground">
                        +{client.websites.length - 3} more
                      </p>
                    )}
                  </CardContent>
                </Card>
              ),
            )}
          </div>

          <Card>
            <CardContent className="flex flex-col gap-3 pt-6">
              <p className="text-sm font-medium">
                Add a client{" "}
                <span className="font-normal text-muted-foreground">
                  ({dashboard.stats.activeClients}/{MAX_CLIENTS_PER_AGENCY} active)
                </span>
              </p>
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void run(async () => {
                    await createClient({
                      agencyId,
                      name: clientName,
                      ...(clientContact.trim() ? { contact: clientContact.trim() } : {}),
                    });
                    setClientName("");
                    setClientContact("");
                  }, "Could not create the client.");
                }}
              >
                <Input
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Client name"
                  maxLength={120}
                  required
                />
                <Input
                  value={clientContact}
                  onChange={(e) => setClientContact(e.target.value)}
                  placeholder="Contact (optional)"
                  maxLength={120}
                />
                <Button type="submit" className="gap-2">
                  <Plus className="size-4" /> Add
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>

        {/* ── Client detail ───────────────────────────────────────────────── */}
        {selectedClient && (
          <section className="border-2 border-border">
            <div className="flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <Globe className="size-5" /> {selectedClient.name}
              </h2>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
            <div className="flex flex-col gap-4 p-4">
              <p className="text-xs text-muted-foreground">
                {selectedClient.contact ? `Contact: ${selectedClient.contact} · ` : ""}
                Websites{" "}
                <span className="font-medium">
                  ({selectedClient.websites.length}/{MAX_WEBSITES_PER_CLIENT})
                </span>
              </p>

              {selectedClient.websites.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No websites assigned yet. Pick one of your monitors below to attach it to this
                  client.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border border border-border">
                  {selectedClient.websites.map((w) => (
                    <li key={w.assignmentId} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{w.name}</span>
                        <a
                          href={w.url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate font-mono text-xs text-muted-foreground hover:underline"
                        >
                          {w.url}
                        </a>
                        <span className="text-[10px] text-muted-foreground">
                          checked {timeAgo(w.lastCheckedAt)}
                          {w.latestReport && (
                            <>
                              {" · "}report score {w.latestReport.score} (
                              {w.latestReport.grade}) ·{" "}
                              <Link
                                to={`/report/${w.latestReport.scanId}`}
                                className="underline hover:no-underline"
                              >
                                view report
                              </Link>
                            </>
                          )}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatePill state={w.state} />
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Remove from client"
                          onClick={() =>
                            void run(
                              () => unassignWebsite({ agencyId, websiteId: w.assignmentId }),
                              "Could not remove the website.",
                            )
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Assign one of your monitors</p>
                {assignable.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No unassigned monitors left. Create one on the{" "}
                    <Link to="/monitors" className="underline">
                      monitors page
                    </Link>{" "}
                    first — only sites you watch from your own account can be assigned.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {assignable.map((m) => (
                      <Button
                        key={m._id}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        onClick={() =>
                          void run(
                            () =>
                              assignWebsite({
                                agencyId,
                                clientId: selectedClient._id,
                                monitorId: m._id,
                              }),
                            "Could not assign the website.",
                          )
                        }
                      >
                        <Plus className="size-3.5" /> {m.name}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ── Team ────────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <ShieldCheck className="size-5" /> Team
            <span className="text-sm font-normal text-muted-foreground">
              ({members?.length ?? 0}/{MAX_MEMBERS_PER_AGENCY})
            </span>
          </h2>

          <ul className="flex flex-col divide-y divide-border border border-border">
            {(members ?? []).map((m) => (
              <li key={m.userId} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="truncate">
                  {m.name ?? m.email ?? "Member"}{" "}
                  <span className="border border-border bg-muted px-1 py-0.5 text-[10px] font-bold uppercase">
                    {m.role}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          {isOwner ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Invite a teammate</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <p className="text-muted-foreground">
                  They must sign in with the invited email account to accept — the link alone never
                  grants access.
                </p>
                <form
                  className="flex flex-col gap-2 sm:flex-row"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    void run(async () => {
                      const result = await inviteMember({ agencyId, email: inviteEmail });
                      const origin = window.location.origin;
                      setInviteLink(`${origin}/agency?invite=${result.token}`);
                      setInviteEmail("");
                    }, "Could not create the invitation.");
                  }}
                >
                  <Input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="teammate@agency.com"
                    maxLength={254}
                    required
                  />
                  <Button type="submit" className="gap-2">
                    <UserPlus className="size-4" /> Invite
                  </Button>
                </form>
                {inviteLink && (
                  <div className="flex items-center gap-2 border border-border bg-muted/50 px-3 py-2">
                    <code className="min-w-0 flex-1 truncate text-xs">{inviteLink}</code>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Copy invitation link"
                      onClick={() => void navigator.clipboard?.writeText(inviteLink)}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                )}

                {(invites ?? []).filter((i) => i.status === "pending").length > 0 && (
                  <ul className="flex flex-col divide-y divide-border border border-border">
                    {(invites ?? [])
                      .filter((i) => i.status === "pending")
                      .map((i) => (
                        <li key={i._id} className="flex items-center justify-between px-3 py-2">
                          <span className="truncate text-xs">
                            {i.email} · expires {timeAgo(i.expiresAt)}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Revoke invitation"
                            onClick={() =>
                              void run(
                                () => revokeInvite({ agencyId, inviteId: i._id }),
                                "Could not revoke the invitation.",
                              )
                            }
                          >
                            <XCircle className="size-4" />
                          </Button>
                        </li>
                      ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only the workspace owner can invite people or change branding.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
