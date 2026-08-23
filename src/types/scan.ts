// Shared type definitions for SitePulse scan results

export type Severity = "critical" | "warning" | "info";

export type CheckResult = "pass" | "fail" | "warn" | "not-checked";

export interface Issue {
  category: string;
  severity: Severity;
  message: string;
}

export interface CategoryScore {
  score: number;
  passed: number;
  failed: number;
  warnings: number;
  notChecked: number;
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
  robotsTxtAvailable: boolean | null;
  sitemapXmlAvailable: boolean | null;

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
  hasReferrerPolicy: boolean;
  hasPermissionsPolicy: boolean;

  // Category scores
  overallScore: number;
  performanceScore: number;
  seoScore: number;
  securityScore: number;
  accessibilityScore: number;
  technicalHealthScore: number;

  // Checks tracking
  performanceChecks: CategoryScore;
  seoChecks: CategoryScore;
  securityChecks: CategoryScore;
  accessibilityChecks: CategoryScore;
  technicalHealthChecks: CategoryScore;

  // Issues
  issues: Issue[];
  topIssues: Issue[];
  totalChecksCompleted: number;
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;

  scannedAt: number;
}
