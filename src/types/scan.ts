// Shared type definitions for SitePulse scan results

export type Severity = "critical" | "warning" | "info";
export type Priority = "critical" | "important" | "recommended" | "nice-to-have";
export type CheckResult = "pass" | "fail" | "warn" | "not-checked";

export interface Issue {
  category: string;
  severity: Severity;
  priority: Priority;
  message: string;
  whyItMatters: string;
  howToFix: string;
}

export interface CategoryScore {
  score: number;
  passed: number;
  failed: number;
  warnings: number;
  notChecked: number;
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

  scannedAt: number;
}
