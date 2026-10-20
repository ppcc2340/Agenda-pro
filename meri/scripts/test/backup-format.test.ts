import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyRing, LocalKeyProvider, localKeyId } from "@meri/config/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_MAGIC, decryptBackupFile, encryptBackupFile, readBackupHeader } from "../lib/backup-format";

const key = (n: number) => Buffer.alloc(32, n).toString("base64");
const ring = new KeyRing(new LocalKeyProvider(key(71), localKeyId(key(71))));
const manifest = { createdAt: "2026-10-20T08:40:00.000Z", migrations: 18, tables: { tasks: 3, clients: 1 } };
const CHUNK = 1024;

describe("MERI-BACKUP-1 (ADR 0007, STREAM construction)", () => {
  let dir: string;
  let plain: Buffer;
  let sealed: string;
  let header: number;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "meri-bk-"));
    plain = randomBytes(CHUNK * 3 + 100);
    await writeFile(join(dir, "dump"), plain);
    sealed = join(dir, "dump.mbk");
    const out = await encryptBackupFile(ring, join(dir, "dump"), sealed, manifest, CHUNK);
    expect(out.chunks).toBe(4);
    header = (await readBackupHeader(sealed)).offset;
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  let n = 0;
  const attempt = async (bytes: Buffer, keys = ring) => {
    const src = join(dir, `t${String(++n)}.mbk`);
    await writeFile(src, bytes);
    return decryptBackupFile(keys, src, join(dir, `t${String(n)}.out`));
  };
  /** Offsets of each chunk (length prefix included). */
  const chunks = (file: Buffer) => {
    const out: [number, number][] = [];
    for (let p = header; p < file.length; ) {
      const len = file.readUInt32BE(p);
      out.push([p, 4 + len]);
      p += 4 + len;
    }
    return out;
  };

  it("round-trips the dump and the manifest; the file starts with the magic and never contains the plaintext", async () => {
    const file = await readFile(sealed);
    expect(file.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)).toBe(true);
    expect(file.includes(plain.subarray(0, 64))).toBe(false);
    expect(await attempt(file)).toEqual(manifest);
    expect((await readFile(join(dir, `t${String(n)}.out`))).equals(plain)).toBe(true);
  });

  it("refuses a truncation at a chunk boundary and a dropped final chunk", async () => {
    const file = await readFile(sealed);
    const parts = chunks(file);
    const [lastStart] = parts.at(-1) ?? [0, 0];
    await expect(attempt(file.subarray(0, lastStart))).rejects.toThrow(/failed authentication/);
    const [secondStart] = parts[1] ?? [0, 0];
    await expect(attempt(file.subarray(0, secondStart))).rejects.toThrow(/failed authentication/);
    await expect(attempt(file.subarray(0, file.length - 5))).rejects.toThrow(/truncated/);
  });

  it("refuses swapped chunks, trailing bytes, an edited header and a flipped byte", async () => {
    const file = await readFile(sealed);
    const [[a0, a1], [b0, b1]] = chunks(file) as [[number, number], [number, number]];
    const swapped = Buffer.concat([
      file.subarray(0, a0),
      file.subarray(b0, b0 + b1),
      file.subarray(a0, a0 + a1),
      file.subarray(b0 + b1),
    ]);
    await expect(attempt(swapped)).rejects.toThrow(/failed authentication/);
    await expect(attempt(Buffer.concat([file, Buffer.from([0, 0, 0, 0])]))).rejects.toThrow(/./);
    const edited = Buffer.from(file);
    const at = edited.indexOf(Buffer.from('"tasks":3'));
    edited[at + 8] = "9".charCodeAt(0);
    await expect(attempt(edited)).rejects.toThrow(/failed authentication/);
    const flipped = Buffer.from(file);
    flipped[file.length - 30] = (flipped[file.length - 30] ?? 0) ^ 1;
    await expect(attempt(flipped)).rejects.toThrow(/failed authentication/);
    await expect(attempt(Buffer.from("not a backup at all"))).rejects.toThrow(/bad magic/);
  });

  it("cannot be opened with another key", async () => {
    const other = new KeyRing(new LocalKeyProvider(key(72), localKeyId(key(72))));
    await expect(attempt(await readFile(sealed), other)).rejects.toMatchObject({ code: "UNKNOWN_KEY" });
  });

  it("an empty dump still has an authenticated final chunk", async () => {
    await writeFile(join(dir, "empty"), Buffer.alloc(0));
    const out = join(dir, "empty.mbk");
    expect((await encryptBackupFile(ring, join(dir, "empty"), out, manifest, CHUNK)).chunks).toBe(1);
    expect(await decryptBackupFile(ring, out, join(dir, "empty.out"))).toEqual(manifest);
  });
});
