import { query } from "./_generated/server";
import { providerMode, simulatedBillingEnabled } from "./billing";
import { configuredSenderIsVerified } from "../lib/alerts";

// ── Phase 9B: integration readiness (configuration checks only) ──────────────
// One read-only query that tells an operator (or the pricing page) which
// external integrations this deployment is actually configured for.
//
// SECURITY: every field is a BOOLEAN derived from the presence/shape of an
// environment variable — no key, secret, URL or passcode value is ever read
// into the response. Fail-closed semantics everywhere: missing config reads
// as `false` (not configured), never as an error that could leak details.

export const getIntegrationStatus = query({
  args: {},
  handler: async () => {
    const mode = providerMode();
    return {
      github: {
        // OAuth app credentials present (the flow also needs CONVEX_SITE_URL
        // for the redirect; included in the readiness boolean).
        configured: Boolean(
          process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
        ),
        redirectConfigured: /^https?:\/\//.test(process.env.CONVEX_SITE_URL ?? ""),
        // GitHub WRITES (pull-request creation) are OFF unless the operator
        // explicitly enables them — default disabled.
        writeEnabled: process.env.GITHUB_WRITE_ENABLED === "true",
      },
      billing: {
        // Test-mode-only posture: true means a `sk_test_` / `rzp_test_` key
        // is present; live keys are refused everywhere and never count here.
        stripe: mode.stripe,
        razorpay: mode.razorpay,
        stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
        razorpayWebhookConfigured: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET),
        // The simulated provider can mint paid access by design, so it is
        // opt-in per deployment and DISABLED by default.
        simulatedEnabled: simulatedBillingEnabled(),
      },
      email: {
        resendConfigured: Boolean(process.env.RESEND_API_KEY),
        // Sender override configured under either supported name
        // (RESEND_FROM_EMAIL canonical, RESEND_FROM legacy). Value is
        // deliberately NOT echoed — presence only.
        customFromConfigured: Boolean(
          process.env.RESEND_FROM_EMAIL?.trim() ||
            process.env.RESEND_FROM?.trim(),
        ),
        // Whether the sender the deployment would actually use (resolved
        // value, or the verified default when unset) sits on the Resend-
        // verified subdomain. A BOOLEAN derived from the env values — the
        // configured address itself is never echoed. False means sends would
        // come from (or fall back around) an unverified domain and the
        // operator must fix the env var.
        fromOnVerifiedDomain: configuredSenderIsVerified([
          process.env.RESEND_FROM_EMAIL,
          process.env.RESEND_FROM,
        ]),
      },
    };
  },
});
