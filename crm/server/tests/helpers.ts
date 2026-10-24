import request from "supertest";
import { Db } from "../db.js";
import { createApp } from "../app.js";
import { bootstrap } from "../seed.js";

export function makeApp(demo = false) {
  const db = new Db(":memory:");
  const info = bootstrap(db, { demo, adminEmail: "admin@test.local", adminPassword: "Admin1234!" });
  const app = createApp(db);
  return { db, app, info };
}

export async function login(app: ReturnType<typeof createApp>, email: string, password: string) {
  const agent = request.agent(app);
  const r = await agent.post("/api/auth/login").send({ email, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return agent;
}
