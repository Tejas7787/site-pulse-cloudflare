import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Link, useSearchParams } from "react-router";
import { format } from "date-fns";
import {
  BadgeCheck,
  Check,
  CreditCard,
  Loader2,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { api } from "../convex/_generated/api";
import { friendlyError } from "@/lib/userErrors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  PLANS,
  formatPlanPrice,
  type Currency,
  type PlanId,
} from "@/lib/billing/plans";

// ── /pricing — Phase 7: plans, entitlements and billing controls ─────────────
// Everything price- and plan-related shown here comes from the server (the
// catalog is rendered by the backend query, amounts are recomputed server-side
// on checkout). Payment runs through the SIMULATED provider in this deployment
// (clearly labeled, no money moves); when Stripe test-mode credentials are
// configured, a real hosted checkout button appears and activation still
// waits for the signature-verified webhook.

const STATUS_STYLES: Record<string, string> = {
  active: "border-emerald-300 bg-emerald-50 text-emerald-700",
  trialing: "border-sky-300 bg-sky-50 text-sky-700",
  past_due: "border-amber-300 bg-amber-50 text-amber-700",
  canceled: "border-border bg-muted text-muted-foreground",
  expired: "border-border bg-muted text-muted-foreground",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_STYLES[status] ?? STATUS_STYLES.expired}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function defaultCurrency(): Currency {
  const locale = typeof navigator !== "undefined" ? navigator.language : "";
  return locale.endsWith("-IN") || locale === "hi" ? "INR" : "USD";
}

export default function Pricing() {
  const [searchParams] = useSearchParams();
  const checkoutParam = searchParams.get("checkout");

  const billing = useQuery(api.billing.getMySubscription);
  const startCheckout = useMutation(api.billing.startCheckout);
  const completeCheckout = useMutation(api.billing.completeSimulatedCheckout);
  const cancelSubscription = useMutation(api.billing.cancelSubscription);
  const resumeSubscription = useMutation(api.billing.resumeSubscription);
  const startStripeCheckout = useAction(api.billingActions.startStripeCheckout);
  const startRazorpayCheckout = useAction(api.billingActions.startRazorpayCheckout);

  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [pending, setPending] = useState<{
    checkoutId: string;
    plan: PlanId;
    amount: number;
    currency: Currency;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (billing === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }
  if (billing === null) {
    // RequireAuth normally prevents this; fail closed rather than render
    // billing controls without an authenticated account.
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Sign in to view plans and billing.
      </main>
    );
  }

  const subscription = billing.subscription;
  const entitlements = billing.entitlements;
  const mode = billing.billingMode;

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(friendlyError(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const payWithStripe = async (plan: PlanId) => {
    if (plan !== "pro" && plan !== "agency") return; // free needs no checkout
    setBusy(true);
    setError(null);
    try {
      const result = await startStripeCheckout({ plan, currency });
      if (result.ok) {
        window.location.assign(result.url);
        return;
      }
      setError(`Stripe checkout is unavailable (${result.reason}) — use the simulated flow instead.`);
    } catch {
      setError("Stripe checkout could not be started — use the simulated flow instead.");
    } finally {
      setBusy(false);
    }
  };

  // Razorpay's hosted widget (checkout.js) — the payment UI itself is
  // Razorpay-hosted; the server already created the subscription and only
  // hands back the PUBLIC key id + subscription id.
  const payWithRazorpay = async (plan: PlanId) => {
    if (plan !== "pro" && plan !== "agency") return;
    setBusy(true);
    setError(null);
    try {
      const result = await startRazorpayCheckout({ plan, currency });
      if (!result.ok) {
        setError(`Razorpay checkout is unavailable (${result.reason}) — no charge was made.`);
        return;
      }
      const loaded = await new Promise<boolean>((resolve) => {
        const existing = document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
        if (existing || (window as unknown as { Razorpay?: unknown }).Razorpay) {
          resolve(true);
          return;
        }
        const script = document.createElement("script");
        script.src = "https://checkout.razorpay.com/v1/checkout.js";
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.body.appendChild(script);
      });
      if (!loaded || !(window as unknown as { Razorpay?: new (o: Record<string, unknown>) => { open: () => void } }).Razorpay) {
        setError("Razorpay's checkout widget could not be loaded — no charge was made. Try again shortly.");
        return;
      }
      const RazorpayCtor = (window as unknown as { Razorpay: new (o: Record<string, unknown>) => { open: () => void } }).Razorpay;
      const widget = new RazorpayCtor({
        key: result.keyId,
        subscription_id: result.subscriptionId,
        name: "SitePulse",
        description: `${plan === "pro" ? "Pro" : "Agency"} plan (${result.currency})`,
        theme: { color: "#1a1a1a" },
        handler: () => {
          setNotice(
            "Payment submitted — your plan activates once Razorpay's signed webhook confirms it (usually a few seconds).",
          );
        },
      });
      widget.open();
    } catch {
      setError("Razorpay checkout could not be started — no charge was made.");
    } finally {
      setBusy(false);
    }
  };

  const beginCheckout = async (plan: PlanId) => {
    if (plan !== "pro" && plan !== "agency") return; // free needs no checkout
    // Phase 9B: route by what this deployment is actually configured for.
    // The simulated flow only exists when the operator explicitly enabled it
    // (SITEPULSE_SIMULATED_BILLING=true); otherwise prefer a real test-mode
    // provider, and refuse honestly when none exists.
    if (!mode.simulated) {
      if (mode.stripe) return payWithStripe(plan);
      if (mode.razorpay) return payWithRazorpay(plan);
      setError(
        "Billing is not configured on this deployment — no test-mode payment provider is available yet.",
      );
      return;
    }
    await run(async () => {
      const result = await startCheckout({ plan, currency });
      setPending({
        checkoutId: result.checkoutId as string,
        plan,
        amount: result.amount,
        currency: result.currency as Currency,
      });
      setNotice(null);
    }, "Could not start the checkout.");
  };

  const completePending = async (outcome: "succeeded" | "failed") => {
    if (!pending) return;
    await run(async () => {
      const result = await completeCheckout({ checkoutId: pending.checkoutId as never, outcome });
      const paidThrough = (result as { currentPeriodEnd?: number }).currentPeriodEnd;
      if (result.ok && typeof paidThrough === "number") {
        setNotice(
          `Payment confirmed — you are on the ${String(result.plan).toUpperCase()} plan until ${format(paidThrough, "d MMM yyyy")}.`,
        );
        setPending(null);
      } else {
        setPending(null);
        setError("The simulated payment failed — no subscription changes were made. Try again.");
      }
    }, "Could not complete the simulated checkout.");
  };

  const planCard = (planId: PlanId) => {
    const plan = PLANS[planId];
    const isCurrent = entitlements.plan === planId;
    const price = formatPlanPrice(planId, currency);
    const rows: { label: string; value: string; ok: boolean }[] = [
      { label: "Uptime monitors", value: String(plan.limits.monitors), ok: true },
      { label: "Saved scans / month", value: String(plan.limits.savedScansPerMonth), ok: true },
      { label: "Agency clients", value: String(plan.limits.agencyClients), ok: true },
      { label: "Team members", value: String(plan.limits.teamMembers), ok: true },
      {
        label: "GitHub Repair Agent",
        value: plan.limits.repairFeatures ? "Included" : "Not included",
        ok: plan.limits.repairFeatures,
      },
    ];
    return (
      <Card
        key={planId}
        className={isCurrent ? "border-2 border-border shadow-sm" : undefined}
      >
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{plan.name}</CardTitle>
            {isCurrent && (
              <span className="flex items-center gap-1 border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                <BadgeCheck className="size-3" /> Current
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{plan.tagline}</p>
          <p className="pt-2 text-2xl font-bold">
            {price}
            <span className="text-sm font-normal text-muted-foreground">/month</span>
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1.5 text-sm">
            {rows.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{row.label}</span>
                <span className={`flex items-center gap-1 font-medium ${row.ok ? "" : "text-red-600"}`}>
                  {row.ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                  {row.value}
                </span>
              </li>
            ))}
          </ul>
          {planId === "free" ? (
            subscription ? (
              <Button
                variant="outline"
                disabled={busy || subscription.cancelAtPeriodEnd}
                onClick={() => void run(async () => await cancelSubscription({}), "Could not cancel.")}
                className="gap-2"
              >
                <PauseCircle className="size-4" />
                {subscription.cancelAtPeriodEnd ? "Cancels at period end" : "Cancel & return to Free"}
              </Button>
            ) : (
              <Button variant="outline" disabled>
                Your current plan
              </Button>
            )
          ) : isCurrent ? (
            <Button variant="outline" disabled>
              Your current plan
            </Button>
          ) : (
            <Button
              onClick={() => void beginCheckout(planId)}
              disabled={busy}
              className="gap-2"
            >
              <CreditCard className="size-4" />
              {subscription ? `Switch to ${plan.name}` : `Upgrade to ${plan.name}`}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:underline">
              ← Dashboard
            </Link>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <CreditCard className="size-6" /> Plans &amp; billing
            </h1>
            <p className="text-sm text-muted-foreground">
              Pick the plan that fits how many sites you watch. Limits are enforced server-side.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <span className="flex items-center gap-1.5 border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-bold uppercase text-amber-800">
              <ShieldCheck className="size-3.5" /> Test mode — no real charges
            </span>
            <div className="flex items-center gap-1">
              {(["INR", "USD"] as Currency[]).map((c) => (
                <Button
                  key={c}
                  size="sm"
                  variant={currency === c ? "default" : "outline"}
                  className="h-7 px-3 text-xs"
                  onClick={() => setCurrency(c)}
                >
                  {c === "INR" ? "₹ INR" : "$ USD"}
                </Button>
              ))}
            </div>
          </div>
        </header>

        {checkoutParam === "success" && (
          <div className="flex items-center gap-2 border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            <Check className="size-4 shrink-0" /> Payment submitted — your plan activates once the
            payment webhook confirms it (usually a few seconds).
          </div>
        )}
        {checkoutParam === "canceled" && (
          <div className="flex items-center gap-2 border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            <XCircle className="size-4 shrink-0" /> Checkout canceled — you have not been charged.
          </div>
        )}
        {notice && (
          <div className="flex items-center gap-2 border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            <Check className="size-4 shrink-0" /> {notice}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            <XCircle className="size-4 shrink-0" /> {error}
          </div>
        )}

        {/* ── Current subscription ─────────────────────────────────────── */}
        {subscription && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <BadgeCheck className="size-4" /> Your subscription
                <StatusPill status={subscription.status} />
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p>
                <span className="font-semibold">{PLANS[subscription.plan as PlanId]?.name ?? subscription.plan}</span>{" "}
                · {formatPlanPrice(subscription.plan as PlanId, subscription.currency)} /month ·{" "}
                {subscription.provider === "simulated" ? (
                  <span className="border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase">
                    Simulated payment
                  </span>
                ) : (
                  <span className="border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase">
                    {subscription.provider} (test mode)
                  </span>
                )}
              </p>
              <p className="text-muted-foreground">
                {subscription.cancelAtPeriodEnd ? (
                  <>
                    Access ends on{" "}
                    <span className="font-medium text-foreground">
                      {format(subscription.currentPeriodEnd, "d MMM yyyy")}
                    </span>{" "}
                    — you will move to the Free plan then.
                  </>
                ) : (
                  <>
                    Paid through{" "}
                    <span className="font-medium text-foreground">
                      {format(subscription.currentPeriodEnd, "d MMM yyyy")}
                    </span>{" "}
                    (monthly, auto-renews while active).
                  </>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                {subscription.cancelAtPeriodEnd ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={() => void run(async () => await resumeSubscription({}), "Could not resume.")}
                  >
                    <PlayCircle className="size-3.5" /> Keep my subscription
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground"
                    disabled={busy}
                    onClick={() => void run(async () => await cancelSubscription({}), "Could not cancel.")}
                  >
                    <PauseCircle className="size-3.5" /> Cancel at period end
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">
                  {billing.usage.monitors}/{entitlements.limits.monitors} monitors ·{" "}
                  {billing.usage.savedScansThisMonth}/{entitlements.limits.savedScansPerMonth} saved
                  scans this month
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Simulated checkout ───────────────────────────────────────── */}
        {pending && (
          <Card className="border-2 border-amber-300">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4 text-amber-700" /> Simulated checkout — TEST MODE
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p className="text-muted-foreground">
                {PLANS[pending.plan].name} · {formatPlanPrice(pending.plan, pending.currency)}/month in{" "}
                {pending.currency}. No real payment processor is connected in this deployment, so no
                money moves — completing below simulates the provider confirming your payment
                server-side.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  className="gap-2"
                  onClick={() => void completePending("succeeded")}
                >
                  <Check className="size-4" /> Simulate successful payment
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void completePending("failed")}
                >
                  Simulate failed payment
                </Button>
                {mode.stripe && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void payWithStripe(pending.plan)}
                  >
                    Use Stripe hosted checkout (test mode)
                  </Button>
                )}
                {mode.razorpay && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void payWithRazorpay(pending.plan)}
                  >
                    Use Razorpay hosted checkout (test mode)
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
                  Abort
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                A failed payment never changes your plan. When Stripe/Razorpay test-mode credentials
                are configured, this flow is replaced by their hosted checkout and activation waits
                for the signed webhook.
              </p>
            </CardContent>
          </Card>
        )}

        {/* ── Plans ────────────────────────────────────────────────────── */}
        <section className="grid gap-4 sm:grid-cols-3">{(Object.keys(PLANS) as PlanId[]).map(planCard)}</section>

        <p className="text-xs text-muted-foreground">
          Prices are introductory and billed monthly in {currency}. Plan limits are enforced by the
          server on every action — upgrading never changes health scores or report grades.
          {mode.simulated && !mode.stripe && !mode.razorpay &&
            " Real provider checkout is not configured yet; simulated payments are in use."}
          {!mode.simulated && !mode.stripe && !mode.razorpay &&
            " No payment provider is configured on this deployment yet (test-mode Stripe or Razorpay keys required)."}
          {mode.stripe && " Stripe test-mode checkout is configured."}
          {mode.razorpay && " Razorpay test-mode checkout is configured."}
        </p>
      </div>
    </main>
  );
}
