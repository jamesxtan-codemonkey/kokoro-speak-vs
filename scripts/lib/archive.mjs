// Minimal archive readers for the packaging scripts — no external `tar`/`unzip`,
// whose availability and flags differ across Windows/macOS/Linux shells.

import { gunzipSync, inflateRawSync } from "node:zlib";

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
