import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFile {
  /** Forward-slash path inside the zip. */
  readonly path: string;
  readonly data: Uint8Array;
}

/** 1980-01-01 00:00, the earliest DOS date: every entry gets it, so a rebuild of the same files is byte-identical. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** Bit 11: the name is UTF-8. */
const FLAGS = 0x0800;
/** 2.0, made by MS-DOS: no Unix mode or owner from the build machine leaks into the archive. */
const VERSION = 20;

/**
 * A reproducible zip (PKWARE APPNOTE, no zip64: the store package is far below 4 GB) for the Web Store upload.
 * Entries are sorted by path and carry a fixed date and no extra fields; each is deflated, or stored if that is smaller.
 */
export function storeZip(files: readonly ZipFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { path, data } of sorted) {
    const name = new TextEncoder().encode(path);
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.byteLength >= data.byteLength;
    const body = stored ? data : deflated;
    const fields = { method: stored ? 0 : 8, crc: crc32(data), compressed: body.byteLength, size: data.byteLength, name };

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, VERSION, true);
    writeCommon(local, 6, fields);
    locals.push(new Uint8Array(local.buffer), name, body);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, VERSION, true);
    central.setUint16(6, VERSION, true);
    writeCommon(central, 8, fields);
    // Comment length, disk, internal and external attributes stay 0.
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.byteLength + body.byteLength;
  }
  const centralSize = centrals.reduce((n, b) => n + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, sorted.length, true);
  end.setUint16(10, sorted.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return concat([...locals, ...centrals, new Uint8Array(end.buffer)]);
}

/** Flags through name length: the 22 bytes local and central headers share. */
function writeCommon(view: DataView, at: number, f: { method: number; crc: number; compressed: number; size: number; name: Uint8Array }): void {
  view.setUint16(at, FLAGS, true);
  view.setUint16(at + 2, f.method, true);
  view.setUint16(at + 4, DOS_TIME, true);
  view.setUint16(at + 6, DOS_DATE, true);
  view.setUint32(at + 8, f.crc, true);
  view.setUint32(at + 12, f.compressed, true);
  view.setUint32(at + 16, f.size, true);
  view.setUint16(at + 20, f.name.byteLength, true);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
