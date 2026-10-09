import { ConvexReactClient } from "convex/react";

/**
 * The app's single Convex client.
 *
 * Both the app tree and the analytics helper need to talk to Convex; each
 * `new ConvexReactClient(...)` opens its own websocket, so they share this one
 * instance instead of quietly doubling every visitor's connections.
 */
export const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
