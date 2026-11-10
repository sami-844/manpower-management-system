import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanFileName, detectMime, DiskFileStore, ExternalScanner, loadFileConfig, S3FileStore, SignatureScanner } from "../src/files/files";

// TR-SEC-12 uploads, A27 storage: the parts that HTTP tests cannot reach easily.

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);
const heic = (brand: string) => new Uint8Array([0, 0, 0, 24, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0]);

describe("detectMime", () => {
  it("knows PDF, JPEG, PNG and HEIC by their first bytes", () => {
    expect(detectMime(ascii("%PDF-1.7\n"))).toBe("application/pdf");
    expect(detectMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(detectMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(detectMime(heic("heic"))).toBe("image/heic");
    expect(detectMime(heic("mif1"))).toBe("image/heic");
  });

  it("refuses everything else, including look-alikes and truncated headers", () => {
    expect(detectMime(ascii("MZ\x90\x00"))).toBeNull(); // a Windows executable
    expect(detectMime(ascii("<html>"))).toBeNull();
    expect(detectMime(heic("mp42"))).toBeNull(); // an MP4 video, same box layout
    expect(detectMime(ascii("%PDF"))).toBeNull();
    expect(detectMime(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(detectMime(bytes())).toBeNull();
  });
});

describe("cleanFileName", () => {
  it("keeps a readable name but drops any path, control characters and quotes", () => {
    expect(cleanFileName(encodeURIComponent("CR – 2026.pdf"), "application/pdf")).toBe("CR – 2026.pdf");
    expect(cleanFileName("..\\..\\windows\\system.ini", "application/pdf")).toBe("system.ini.pdf");
    expect(cleanFileName("../etc/passwd", "image/png")).toBe("passwd.png");
    expect(cleanFileName('a"b\u0007c.png', "image/png")).toBe("abc.png");
    expect(cleanFileName("x".repeat(300), "image/png")).toHaveLength(200);
  });

  it("drops right-to-left overrides and gives every name the extension of what the file really is", () => {
    // "\u202Efdp.exe" displays as "exe.pdf" but would save as .exe.
    expect(cleanFileName(encodeURIComponent("\u202Efdp.exe"), "application/pdf")).toBe("fdp.exe.pdf");
    expect(cleanFileName("photo.JPEG", "image/jpeg")).toBe("photo.JPEG");
    expect(cleanFileName("photo.png", "image/jpeg")).toBe("photo.png.jpg");
    expect(cleanFileName("card.heif", "image/heic")).toBe("card.heif");
  });

  it("names a scan sent without a usable name after its type", () => {
    expect(cleanFileName(undefined, "image/jpeg")).toBe("scan.jpg");
    expect(cleanFileName("  ", "image/heic")).toBe("scan.heic");
    expect(cleanFileName("%E0%A4%A", "application/pdf")).toBe("%E0%A4%A.pdf"); // not valid percent-encoding: kept as sent
  });
});

describe("loadFileConfig", () => {
  it("uses the disk store and the signature scanner in development", () => {
    const config = loadFileConfig({ FILE_STORE_DIR: "/tmp/x" });
    expect(config.store).toBeInstanceOf(DiskFileStore);
    expect(config.scanner).toBeInstanceOf(SignatureScanner);
  });

  it("refuses to run production on the disk store or the signature scanner", () => {
    expect(() => loadFileConfig({ NODE_ENV: "production", FILE_STORE: "disk", FILE_STORE_BUCKET: "b" })).toThrow(/must be s3/);
    expect(() => loadFileConfig({ NODE_ENV: "production", FILE_STORE_BUCKET: "b", FILE_SCANNER: "signature" })).toThrow(/must be external/);
    expect(() => loadFileConfig({ NODE_ENV: "production" })).toThrow(/FILE_STORE_BUCKET/);
  });

  it("uses S3 and the external scanner in production", () => {
    const config = loadFileConfig({ NODE_ENV: "production", FILE_STORE_BUCKET: "mms-documents", AWS_REGION: "me-central-1" });
    expect(config.store).toBeInstanceOf(S3FileStore);
    expect(config.scanner).toBeInstanceOf(ExternalScanner);
  });

  it("refuses unknown settings rather than guessing", () => {
    expect(() => loadFileConfig({ FILE_STORE: "ftp" })).toThrow(/Unknown FILE_STORE/);
    expect(() => loadFileConfig({ FILE_SCANNER: "none" })).toThrow(/Unknown FILE_SCANNER/);
  });
});

describe("scanners", () => {
  it("leaves every production upload pending until the bucket's scan reports (X15)", async () => {
    expect(await new ExternalScanner().scan()).toBe("pending");
  });

  it("finds the EICAR test signature anywhere in the file", async () => {
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    expect(await new SignatureScanner().scan(ascii(`%PDF-1.4 ${eicar}`))).toBe("infected");
    expect(await new SignatureScanner().scan(ascii("%PDF-1.4 clean"))).toBe("clean");
  });
});

describe("DiskFileStore", () => {
  it("writes once, reads back, and answers null for a missing key", async () => {
    const store = new DiskFileStore(await mkdtemp(join(tmpdir(), "mms-store-")));
    const key = `OM-01/${crypto.randomUUID()}`;
    await store.put(key, ascii("%PDF-1.4 a"));
    expect(new TextDecoder().decode((await store.get(key))!)).toBe("%PDF-1.4 a");
    await expect(store.put(key, ascii("%PDF-1.4 b"))).rejects.toThrow(); // never overwritten
    expect(await store.get(`OM-01/${crypto.randomUUID()}`)).toBeNull();
  });

  it("refuses a key that could leave the store's folder", async () => {
    const store = new DiskFileStore(await mkdtemp(join(tmpdir(), "mms-store-")));
    await expect(store.get("../../etc/passwd")).rejects.toThrow(/Invalid file key/);
    await expect(store.put("OM-01/../../x", ascii("%PDF-"))).rejects.toThrow(/Invalid file key/);
  });
});
