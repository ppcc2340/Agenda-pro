import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import type { KeyProvider, WrappedKey } from "@meri/config/crypto";
import { z } from "zod";

/**
 * `MERI-BACKUP-1` (ADR 0007, plan review SA-H4): a STREAM-style authenticated encryption of a database dump.
 * - A fresh 256-bit DEK per backup, wrapped by the KMS key ring for the `backup` purpose.
 * - Header: magic, length-prefixed JSON (version, chunk size, nonce prefix, wrapped DEK, manifest).
 * - Body: chunks `len(4, BE) ‖ ciphertext ‖ tag(16)`, each AES-256-GCM with
 *   nonce = prefix(7) ‖ counter(4, BE) ‖ last-flag(1) and AAD = SHA-256(magic ‖ header).
 * Reordered chunks break the counter, a truncation or a dropped final chunk breaks the last flag, an edited header
 * breaks every tag, and trailing bytes are refused.
 */
export const BACKUP_MAGIC = Buffer.from("MERIBK1\n", "ascii");
export const DEFAULT_CHUNK = 1024 * 1024;
const TAG = 16;
const MAX_HEADER = 1024 * 1024;

export const BackupManifest = z.object({
  createdAt: z.string().datetime(),
  migrations: z.number().int().nonnegative(),
  tables: z.record(z.string(), z.number().int().nonnegative()),
});
export type BackupManifest = z.infer<typeof BackupManifest>;

const Header = z.object({
  version: z.literal(1),
  chunkSize: z.number().int().min(1024).max(64 * 1024 * 1024),
  noncePrefix: z.string(),
  wrappedDek: z.object({ keyId: z.string().min(1), ciphertext: z.string().min(1) }),
  manifest: BackupManifest,
});
type Header = z.infer<typeof Header>;

export class BackupFormatError extends Error {
  override readonly name = "BackupFormatError";
}

const nonce = (prefix: Buffer, counter: number, last: boolean) => {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0, 0, 7);
  n.writeUInt32BE(counter, 7);
  n[11] = last ? 1 : 0;
  return n;
};

/** Encrypts `src` (a dump file) into `dest`. Returns the header written (without secrets). */
export async function encryptBackupFile(
  keys: KeyProvider,
  src: string,
  dest: string,
  manifest: BackupManifest,
  chunkSize = DEFAULT_CHUNK,
): Promise<{ keyId: string; chunks: number; bytes: number }> {
  const dek = randomBytes(32);
  const prefix = randomBytes(7);
  const wrapped: WrappedKey = await keys.wrap(dek);
  const header: Header = {
    version: 1,
    chunkSize,
    noncePrefix: prefix.toString("base64"),
    wrappedDek: wrapped,
    manifest,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBytes.length);
  const aad = createHash("sha256").update(BACKUP_MAGIC).update(len).update(headerBytes).digest();
  const input = await open(src, "r");
  const output = await open(dest, "wx", 0o600);
  let chunks = 0;
  let bytes = 0;
  try {
    await output.write(Buffer.concat([BACKUP_MAGIC, len, headerBytes]));
    const read = async () => {
      const buf = Buffer.alloc(chunkSize);
      const { bytesRead } = await input.read(buf, 0, chunkSize, null);
      return buf.subarray(0, bytesRead);
    };
    let current = await read();
    for (;;) {
      const next = current.length === chunkSize ? await read() : Buffer.alloc(0);
      const last = next.length === 0;
      const cipher = createCipheriv("aes-256-gcm", dek, nonce(prefix, chunks, last));
      cipher.setAAD(aad);
      const ct = Buffer.concat([cipher.update(current), cipher.final(), cipher.getAuthTag()]);
      const clen = Buffer.alloc(4);
      clen.writeUInt32BE(ct.length);
      await output.write(Buffer.concat([clen, ct]));
      bytes += current.length;
      chunks++;
      if (last) break;
      current = next;
    }
  } finally {
    dek.fill(0);
    await input.close();
    await output.close();
  }
  return { keyId: wrapped.keyId, chunks, bytes };
}

/** Reads and validates the header only (the manifest is authenticated by every chunk tag, checked on decrypt). */
export async function readBackupHeader(path: string): Promise<{ header: Header; offset: number; aad: Buffer }> {
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(BACKUP_MAGIC.length + 4);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    if (bytesRead !== head.length || !head.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC))
      throw new BackupFormatError("not a Meri backup (bad magic)");
    const size = head.readUInt32BE(BACKUP_MAGIC.length);
    if (size === 0 || size > MAX_HEADER) throw new BackupFormatError("backup header has an invalid length");
    const headerBytes = Buffer.alloc(size);
    const got = await file.read(headerBytes, 0, size, head.length);
    if (got.bytesRead !== size) throw new BackupFormatError("backup header is truncated");
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      throw new BackupFormatError("backup header is not valid JSON");
    }
    const header = Header.safeParse(parsed);
    if (!header.success) throw new BackupFormatError("backup header does not match MERI-BACKUP-1");
    const aad = createHash("sha256")
      .update(BACKUP_MAGIC)
      .update(head.subarray(BACKUP_MAGIC.length))
      .update(headerBytes)
      .digest();
    return { header: header.data, offset: head.length + size, aad };
  } finally {
    await file.close();
  }
}

/**
 * Decrypts `src` into `dest` (created 0600), verifying every chunk, the order and the end of the stream. On any
 * failure `dest` must be discarded by the caller (it is only complete when this resolves).
 */
export async function decryptBackupFile(keys: KeyProvider, src: string, dest: string): Promise<BackupManifest> {
  const { header, offset, aad } = await readBackupHeader(src);
  const dek = Buffer.from(await keys.unwrap(header.wrappedDek));
  const prefix = Buffer.from(header.noncePrefix, "base64");
  if (prefix.length !== 7) throw new BackupFormatError("backup nonce prefix is malformed");
  const input = await open(src, "r");
  const output = await open(dest, "wx", 0o600);
  try {
    const size = (await input.stat()).size;
    let position = offset;
    let counter = 0;
    for (;;) {
      const lenBuf = Buffer.alloc(4);
      const { bytesRead } = await input.read(lenBuf, 0, 4, position);
      if (bytesRead !== 4) throw new BackupFormatError("backup is truncated (missing final chunk)");
      const clen = lenBuf.readUInt32BE(0);
      if (clen < TAG || clen > header.chunkSize + TAG) throw new BackupFormatError("backup chunk has an invalid length");
      const chunk = Buffer.alloc(clen);
      const got = await input.read(chunk, 0, clen, position + 4);
      if (got.bytesRead !== clen) throw new BackupFormatError("backup chunk is truncated");
      position += 4 + clen;
      const last = position === size;
      const decipher = createDecipheriv("aes-256-gcm", dek, nonce(prefix, counter, last));
      decipher.setAAD(aad);
      decipher.setAuthTag(chunk.subarray(clen - TAG));
      let plain: Buffer;
      try {
        plain = Buffer.concat([decipher.update(chunk.subarray(0, clen - TAG)), decipher.final()]);
      } catch {
        throw new BackupFormatError(`backup chunk ${String(counter)} failed authentication`);
      }
      await output.write(plain);
      counter++;
      if (last) break;
    }
  } finally {
    dek.fill(0);
    await input.close();
    await output.close();
  }
  return header.manifest;
}
