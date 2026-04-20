import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * Task 45: centralised hook to fetch user display names for a set of user ids.
 *
 * Returns a map from user id → display name. While loading, returns an empty
 * object (callers should fall back to a placeholder).
 */
export function useUserDisplayNames(
  userIds: Array<Id<"users">>,
): Record<string, string> {
  // Deduplicate to keep query args stable across renders.
  const unique = Array.from(new Set(userIds));
  const result = useQuery(api.users.getDisplayNames, { userIds: unique });
  return result ?? {};
}
