// Minimal archive readers (and a zip writer) for the packaging scripts — no
// external `tar`/`zip`/`unzip`, whose availability and flags differ across
// Windows/macOS/Linux shells.

import { deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";
import * as zlib from "node:zlib";

// zlib.crc32 was added in Node 20.15; packaging also supports earlier Node 20.
const CRC_TABLE = zlib.crc32 ? null : Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
export const crc32 = zlib.crc32 ?? ((data) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
});

/** Regular files in a .tar.gz buffer → [{ name, data }]. Handles ustar prefixes
 *  and GNU long names ('L'), which is all prebuild tarballs use. */
export function untarGz(buf) {
  const tar = gunzipSync(buf);
  const files = [];
  let longName;
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 500);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = undefined;
    const data = tar.subarray(off + 512, off + 512 + size);
    if (type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "0" || type === "\0") files.push({ name, data: Buffer.from(data) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Entries of a .zip buffer (e.g. a VSIX) → Map(name → { size, read() }).
 *  Reads the central directory; supports stored and deflated entries. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue;
    entries.set(name, {
      size,
      read() {
        const lnlen = buf.readUInt16LE(local + 26);
        const lelen = buf.readUInt16LE(local + 28);
        const start = local + 30 + lnlen + lelen;
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`unsupported zip method ${method} for ${name}`);
      },
    });
  }
  return entries;
}

/** A .zip of [{ name, data }] (no zip64: under 4 GB). Already-compressed
 *  formats are stored; the rest is deflated. Timestamps are fixed, so the same
 *  inputs give the same archive. */
export function writeZip(files) {
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const store = /\.(onnx|wasm|bin|png|zip)$/i.test(name);
    const body = store ? data : deflateRawSync(data, { level: 9 });
    const fname = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const fields = (h, at) => {
      h.writeUInt16LE(20, at); // version needed
      h.writeUInt16LE(0x0800, at + 2); // UTF-8 names
      h.writeUInt16LE(store ? 0 : 8, at + 4);
      h.writeUInt16LE(0, at + 6); // time
      h.writeUInt16LE(DOS_DATE, at + 8);
      h.writeUInt32LE(crc, at + 10);
      h.writeUInt32LE(body.length, at + 14);
      h.writeUInt32LE(data.length, at + 18);
      h.writeUInt16LE(fname.length, at + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    fields(local, 4);
    locals.push(local, fname, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    fields(cen, 6);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, fname);
    offset += local.length + fname.length + body.length;
  }
  const cdir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdir, end]);
}
