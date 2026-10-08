// Shared type definitions for SitePulse scan results

export type Severity = "critical" | "warning" | "info";
export type Priority = "critical" | "important" | "recommended" | "nice-to-have";
// Five check states:
//  - "pass" / "fail" / "warn": evaluated against observed evidence
//  - "not-checked": Unable to Verify (evidence unavailable: blocked, non-HTML,
//    incomplete response, or the check needs a browser engine we do not have)
//  - "na": Not Applicable (the check does not apply to this target, e.g. HSTS on
//    a plain-HTTP site, or cookie flags when no cookies were set)
export type CheckResult = "pass" | "fail" | "warn" | "not-checked" | "na";

export type FindingStatus = "fail" | "warning" | "unable-to-verify";
export type DetectionMethod = "http" | "tls" | "browser";

export interface FindingEvidence {
  /** The exact observed evidence (header name/value, DOM fact, measured metric…). */
  evidence: string;
  /** URL the evidence was collected from (usually the final URL). */
  evidenceUrl?: string;
  /** Scan stage: fetch | headers | html | tls | cookies. */
  stage?: string;
  /** Which detection method produced this result. */
  method?: DetectionMethod;
  /** Key of the check this finding belongs to. */
  checkKey?: string;
  /** When the evidence was collected (epoch ms). */
  detectedAt?: number;
  /** true = directly observed; false = inferred / potential risk only. */
  confirmed?: boolean;
  status?: FindingStatus;
}

export interface Issue {
  category: string;
  severity: Severity;
  priority: Priority;
  message: string;
  whyItMatters: string;
  /** Empty string when the evidence does not support a concrete fix. */
  howToFix: string;
  // Evidence fields — optional so reports saved before this upgrade still load.
  evidence?: string;
  evidenceUrl?: string;
  stage?: string;
  method?: DetectionMethod;
  checkKey?: string;
  detectedAt?: number;
  confirmed?: boolean;
  status?: FindingStatus;
}

export interface CategoryScore {
  score: number;
  passed: number;
  failed: number;
  warnings: number;
  /** Legacy field: number of checks that could not be verified. */
  notChecked: number;
  // Evidence-based scoring extensions (optional for legacy stored reports)
  /** passed + failed + warnings — the only checks that count toward the score. */
  applicable?: number;
  /** Checks that could not be verified (Unable to Verify). */
  unverified?: number;
  /** Checks that do not apply to this target (Not Applicable). */
  notApplicable?: number;
  /** false ⇒ too few verified checks to produce a score; display "—", never 0. */
  hasScore?: boolean;
  /** The exact formula used to compute `score`. */
  formula?: string;
  /** Main factors that moved this score. */
  factors?: string[];
}

export interface ScanSummary {
  completeness: "complete" | "partial" | "blocked";
  limitations: string[];
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirects: number;
  redirectChain: string[];
  contentType?: string;
  durationMs: number;
  /** Detection method used for the content checks, e.g. "http". */
  method: string;
  /** Whether a real browser engine was used (rendered DOM, lab metrics). */
  browserChecks: string;
  blocked: boolean;
  blockReason?: string;
  notHtml: boolean;
  incomplete: boolean;
  counts: {
    passed: number;
    failed: number;
    warnings: number;
    notApplicable: number;
    unverified: number;
    total: number;
  };
  categoryFormula: string;
  overallFormula: string;
  /** How the performance numbers were obtained (never a full page-load lab test here). */
  performanceBasis: string;
  overallScored: boolean;
}

export interface QuickWin {
  category: string;
  message: string;
  potentialGain: number;
  priority: Priority;
}

export interface SSLInfo {
  valid: boolean;
  issuer: string;
  expiryDate: string;
  daysUntilExpiry: number;
  serialNumber: string;
  subjectAltNames: string[];
}

export interface CookieInfo {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
  domain: string | null;
}

export interface MixedContent {
  url: string;
  type: "script" | "image" | "stylesheet" | "other";
  lineNumber: number;
}

export interface ServerInfo {
  server: string | null;
  poweredBy: string | null;
  technology: string[];
  framework: string | null;
}

export interface SiteIdentity {
  hasPrivacyPolicy: boolean;
  hasTermsOfService: boolean;
  hasContactInfo: boolean;
  hasOrganization: boolean;
  organizationName: string | null;
}

export interface ScanResult {
  url: string;
  finalUrl: string;
  status: number;
  https: boolean;
  redirects: number;
  redirectChain: string[];
  responseTime: number;
  pageSize: number;
  pageSizeFormatted: string;

  // SEO
  title?: string;
  titleLength: number;
  description?: string;
  descriptionLength: number;
  hasViewport: boolean;
  hasCharset: boolean;
  hasLanguage: boolean;
  hasH1: boolean;
  h1Count: number;
  headingStructure: string;
  canonicalUrl?: string;
  hasRobotsMeta: boolean;
  robotsTxtAvailable?: boolean;
  sitemapXmlAvailable?: boolean;

  // Content
  imageCount: number;
  imagesWithoutAlt: number;
  linkCount: number;
  scriptCount: number;
  styleCount: number;
  internalLinkCount: number;
  externalLinkCount: number;
  formInputCount: number;
  inputsWithoutLabels: number;

  // Security headers
  hasCSP: boolean;
  hasXFrameOptions: boolean;
  hasXContentTypeOptions: boolean;
  hasStrictTransportSecurity: boolean;
  hasXPermittedCrossDomainPolicies: boolean;
  hasReferrerPolicy: boolean;
  hasPermissionsPolicy: boolean;

  // SSL
  ssl: SSLInfo | null;

  // Cookies
  cookies: CookieInfo[];
  cookiesWithIssues: number;

  // Mixed content
  mixedContent: MixedContent[];
  mixedContentCount: number;

  // Server info
  serverInfo: ServerInfo;

  // Site identity
  siteIdentity: SiteIdentity;

  // Health score & grade
  score: number;
  grade: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  betterThanPercent: number;

  // Category scores
  performanceScore: number;
  seoScore: number;
  securityScore: number;
  accessibilityScore: number;
  technicalHealthScore: number;
  sslScore: number;
  cookieScore: number;
  mixedContentScore: number;

  // Checks tracking
  performanceChecks: CategoryScore;
  seoChecks: CategoryScore;
  securityChecks: CategoryScore;
  accessibilityChecks: CategoryScore;
  technicalHealthChecks: CategoryScore;

  // Issues
  issues: Issue[];
  topIssues: Issue[];
  quickWins: QuickWin[];
  totalChecksCompleted: number;
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;
  totalUnverified?: number;
  totalNotApplicable?: number;

  /** Transparent summary of what was actually observed (and what was not). */
  summary?: ScanSummary;
  /** false ⇒ not enough verified checks to produce an overall score. */
  overallScored?: boolean;

  scannedAt: number;
}
