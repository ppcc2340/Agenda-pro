"use server";

import { signOut } from "@/auth";

export async function signOutAction(): Promise<void> {
  // `manual=1`: after signing out, the demo must not sign in again by itself (D-053).
  await signOut({ redirectTo: "/login?manual=1" });
}
