/**
 * Hosting / web-server detection from observed response evidence.
 *
 * Recommendations that assume Apache or Nginx are wrong for most of the web:
 * plenty of sites sit behind Cloudflare, Vercel, Netlify, IIS or a CDN, and
 * telling an IIS owner to edit `.htaccess` wastes their time. A platform name
 * is only ever derived from evidence the scan actually observed (the `Server`
 * and `X-Powered-By` headers plus detected technology markers) — never
 * guessed from the TLD, the page content or the scanner's own defaults.
 */

export type HostingPlatform =
  | "nginx"
  | "openresty"
  | "apache"
  | "litespeed"
  | "iis"
  | "cloudflare"
  | "vercel"
  | "netlify"
  | "google"
  | "aws"
  | "unknown";

export const HOSTING_LABELS: Record<HostingPlatform, string> = {
  nginx: "Nginx",
  openresty: "OpenResty (Nginx-based)",
  apache: "Apache",
  litespeed: "LiteSpeed",
  iis: "Microsoft IIS",
  cloudflare: "Cloudflare",
  vercel: "Vercel",
  netlify: "Netlify",
  google: "Google hosting",
  aws: "Amazon Web Services",
  unknown: "Unknown platform",
};

/** HTTP-syntax family a platform uses for response headers. */
export type HeaderSyntax = "nginx" | "apache" | "iis" | "panel" | "neutral";

export function headerSyntaxFor(platform: HostingPlatform): HeaderSyntax {
  switch (platform) {
    case "nginx":
    case "openresty":
      return "nginx";
    case "apache":
    case "litespeed":
      return "apache";
    case "iis":
      return "iis";
    case "cloudflare":
    case "vercel":
    case "netlify":
      return "panel";
    default:
      return "neutral";
  }
}

export interface HostingEvidence {
  /** `Server` response header — null when the site suppressed it. */
  server?: string | null;
  /** `X-Powered-By` response header. */
  poweredBy?: string | null;
  /** Detected technology markers (e.g. "WordPress (detected)"). */
  technology?: string[];
}

/**
 * Identify the platform behind a site, or "unknown".
 *
 * Deliberately conservative: unknown is the honest answer whenever the
 * headers do not name a platform, and it is what the UI must default to.
 */
export function detectHostingPlatform(evidence: HostingEvidence): HostingPlatform {
  const server = (evidence.server ?? "").toLowerCase();
  const poweredBy = (evidence.poweredBy ?? "").toLowerCase();
  const technology = (evidence.technology ?? []).join(" ").toLowerCase();
  const haystack = `${server} ${poweredBy}`;

  // Order matters: a Cloudflare-fronted Nginx reports "cloudflare" as its
  // Server header, and the panel/CDN is where the owner must act.
  if (haystack.includes("cloudflare") || technology.includes("cloudflare")) return "cloudflare";
  if (haystack.includes("vercel")) return "vercel";
  if (haystack.includes("netlify")) return "netlify";
  if (haystack.includes("gws") || haystack.includes("google frontend") || haystack.includes("gse"))
    return "google";
  if (haystack.includes("amazons3") || haystack.includes("aws")) return "aws";
  if (haystack.includes("openresty")) return "openresty";
  if (haystack.includes("nginx")) return "nginx";
  if (haystack.includes("litespeed")) return "litespeed";
  if (haystack.includes("apache")) return "apache";
  if (haystack.includes("microsoft-iis") || haystack.includes("iis")) return "iis";

  return "unknown";
}


