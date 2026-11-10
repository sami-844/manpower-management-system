import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HttpException, HttpStatus, Inject, Injectable, NotFoundException, StreamableFile, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { Request } from "express";
import { DB, type Database, type Orm } from "../db/client";
import { files, MAX_FILE_BYTES } from "../db/schema";

/**
 * Scans of documents (PRD 4.19, TR-SEC-12, A27). Bytes go to a file store (local disk in development,
 * S3 in production) under `<entity>/<id>`; the row records the hash, type and virus-scan status, and a
 * file opens only once it is scanned clean.
 */

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];
const problem = (status: number, code: string, message: string) => new HttpException({ code, message }, status);

export const SCAN_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/heic"] as const;
export type ScanMime = (typeof SCAN_MIMES)[number];

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** The type the bytes really are, from their first bytes; null for anything else (TR-SEC-12). */
export function detectMime(bytes: Uint8Array): ScanMime | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 5 && ascii(0, 5) === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12))) return "image/heic";
  return null;
}

/** A file name safe to store and to put in a header: no path, no control characters, at most 200 characters. */
export function cleanFileName(name: string | undefined, mime: ScanMime): string {
  let decoded = name ?? "";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Not percent-encoded: use it as sent.
  }
  // Control and format characters (including right-to-left overrides that disguise an extension) and quotes go.
  const base = decoded.split(/[\\/]/).pop()!.replace(/[\p{Cc}\p{Cf}"]/gu, "").trim().slice(0, 200);
  const ext = EXTENSIONS[mime];
  const main = ext[0]!;
  if (!base) return `scan.${main}`;
  const current = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  // The name always ends in the extension of what the file really is.
  return ext.includes(current) ? base : `${base.slice(0, 200 - main.length - 1)}.${main}`;
}

const EXTENSIONS: Record<ScanMime, string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/heic": ["heic", "heif"],
};

// ---------------------------------------------------------------------------------------------
// Where the bytes live
// ---------------------------------------------------------------------------------------------

export interface FileStore {
  put(key: string, bytes: Uint8Array, mime: ScanMime): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Throws if the store cannot be reached with the credentials it has (checked at start-up). */
  ready(): Promise<void>;
}

export class DiskFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    // Keys are built by this service (`<entity>/<uuid>`), but a key must never climb out of the root.
    if (!/^[A-Za-z0-9-]+\/[0-9a-f-]{36}$/.test(key)) throw new Error(`Invalid file key ${key}`);
    return join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" }); // never overwrite a stored file
  }

  async ready(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}

/**
 * S3 in production (A10): the bucket's default encryption (SSE-KMS), versioning and the malware scan
 * are set on the bucket in the S1 landing zone, so this only writes and reads objects.
 */
export class S3FileStore implements FileStore {
  private readonly client: Bun.S3Client;

  constructor(bucket: string, region?: string) {
    this.client = new Bun.S3Client({ bucket, region });
  }

  async put(key: string, bytes: Uint8Array, mime: ScanMime): Promise<void> {
    await this.client.write(key, bytes, { type: mime });
  }

  /**
   * A HEAD request with the configured credentials: a missing object is fine, refused access is not.
   * ponytail: Bun's S3 client reads keys from the environment; whether it also picks up an ECS task
   * role is unverified (DEFERRED X20), so production fails at start-up rather than on the first upload.
   */
  async ready(): Promise<void> {
    await this.client.exists("health/ready");
  }

  async get(key: string): Promise<Uint8Array | null> {
    const object = this.client.file(key);
    if (!(await object.exists())) return null;
    return new Uint8Array(await object.arrayBuffer());
  }
}

// ---------------------------------------------------------------------------------------------
// Virus scanning
// ---------------------------------------------------------------------------------------------

export type ScanVerdict = "clean" | "infected" | "pending";

export interface MalwareScanner {
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

/** The industry-standard antivirus test file (EICAR), which every scanner reports as infected. */
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * Development and tests only: recognises the EICAR test signature, so the "infected" path is exercised
 * end to end. Production never uses it (loadFileConfig refuses), because it detects nothing real.
 */
export class SignatureScanner implements MalwareScanner {
  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(EICAR) ? "infected" : "clean";
  }
}

/**
 * Production: the bucket's malware scan (S1 landing zone) decides, after the upload. Until the job that
 * records its verdict exists (DEFERRED X15), files stay pending and cannot be opened: closed, not open.
 */
export class ExternalScanner implements MalwareScanner {
  async scan(): Promise<ScanVerdict> {
    return "pending";
  }
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface FileConfig {
  store: FileStore;
  scanner: MalwareScanner;
}

export const FILE_CONFIG = Symbol("FILE_CONFIG");

export function loadFileConfig(env: Record<string, string | undefined> = process.env): FileConfig {
  const production = env.NODE_ENV === "production";
  const kind = env.FILE_STORE ?? (production ? "s3" : "disk");
  const scannerKind = env.FILE_SCANNER ?? (production ? "external" : "signature");
  if (production && kind !== "s3") throw new Error("FILE_STORE must be s3 in production (A27)");
  if (production && scannerKind !== "external") throw new Error("FILE_SCANNER must be external in production: the signature scanner detects nothing real");

  let store: FileStore;
  if (kind === "s3") {
    if (!env.FILE_STORE_BUCKET) throw new Error("FILE_STORE_BUCKET is required when FILE_STORE is s3");
    store = new S3FileStore(env.FILE_STORE_BUCKET, env.AWS_REGION);
  } else if (kind === "disk") {
    store = new DiskFileStore(resolve(env.FILE_STORE_DIR ?? join(tmpdir(), "mms-files")));
  } else {
    throw new Error(`Unknown FILE_STORE "${kind}" (disk or s3)`);
  }

  let scanner: MalwareScanner;
  if (scannerKind === "signature") scanner = new SignatureScanner();
  else if (scannerKind === "external") scanner = new ExternalScanner();
  else throw new Error(`Unknown FILE_SCANNER "${scannerKind}" (signature or external)`);
  return { store, scanner };
}

// ---------------------------------------------------------------------------------------------
// Storing and opening
// ---------------------------------------------------------------------------------------------

export type FileRow = typeof files.$inferSelect;

export interface Upload {
  bytes: unknown;
  contentType: string | undefined;
  fileName: string | undefined;
}

@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
  ) {}

  /**
   * Checks an upload (TR-SEC-12), scans it, writes the bytes, then records the row in `tx`. The bytes are
   * written first: if the transaction then fails, an unreferenced object is left, never a row without bytes.
   */
  async store(tx: Tx, upload: Upload, actor: string): Promise<FileRow> {
    const declared = (upload.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (!Buffer.isBuffer(upload.bytes) || upload.bytes.length === 0) {
      throw problem(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_FILE", "Send the scan as the request body: a PDF, JPG, PNG or HEIC file.");
    }
    const bytes: Uint8Array = upload.bytes;
    if (bytes.length > MAX_FILE_BYTES) throw problem(HttpStatus.PAYLOAD_TOO_LARGE, "FILE_TOO_LARGE", "A scan can be at most 15 MB.");
    const mime = detectMime(bytes);
    if (!mime || mime !== declared) {
      throw problem(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_FILE", "Only PDF, JPG, PNG and HEIC scans are accepted, and the file must really be that type.");
    }
    const verdict = await this.config.scanner.scan(bytes);
    if (verdict === "infected") {
      throw problem(HttpStatus.UNPROCESSABLE_ENTITY, "FILE_INFECTED", "The virus scan rejected this file. It was not stored.");
    }

    const id = Bun.randomUUIDv7();
    const [{ entity }] = (await tx.execute(
      sql`select coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') as entity`,
    )) as unknown as [{ entity: string }];
    const key = `${entity}/${id}`;
    await this.config.store.put(key, bytes, mime);
    const [row] = await tx
      .insert(files)
      .values({
        id,
        s3Key: key,
        originalName: cleanFileName(upload.fileName, mime),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mime,
        bytes: bytes.length,
        scanStatus: verdict,
        uploadedBy: actor,
      })
      .returning();
    return row!;
  }

  /** The bytes of a clean file, as a response body. A pending or infected file never opens. */
  async open(fileId: string): Promise<{ row: FileRow; body: StreamableFile }> {
    const [row] = await this.db.orm.select().from(files).where(eq(files.id, fileId));
    if (!row) throw new NotFoundException("File not found");
    if (row.scanStatus !== "clean") {
      throw problem(
        HttpStatus.CONFLICT,
        row.scanStatus === "pending" ? "FILE_NOT_SCANNED" : "FILE_INFECTED",
        row.scanStatus === "pending" ? "This scan is still being checked for viruses." : "This scan failed the virus check and cannot be opened.",
      );
    }
    const bytes = await this.config.store.get(row.s3Key);
    if (!bytes) throw problem(HttpStatus.INTERNAL_SERVER_ERROR, "FILE_MISSING", "The stored scan could not be found.");
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      throw problem(HttpStatus.INTERNAL_SERVER_ERROR, "FILE_CHANGED", "The stored scan does not match what was uploaded.");
    }
    return {
      row,
      body: new StreamableFile(Buffer.from(bytes), {
        type: row.mime,
        length: bytes.length,
        disposition: `inline; filename*=UTF-8''${encodeURIComponent(row.originalName)}`,
      }),
    };
  }
}

/** Response headers for an opened scan: never cached, never sniffed into another type. */
export const SCAN_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

/**
 * Reads a scan from the request body (PRD 4.19, TR-SEC-12). A route guard, so it runs after the
 * sign-in and permission guard (no anonymous request is ever buffered) and before the request's
 * database transaction opens (a slow upload never holds a connection). Only the upload routes use it.
 */
/** How much of an oversized upload is read and dropped before the connection is cut. */
const DRAIN_CAP_BYTES = 4 * MAX_FILE_BYTES;

@Injectable()
export class ScanBodyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const encoding = (req.headers["content-encoding"] ?? "identity").toString().toLowerCase();
    if (encoding !== "identity") {
      throw problem(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_FILE", "Send the scan uncompressed.");
    }
    const tooLarge = () => problem(HttpStatus.PAYLOAD_TOO_LARGE, "FILE_TOO_LARGE", "A scan can be at most 15 MB.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      // Past the limit the rest is read and dropped, never kept, so the sender gets the 413 rather
      // than a reset connection; past the drain cap the connection is simply cut.
      if (size > MAX_FILE_BYTES) {
        chunks.length = 0;
        if (size > DRAIN_CAP_BYTES) {
          req.destroy();
          throw tooLarge();
        }
        continue;
      }
      chunks.push(chunk);
    }
    if (size > MAX_FILE_BYTES) throw tooLarge();
    req.body = Buffer.concat(chunks, size);
    return true;
  }
}
