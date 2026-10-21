import { auth } from "@/auth";
import { getServerConfig } from "./config";
import { DEMO_USER } from "./demo";

/**
 * Is the signed-in user the shared demo account? Only that account is protected from destructive actions in
 * DEMO_MODE (the API applies the same rule); any other account created on a demo server behaves normally.
 */
export async function isDemoAccount(): Promise<boolean> {
  if (!getServerConfig().env.DEMO_MODE) return false;
  const session = await auth();
  return session?.user?.email?.trim().toLowerCase() === DEMO_USER.email.toLowerCase();
}
