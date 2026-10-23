/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agency from "../agency.js";
import type * as aiAssistant from "../aiAssistant.js";
import type * as alerts from "../alerts.js";
import type * as analytics from "../analytics.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as billing from "../billing.js";
import type * as billingActions from "../billingActions.js";
import type * as crons from "../crons.js";
import type * as feedback from "../feedback.js";
import type * as github from "../github.js";
import type * as githubActions from "../githubActions.js";
import type * as http from "../http.js";
import type * as integrations from "../integrations.js";
import type * as monitors from "../monitors.js";
import type * as probe from "../probe.js";
import type * as rateLimit from "../rateLimit.js";
import type * as retention from "../retention.js";
import type * as scan from "../scan.js";
import type * as scans from "../scans.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agency: typeof agency;
  aiAssistant: typeof aiAssistant;
  alerts: typeof alerts;
  analytics: typeof analytics;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  billing: typeof billing;
  billingActions: typeof billingActions;
  crons: typeof crons;
  feedback: typeof feedback;
  github: typeof github;
  githubActions: typeof githubActions;
  http: typeof http;
  integrations: typeof integrations;
  monitors: typeof monitors;
  probe: typeof probe;
  rateLimit: typeof rateLimit;
  retention: typeof retention;
  scan: typeof scan;
  scans: typeof scans;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
