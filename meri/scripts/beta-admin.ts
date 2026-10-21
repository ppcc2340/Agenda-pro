/**
 * Closed beta administration (D-099). Run by a person with the owner connection; prints counts, never lists of
 * addresses.
 *   pnpm beta:invite <email>   invite an address (warns at the Google "Testing" cap of 100 users)
 *   pnpm beta:forget <email>   remove an address from the invitations and the waitlist (erasure request)
 * Needs DATABASE_ADMIN_URL.
 */
import { loadDotenv } from "@meri/config";
import { createDb } from "@meri/db";
import { z } from "zod";

/** Google OAuth apps in "Testing" accept at most 100 test users (docs/blockers/google-oauth.md). */
export const TESTING_USER_CAP = 100;

const Email = z.string().trim().toLowerCase().email().max(254);

export interface InviteResult {
  /** False when the address was already invited or already has an account. */
  added: boolean;
  /** Accounts plus pending invitations: the people who can use Google during the beta. */
  seats: number;
  overCap: boolean;
}

export async function inviteEmail(adminUrl: string, raw: string): Promise<InviteResult> {
  const email = Email.parse(raw);
  const handle = createDb(adminUrl, { max: 1 });
  const sql = handle.sql;
  try {
    const [existing] = await sql<
      { n: number }[]
    >`select count(*)::int as n from users where email = ${email}`;
    const added =
      (existing?.n ?? 0) === 0 &&
      (await sql`insert into beta_invites (email) values (${email}) on conflict (email) do nothing`).count ===
        1;
    const [seats] = await sql<{ n: number }[]>`
      select (select count(*) from users where deleted_at is null) + (select count(*) from beta_invites) as n`;
    const total = Number(seats?.n ?? 0);
    return { added, seats: total, overCap: total > TESTING_USER_CAP };
  } finally {
    await handle.close();
  }
}

export async function forgetEmail(adminUrl: string, raw: string): Promise<{ removed: number }> {
  const email = Email.parse(raw);
  const handle = createDb(adminUrl, { max: 1 });
  const sql = handle.sql;
  try {
    const invites = await sql`delete from beta_invites where email = ${email}`;
    const waiting = await sql`delete from waitlist where email = ${email}`;
    return { removed: invites.count + waiting.count };
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  loadDotenv(".env");
  const [command, email] = process.argv.slice(2);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is required.");
  if (!email || (command !== "invite" && command !== "forget"))
    throw new Error("Usage: pnpm beta:invite <email> | pnpm beta:forget <email>");
  if (command === "invite") {
    const r = await inviteEmail(adminUrl, email);
    console.warn(r.added ? "invited" : "already invited or already has an account");
    console.warn(
      `seats in use (accounts + pending invitations): ${String(r.seats)} / ${String(TESTING_USER_CAP)}`,
    );
    if (r.overCap)
      console.warn(
        `WARNING: more than ${String(TESTING_USER_CAP)} people. A Google app in "Testing" refuses the extra ` +
          "accounts: publish the app (verification) or stop inviting (docs/blockers/google-oauth.md).",
      );
  } else {
    const r = await forgetEmail(adminUrl, email);
    console.warn(`removed ${String(r.removed)} row(s) from the invitations and the waitlist`);
  }
}

if (process.argv[1]?.endsWith("beta-admin.ts")) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
