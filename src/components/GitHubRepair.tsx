import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { friendlyError } from "@/lib/userErrors";
import type { Id } from "../convex/_generated/dataModel";
import {
  AlertCircle,
  CheckCircle2,
  FileCode2,
  FolderGit2,
  Github,
  GitPullRequest,
  Link2,
  Loader2,
  Unlink,
} from "lucide-react";
import { GITHUB_REPAIR_NOTICE, type RepoInfo } from "../lib/githubRepair";
import type { FixProposal } from "../lib/fixProposal";

/* ── GitHub Repair (Phase 5) ─────────────────────────────────────────────────
 * Sits inside the Fix Proposals panel. Workflow, one explicit step at a time:
 *   finding → connect GitHub → pick repository + branch → analyze → review
 *   diff → approve THAT proposal → request PR creation.
 * Writes are disabled unless the deployment opts in (GITHUB_WRITE_ENABLED);
 * the UI states that honestly instead of pretending a PR always opens.
 */

type AnalyzeView =
  | {
      kind: "ok";
      proposalId: Id<"repairProposals">;
      targetPath: string;
      fileExisted: boolean;
      diff: string;
      explanation: string;
    }
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; message: string };

const GITHUB_ERROR_TEXT: Record<string, string> = {
  invalid_state:
    "GitHub could not verify this sign-in (state mismatch or expired) — try connecting again.",
  not_configured: "GitHub is not configured on this deployment yet.",
  exchange_failed: "GitHub did not accept the sign-in code — try connecting again.",
  user_lookup_failed: "GitHub signed you in but the account could not be read — try again.",
  missing_parameters: "GitHub returned to the callback without a sign-in code — try connecting again.",
};

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 border-2 border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function DiffBox({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto border-2 border-[#1a1a1a] bg-[#FAFAF5] px-3 py-2 font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((line, i) => {
        const style =
          line.startsWith("+") && !line.startsWith("+++")
            ? "text-emerald-800 bg-emerald-50"
            : line.startsWith("-") && !line.startsWith("---")
              ? "text-red-800 bg-red-50"
              : line.startsWith("---") || line.startsWith("+++")
                ? "font-bold text-[#1a1a1a]/70"
                : line.startsWith("@@")
                  ? "text-sky-800 bg-sky-50"
                  : "text-[#1a1a1a]/60";
        return (
          <div key={i} className={style}>
            {line || "\u00A0"}
          </div>
        );
      })}
    </pre>
  );
}

const STATUS_PILL: Record<string, string> = {
  draft: "border-[#1a1a1a]/20 bg-white text-[#1a1a1a]/55",
  pr_requested: "border-amber-300 bg-amber-50 text-amber-700",
  pr_created: "border-emerald-300 bg-emerald-50 text-emerald-700",
};

/** Analyzed result inline under its finding: real diff + honest labels. */
function AnalyzeResult({ view }: { view: Extract<AnalyzeView, { kind: "ok" }> }) {
  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold">
        <span className="border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-mono text-sky-800">
          {view.targetPath}
        </span>
        <span
          className={`border px-1.5 py-0.5 uppercase ${
            view.fileExisted
              ? "border-emerald-300 bg-emerald-50 text-emerald-700"
              : "border-amber-300 bg-amber-50 text-amber-700"
          }`}
        >
          {view.fileExisted ? "verified diff · file read" : "creates new file"}
        </span>
        <span className="text-[#1a1a1a]/40">read-only analysis · nothing written</span>
      </div>
      <DiffBox diff={view.diff} />
      <p className="text-[11px] leading-relaxed text-[#1a1a1a]/65">{view.explanation}</p>
    </div>
  );
}

export default function GitHubRepair({
  scanId,
  proposals,
}: {
  scanId: Id<"scans">;
  proposals: FixProposal[];
}) {
  const connection = useQuery(api.github.getConnection);
  const stored = useQuery(api.github.listProposals, { scanId });
  const startConnection = useMutation(api.github.startConnection);
  const disconnect = useMutation(api.github.disconnect);
  const approveAndRequestPr = useMutation(api.github.approveAndRequestPr);
  const listRepositories = useAction(api.githubActions.listRepositories);
  const listBranches = useAction(api.githubActions.listBranches);
  const analyzeRepair = useAction(api.githubActions.analyzeRepair);
  const createPullRequest = useAction(api.githubActions.createPullRequest);

  const [oauthNotice, setOauthNotice] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [repo, setRepo] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, AnalyzeView>>({});
  const [prResults, setPrResults] = useState<Record<string, string>>({});

  // Read the OAuth round-trip result once, then clean the URL.
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("github");
    if (!flag) return;
    if (flag === "connected") {
      setOauthNotice("GitHub connected — your repositories are ready to select.");
    } else {
      setOauthNotice(
        GITHUB_ERROR_TEXT[flag.replace(/^error:/, "")] ?? `GitHub connection failed (${flag}).`,
      );
    }
    const cleaned = new URL(window.location.href);
    cleaned.searchParams.delete("github");
    window.history.replaceState({}, "", cleaned.toString());
  }, []);

  const connect = async () => {
    setBusy("connect");
    setConnectError(null);
    try {
      const res = await startConnection({ returnPath: window.location.pathname });
      window.location.href = res.authorizeUrl;
    } catch (err) {
      if (
        err instanceof ConvexError &&
        (err.data as { code?: string })?.code === "github_not_configured"
      ) {
        setConnectError("GitHub is not configured on this deployment yet (manual setup required).");
      } else {
        setConnectError(friendlyError(err, "Could not start the GitHub connection."));
      }
      setBusy(null);
    }
  };

  const quotaText = (retryAfterMs: number, limit: number): string => {
    const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
    return `GitHub request limit reached (${limit}/hour). Try again in about ${minutes} minute(s).`;
  };

  const loadRepos = async () => {
    setBusy("repos");
    setActionError(null);
    try {
      const res = await listRepositories();
      if (res.kind === "ok") setRepos(res.repos);
      else if (res.kind === "not_connected") setActionError("Connect GitHub first.");
      else if (res.kind === "quota_limited") setActionError(quotaText(res.retryAfterMs, res.limit));
      else setActionError(res.message);
    } catch (err) {
      setActionError(friendlyError(err, "Could not list repositories."));
    } finally {
      setBusy(null);
    }
  };

  const selectRepo = async (fullName: string, defaultBranch: string) => {
    setRepo(fullName);
    setBranch(defaultBranch);
    setBranches(null);
    setBusy(`branches:${fullName}`);
    setActionError(null);
    try {
      const res = await listBranches({ repoFullName: fullName });
      if (res.kind === "ok") {
        setBranches(res.branches);
        if (res.branches.length > 0 && !res.branches.includes(defaultBranch)) {
          setBranch(res.branches[0]);
        }
      } else if (res.kind === "not_connected") {
        setActionError("Connect GitHub first.");
      } else if (res.kind === "quota_limited") {
        setActionError(quotaText(res.retryAfterMs, res.limit));
      } else {
        setActionError(res.message);
      }
    } catch (err) {
      setActionError(friendlyError(err, "Could not list branches."));
    } finally {
      setBusy(null);
    }
  };

  const analyze = async (proposal: FixProposal) => {
    if (!repo || !branch) return;
    setBusy(proposal.key);
    setActionError(null);
    try {
      const res = await analyzeRepair({
        scanId,
        issueKey: proposal.key,
        repoFullName: repo,
        branch,
      });
      const view: AnalyzeView =
        res.kind === "ok"
          ? res
          : res.kind === "unsupported"
            ? { kind: "unsupported", reason: res.reason }
            : res.kind === "quota_limited"
              ? { kind: "failed", message: quotaText(res.retryAfterMs, res.limit) }
              : res.kind === "not_connected"
                ? { kind: "failed", message: "Connect GitHub first." }
                : res.kind === "not_found"
                  ? {
                      kind: "failed",
                      message: "This report or finding could not be found — re-run Fix Proposals.",
                    }
                  : { kind: "failed", message: res.message };
      setAnalyses((prev) => ({ ...prev, [proposal.key]: view }));
    } catch (err) {
      setAnalyses((prev) => ({
        ...prev,
        [proposal.key]: {
          kind: "failed",
          message: friendlyError(err, "Analysis failed."),
        },
      }));
    } finally {
      setBusy(null);
    }
  };

  const approve = async (proposalId: Id<"repairProposals">, confirmRepoFullName: string) => {
    setBusy(`approve:${proposalId}`);
    setActionError(null);
    try {
      await approveAndRequestPr({ proposalId, confirmRepoFullName });
    } catch (err) {
      setActionError(friendlyError(err, "Approval failed."));
    } finally {
      setBusy(null);
    }
  };

  const requestPr = async (proposalId: Id<"repairProposals">) => {
    setBusy(`pr:${proposalId}`);
    setActionError(null);
    try {
      const res = await createPullRequest({ proposalId });
      setPrResults((prev) => ({
        ...prev,
        [proposalId]:
          res.kind === "ok"
            ? `Pull request #${res.prNumber} created on branch \`${res.branchName}\`: ${res.prUrl}`
            : res.message,
      }));
    } catch (err) {
      setPrResults((prev) => ({
        ...prev,
        [proposalId]: friendlyError(err, "Pull-request request failed."),
      }));
    } finally {
      setBusy(null);
    }
  };

  const connected = connection?.connected === true;

  return (
    <div className="mt-4 border-2 border-[#1a1a1a] bg-[#FFFBF0]">
      <div className="flex items-center gap-2 border-b-2 border-[#1a1a1a] bg-[#E0E7FF] px-4 py-2.5">
        <Github className="size-4" strokeWidth={2.5} />
        <span className="text-sm font-black">GitHub Repair</span>
        <span className="border border-[#1a1a1a]/20 bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#1a1a1a]/50">
          Code-aware · read-only until you approve
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-[11px] leading-relaxed text-[#1a1a1a]/55">{GITHUB_REPAIR_NOTICE}</p>

        {oauthNotice && (
          <div className="border-2 border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            {oauthNotice}
          </div>
        )}
        {connectError && <ErrorBox message={connectError} />}
        {actionError && <ErrorBox message={actionError} />}

        {/* Connection status */}
        {connection === undefined ? (
          <p className="text-xs text-[#1a1a1a]/50">Checking GitHub connection…</p>
        ) : !connection.connected ? (
          connection.configured ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => void connect()}
                disabled={busy === "connect"}
                className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-3.5 py-2 text-xs font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:bg-[#FCD34D] hover:shadow-[1px_1px_0px_0px_#1a1a1a] disabled:opacity-50"
              >
                {busy === "connect" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Link2 className="size-3.5" />
                )}
                Connect GitHub
              </button>
              <span className="text-[10px] font-bold text-[#1a1a1a]/45">
                Public repositories only (scope: public_repo) · sign-in handled by GitHub
              </span>
            </div>
          ) : (
            <div className="border-2 border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
              GitHub is not configured on this deployment, so connections are unavailable. Manual
              setup: create a GitHub OAuth App with callback{" "}
              <code className="font-mono">&lt;site url&gt;/github/callback</code>, then set{" "}
              <code className="font-mono">GITHUB_CLIENT_ID</code> and{" "}
              <code className="font-mono">GITHUB_CLIENT_SECRET</code> on this deployment. Enabling
              pull-request writes additionally requires{" "}
              <code className="font-mono">GITHUB_WRITE_ENABLED=true</code>.
            </div>
          )
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-[#1a1a1a] bg-white px-3 py-2">
            <span className="flex flex-wrap items-center gap-2 text-xs font-bold">
              <CheckCircle2 className="size-4 text-emerald-600" />
              Connected as <span className="font-mono">{connection.login}</span>
              <span className="border border-[#1a1a1a]/15 bg-[#FFFBF0] px-1.5 py-0.5 text-[10px] text-[#1a1a1a]/55">
                scope: {connection.scopes || "none"}
              </span>
            </span>
            <button
              onClick={() => void disconnect()}
              className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-white px-2.5 py-1 text-[11px] font-bold transition-colors hover:bg-red-50"
            >
              <Unlink className="size-3" /> Disconnect
            </button>
          </div>
        )}

        {connection && !connection.writeEnabled && (
          <p className="border border-[#1a1a1a]/15 bg-white px-3 py-2 text-[10px] leading-relaxed text-[#1a1a1a]/55">
            Pull-request creation is <span className="font-bold">disabled on this deployment</span>{" "}
            — you can connect, analyze, review diffs and record approvals; the PR request will return
            an honest notice until write access is configured and verified.
          </p>
        )}

        {/* Repository + branch selection */}
        {connected && (
          <div className="space-y-2">
            {repos === null ? (
              <button
                onClick={() => void loadRepos()}
                disabled={busy === "repos"}
                className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-white px-3 py-1.5 text-xs font-bold transition-colors hover:bg-[#E0E7FF] disabled:opacity-50"
              >
                {busy === "repos" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FolderGit2 className="size-3.5" />
                )}
                Load my repositories
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
                  Repository
                </label>
                <select
                  value={repo}
                  onChange={(e) => {
                    const match = repos.find((r) => r.fullName === e.target.value);
                    if (match) void selectRepo(match.fullName, match.defaultBranch);
                  }}
                  className="border-2 border-[#1a1a1a] bg-white px-2 py-1.5 font-mono text-xs"
                >
                  <option value="">Select a repository…</option>
                  {repos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                      {r.private ? " (private)" : ""}
                    </option>
                  ))}
                </select>
                {repo && (
                  <>
                    <label className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
                      Branch
                    </label>
                    <select
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                      className="border-2 border-[#1a1a1a] bg-white px-2 py-1.5 font-mono text-xs"
                      disabled={branches === null || busy?.startsWith("branches:")}
                    >
                      {branches === null ? (
                        <option>Loading…</option>
                      ) : (
                        branches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))
                      )}
                    </select>
                    {busy?.startsWith("branches:") && <Loader2 className="size-3.5 animate-spin" />}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Findings → analyze */}
        {connected && repo && branch && (
          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
              Analyze a finding in this repository
            </p>
            {proposals.map((p) => {
              const view = analyses[p.key];
              return (
                <div key={p.key} className="border-2 border-[#1a1a1a] bg-white">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1a1a1a]/10 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2 text-xs font-bold">
                      <FileCode2 className="size-3.5 shrink-0 text-[#1a1a1a]/40" />
                      <span className="truncate">{p.message}</span>
                    </span>
                    <button
                      onClick={() => void analyze(p)}
                      disabled={busy === p.key}
                      className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-[#E0E7FF] px-2.5 py-1 text-[11px] font-bold transition-colors hover:bg-[#C7D2FE] disabled:opacity-50"
                    >
                      {busy === p.key && <Loader2 className="size-3 animate-spin" />}
                      {view ? "Analyze again" : "Analyze files"}
                    </button>
                  </div>

                  {view?.kind === "unsupported" && (
                    <div className="px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                      <span className="font-black uppercase">Manual fix required — </span>
                      {view.reason}
                    </div>
                  )}
                  {view?.kind === "failed" && (
                    <div className="px-3 py-2">
                      <ErrorBox message={view.message} />
                    </div>
                  )}
                  {view?.kind === "ok" && <AnalyzeResult view={view} />}
                </div>
              );
            })}
          </div>
        )}

        {/* Stored proposals + approval status */}
        {stored && stored.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
              Proposals awaiting your review
            </p>
            {stored.map((p) => {
              const prResult = prResults[p.id];
              return (
                <div key={p.id} className="border-2 border-[#1a1a1a] bg-white px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-bold">{p.findingMessage}</span>
                    <span className="border border-[#1a1a1a]/15 bg-[#FFFBF0] px-1.5 py-0.5 font-mono text-[10px]">
                      {p.repoFullName}@{p.branch}
                    </span>
                    <span
                      className={`border px-1.5 py-0.5 text-[9px] font-black uppercase ${
                        STATUS_PILL[p.status] ?? STATUS_PILL.draft
                      }`}
                    >
                      {p.status.replace("_", " ")}
                    </span>
                    {p.expired && (
                      <span className="text-[10px] font-bold text-red-600">
                        expired — analyze again
                      </span>
                    )}
                  </div>

                  {!p.fileExisted && (
                    <p className="mt-1 text-[10px] text-[#1a1a1a]/50">
                      This proposal creates <code className="font-mono">{p.targetPath}</code>.
                    </p>
                  )}

                  <div className="mt-2">
                    <DiffBox diff={p.diff} />
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[#1a1a1a]/65">
                    {p.explanation}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {p.status === "draft" && !p.expired && (
                      <button
                        onClick={() => void approve(p.id, p.repoFullName)}
                        disabled={busy === `approve:${p.id}`}
                        className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-[#FDE68A] px-3 py-1.5 text-[11px] font-black transition-colors hover:bg-[#FCD34D] disabled:opacity-50"
                      >
                        {busy === `approve:${p.id}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <GitPullRequest className="size-3" />
                        )}
                        Approve &amp; request PR for {p.repoFullName}
                      </button>
                    )}
                    {p.status === "pr_requested" && (
                      <button
                        onClick={() => void requestPr(p.id)}
                        disabled={busy === `pr:${p.id}`}
                        className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-[#E0E7FF] px-3 py-1.5 text-[11px] font-black transition-colors hover:bg-[#C7D2FE] disabled:opacity-50"
                      >
                        {busy === `pr:${p.id}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <GitPullRequest className="size-3" />
                        )}
                        Create pull request
                      </button>
                    )}
                    {p.status === "pr_created" && p.prUrl && (
                      <a
                        href={p.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-emerald-100 px-3 py-1.5 text-[11px] font-black text-emerald-800 transition-colors hover:bg-emerald-200"
                      >
                        View pull request #{p.prNumber} →
                      </a>
                    )}
                    {p.prBranch && (
                      <span className="font-mono text-[10px] text-[#1a1a1a]/45">
                        branch: {p.prBranch}
                      </span>
                    )}
                  </div>

                  {prResult && (
                    <p className="mt-2 border border-[#1a1a1a]/15 bg-[#FFFBF0] px-2.5 py-1.5 text-[11px] text-[#1a1a1a]/70">
                      {prResult}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
