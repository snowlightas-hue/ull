// Content-addressed photo storage on the local disk (V2.3, docs/CATALOG.md §4).
//
//   <root>/<aa>/<bb>/<sha256 hex>      (root = UL_MEDIA_DIR, default var/media — git-ignored)
//
// The address is the sha256 of the CLEANED bytes (metadata already removed), so the same picture uploaded twice — to
// two products, by two owners — is one file and one media_blobs row. Files are written to a temporary name and
// renamed into place (atomic on one filesystem): a reader never sees a half-written photo. Nothing here logs names
// or contents.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../lib/env.ts';

const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function defaultMediaDir(): string {
  return process.env.UL_MEDIA_DIR || join(ROOT, 'var', 'media');
}

export class MediaStore {
  readonly root: string;
  constructor(root: string = defaultMediaDir()) { this.root = root; }

  pathFor(hex: string): string {
    if (!HEX64.test(hex)) throw new Error('bad media address');
    return join(this.root, hex.slice(0, 2), hex.slice(2, 4), hex);
  }

  /** Write the bytes under their address unless an identical file is already there. */
  async ensure(hex: string, bytes: Buffer): Promise<{ written: boolean }> {
    if (sha256Hex(bytes) !== hex) throw new Error('media address does not match the bytes');
    const path = this.pathFor(hex);
    const have = await stat(path).catch(() => null);
    if (have && have.isFile() && have.size === bytes.length) return { written: false };
    await mkdir(join(this.root, hex.slice(0, 2), hex.slice(2, 4)), { recursive: true, mode: 0o750 });
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, bytes, { flag: 'wx', mode: 0o640 });
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    return { written: true };
  }

  async exists(hex: string): Promise<boolean> {
    return !!(await stat(this.pathFor(hex)).catch(() => null))?.isFile();
  }

  /** A read stream, or null when the file is missing. */
  async open(hex: string): Promise<{ stream: ReadStream; size: number } | null> {
    const path = this.pathFor(hex);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return null;
    return { stream: createReadStream(path), size: st.size };
  }

  async remove(hex: string): Promise<void> {
    await rm(this.pathFor(hex), { force: true });
  }
}
