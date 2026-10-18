import { api } from "@/convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";

export function useAuth() {
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.currentUser) as { _id: string; email: string } | undefined;
  const freeLimit = useQuery(api.users.getFreeMonitorLimit) as { limit: number } | undefined;
  const { signIn, signOut } = useAuthActions();

  // Derive isLoading directly from the dependencies instead of managing separate state
  const isLoading = isAuthLoading || user === undefined;

  return { isLoading, isAuthenticated, user, freeLimit, signIn, signOut };
}
