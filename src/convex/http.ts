import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { internal } from "./_generated/api";
import { isValidReturnPath } from "../lib/githubRepair";

const http = httpRouter();

auth.addHttpRoutes(http);

// ── Phase 5 — GitHub OAuth callback (server-side exchange boundary) ──────────
// The browser lands here from GitHub. The one-time `state` is redeemed first,
// the `code` is exchanged for the access token by an internal action (client
// secret stays on the server; the token never appears in a URL or response),
// and the browser is bounced back into the app on the same-origin path the
// user started from. `?github=connected` / `?github=error:<code>` is the only
// signal the UI reads — no token ever travels back to the client.
http.route({
  path: "/github/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";

    let ok = false;
    let returnPath = "/";
    let errorCode = "missing_parameters";
    if (code && state) {
      try {
        const result = await ctx.runAction(internal.githubActions.exchangeOAuthCode, {
          code,
          state,
        });
        ok = result.ok;
        // Re-validate even though startConnection already did — redirects are
        // never built from anything but a same-origin path.
        returnPath = isValidReturnPath(result.returnPath) ? result.returnPath : "/";
        errorCode = result.error ?? "unknown_error";
      } catch {
        ok = false;
        errorCode = "exchange_failed";
      }
    }

    const base = (process.env.CONVEX_SITE_URL || url.origin).replace(/\/+$/, "");
    const destination = new URL(returnPath, base);
    destination.searchParams.set("github", ok ? "connected" : `error:${errorCode}`);
    return new Response(null, {
      status: 302,
      headers: { Location: destination.toString() },
    });
  }),
});

export default http;
