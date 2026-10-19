import { migrateTestDb } from "./harness";

export default async function setup(): Promise<void> {
  await migrateTestDb();
}
