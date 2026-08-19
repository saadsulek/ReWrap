/* ReWrap — HEIC / HEIF / ProRAW (DNG) → JPEG, metadata preserved, pixels untouched.
 * Core conversion logic is DOM-free and runs in both the browser and Node (for tests). */
(function () {
  'use strict';

  const ROOT = typeof globalThis !== 'undefined' ? globalThis : window;
  const C = (ROOT.ReWrap = ROOT.ReWrap || {});

  /* ============================== utilities ============================== */

  C.formatBytes = function (n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024, u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[u];
  };

  const dvOf = function (u8) {
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  };

  C.textBytes = function (str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  };

  C.utf8Bytes = function (str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return C.textBytes(unescape(encodeURIComponent(str)));
  };

  C.utf8String = function (u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return decodeURIComponent(escape(s));
  };

  const concatBytes = function (parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  C.concatBytes = concatBytes;

  const startsWith = function (u8, offset, str) {
    if (offset + str.length > u8.length) return false;
    for (let i = 0; i < str.length; i++) if (u8[offset + i] !== str.charCodeAt(i)) return false;
    return true;
  };
  C.startsWith = startsWith;

  /* ============================ JPEG segments ============================ */

  C.jpegSosOffset = function (u8) {
    const dv = dvOf(u8);
    let pos = 2;
    while (pos + 3 <= u8.length) {
      if (u8[pos] !== 0xff) { pos++; continue; }
      const code = u8[pos + 1];
      if (code === 0xda) return pos;
      if (code === 0xd9) return -1;
      if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) { pos += 2; continue; }
      const len = dv.getUint16(pos + 2);
      if (len < 2) return -1;
      pos += 2 + len;
    }
    return -1;
  };

  /* Strip APP1 EXIF/XMP and APP2 ICC segments from a JPEG. */
  C.jpegStripMetadata = function (u8) {
    const dv = dvOf(u8);
    const parts = [u8.slice(0, 2)];
    let pos = 2;
    while (pos + 4 <= u8.length) {
      if (u8[pos] !== 0xff) { parts.push(u8.slice(pos)); break; }
      const code = u8[pos + 1];
      if (code === 0xda || code === 0xd9) { parts.push(u8.slice(pos)); break; }
      if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) { pos += 2; continue; }
      const len = dv.getUint16(pos + 2);
      if (len < 2) { parts.push(u8.slice(pos)); break; }
      const p = pos + 4;
      let meta = false;
      if (code === 0xe1 && len >= 6) {
        meta = startsWith(u8, p, 'Exif') || startsWith(u8, p, 'http://ns.adobe.com/xap/1.0/');
      } else if (code === 0xe2 && len >= 12) {
        meta = startsWith(u8, p, 'ICC_PROFILE');
      }
      if (!meta) parts.push(u8.slice(pos, pos + 2 + len));
      pos += 2 + len;
    }
    return concatBytes(parts);
  };

  /* Insert APPn segments into a JPEG, right after SOI (or after a leading JFIF APP0). */
  C.jpegInjectSegments = function (u8, segments) {
    const dv = dvOf(u8);
    const sos = C.jpegSosOffset(u8);
    if (sos < 0) throw new Error('The encoded JPEG is not valid.');
    let insert = 2;
    if (u8[2] === 0xff && u8[3] === 0xe0) insert = 2 + 2 + dv.getUint16(4);
    const parts = [u8.slice(0, insert)];
    for (const s of segments) {
      if (!s || !s.payload || !s.payload.length) continue;
      if (s.payload.length > 65533) throw new Error('Metadata block too large for a JPEG segment.');
      const seg = new Uint8Array(4 + s.payload.length);
      seg[0] = 0xff; seg[1] = s.marker;
      seg[2] = (s.payload.length + 2) >> 8; seg[3] = (s.payload.length + 2) & 0xff;
      seg.set(s.payload, 4);
      parts.push(seg);
    }
    parts.push(u8.slice(insert));
    return concatBytes(parts);
  };

  C.exifApp1Payload = function (tiff) {
    const out = new Uint8Array(6 + tiff.length);
    out.set(C.textBytes('Exif\0\0'), 0);
    out.set(tiff, 6);
    return out;
  };

  C.xmpApp1Payload = function (xml) {
    const body = C.utf8Bytes(xml);
    return concatBytes([C.textBytes('http://ns.adobe.com/xap/1.0/\0'), body]);
  };

  /* Split an ICC profile into APP2 ICC_PROFILE segments (multi-segment safe). */
  C.iccApp2Segments = function (icc) {
    const MAX = 65500;
    const n = Math.ceil(icc.length / MAX);
    const segs = [];
    for (let i = 0; i < n; i++) {
      const chunk = icc.subarray(i * MAX, Math.min((i + 1) * MAX, icc.length));
      const payload = new Uint8Array(14 + chunk.length);
      payload.set(C.textBytes('ICC_PROFILE\0'), 0);
      payload[12] = i + 1;
      payload[13] = n;
      payload.set(chunk, 14);
      segs.push({ marker: 0xe2, payload });
    }
    return segs;
  };

  /* =============================== TIFF ================================= */

  const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

  C.tiffIsLittleEndian = function (u8) {
    return u8[0] === 0x49 && u8[1] === 0x49;
  };

  C.tiffIsValid = function (u8, isLE) {
    if (u8.length < 8) return false;
    return dvOf(u8).getUint16(2, isLE) === 42;
  };

  C.tiffReadIFD = function (u8, isLE, offset) {
    if (offset + 2 > u8.length) return [];
    const dv = dvOf(u8);
    const count = dv.getUint16(offset, isLE);
    if (count > 1024 || offset + 2 + count * 12 > u8.length + 4) return [];
    const entries = [];
    for (let i = 0; i < count; i++) {
      const p = offset + 2 + i * 12;
      const tag = dv.getUint16(p, isLE);
      const type = dv.getUint16(p + 2, isLE);
      const n = dv.getUint32(p + 4, isLE);
      const unit = TIFF_TYPE_SIZE[type] || 1;
      const size = unit * n;
      if (n > 0x400000) continue;
      const raw4 = u8.slice(p + 8, p + 12);
      entries.push({
        tag, type, count: n, size,
        inline: size <= 4,
        offset: size <= 4 ? null : dv.getUint32(p + 8, isLE),
        raw4
      });
    }
    return entries;
  };

  C.tiffNextIFD = function (u8, isLE, offset, entryCount) {
    const p = offset + 2 + entryCount * 12;
    if (p + 4 > u8.length) return 0;
    return dvOf(u8).getUint32(p, isLE);
  };

  C.tiffEntryValues = function (u8, isLE, entry) {
    if (!entry || entry.count === 0) return [];
    const src = entry.inline ? dvOf(entry.raw4) : dvOf(u8);
    const base = entry.inline ? 0 : entry.offset;
    const out = [];
    for (let i = 0; i < Math.min(entry.count, 0x400000); i++) {
      switch (entry.type) {
        case 1: case 7: out.push(src.getUint8(base + i)); break;
        case 3: out.push(src.getUint16(base + i * 2, isLE)); break;
        case 4: case 9: out.push(src.getUint32(base + i * 4, isLE)); break;
        default: out.push(0);
      }
    }
    return out;
  };

  C.tiffEntryData = function (u8, entry) {
    if (!entry) return null;
    if (entry.inline) return entry.raw4;
    if (entry.offset + entry.size > u8.length) return null;
    return u8.slice(entry.offset, entry.offset + entry.size);
  };

  C.tiffFindEntry = function (entries, tag) {
    for (const e of entries) if (e.tag === tag) return e;
    return null;
  };

  /* ============================== DNG =================================== */

  /* Walk IFD0 + SubIFDs (tag 330) + the IFD chain, returning every IFD. */
  C.dngFindIfds = function (u8) {
    const isLE = C.tiffIsLittleEndian(u8);
    if (!C.tiffIsValid(u8, isLE)) return null;
    const ifd0 = dvOf(u8).getUint32(4, isLE);
    const found = [];
    const seen = new Set();
    const walk = function (off, depth) {
      if (!off || depth > 8 || seen.has(off) || off + 2 > u8.length) return;
      seen.add(off);
      const entries = C.tiffReadIFD(u8, isLE, off);
      found.push({ offset: off, entries, isLE, depth });
      const sub = C.tiffFindEntry(entries, 330);
      if (sub && sub.count < 256) {
        for (const so of C.tiffEntryValues(u8, isLE, sub)) walk(so, depth + 1);
      }
      walk(C.tiffNextIFD(u8, isLE, off, entries.length), depth);
    };
    walk(ifd0, 0);
    return found.length ? found : null;
  };

  const area = function (ifd, u8) {
    const w = C.tiffFindEntry(ifd.entries, 256);
    const h = C.tiffFindEntry(ifd.entries, 257);
    const wv = w ? C.tiffEntryValues(u8, ifd.isLE, w)[0] : 0;
    const hv = h ? C.tiffEntryValues(u8, ifd.isLE, h)[0] : 0;
    return (wv || 0) * (hv || 0);
  };

  /* Find the full-resolution JPEG-compressed image among the DNG's IFDs. */
  C.dngFindJpegIfd = function (u8, ifds) {
    let best = null, bestArea = 0;
    for (const ifd of ifds) {
      const comp = C.tiffFindEntry(ifd.entries, 259);
      if (!comp) continue;
      const cv = C.tiffEntryValues(u8, ifd.isLE, comp)[0];
      if (cv !== 7) continue;
      const a = area(ifd, u8);
      if (a > bestArea) { bestArea = a; best = ifd; }
    }
    return best;
  };

  /* Scan a JPEG stream for its SOS (first) and EOI (last) marker, honouring byte stuffing. */
  const findSosEoi = function (s) {
    let sos = -1, eoi = -1, i = 0;
    while (i + 1 < s.length) {
      if (s[i] !== 0xff) { i++; continue; }
      const code = s[i + 1];
      if (code === 0x00 || code === 0xff) { i += 2; continue; }
      if (code === 0xda) { if (sos < 0) sos = i; i += 2; continue; }
      if (code === 0xd9) { eoi = i; i += 2; continue; }
      i += 2;
    }
    return { sos, eoi };
  };

  /* Multi-strip JPEG extraction: first strip keeps its tables; later strips contribute
     only their entropy-coded data (SOS…EOI), which is how libtiff JPEG strips are spliced. */
  C.stitchJpegStrips = function (strips) {
    const parts = [strips[0]];
    for (let i = 1; i < strips.length; i++) {
      const s = strips[i];
      const m = findSosEoi(s);
      if (m.sos < 0 || m.eoi < 0) throw new Error('A DNG strip is not a valid JPEG stream.');
      parts.push(s.subarray(m.sos, m.eoi + 2));
    }
    return concatBytes(parts);
  };

  const normalizeJpegStream = function (u8) {
    const m = findSosEoi(u8);
    if (m.eoi < 0) throw new Error('Extracted image data is not a valid JPEG.');
    return u8.slice(m.eoi === 0 ? 0 : 0, m.eoi + 2);
  };

  /* Extract the JPEG-compressed image from an IFD (strips or tiles). */
  C.dngExtractJpeg = function (u8, ifd) {
    const strips = C.tiffFindEntry(ifd.entries, 273);
    const tiles = C.tiffFindEntry(ifd.entries, 324);
    const widthE = C.tiffFindEntry(ifd.entries, 256);
    const heightE = C.tiffFindEntry(ifd.entries, 257);
    const width = widthE ? C.tiffEntryValues(u8, ifd.isLE, widthE)[0] : 0;
    const height = heightE ? C.tiffEntryValues(u8, ifd.isLE, heightE)[0] : 0;

    if (strips && strips.count && strips.count < 4096) {
      const offs = C.tiffEntryValues(u8, ifd.isLE, strips);
      const cntE = C.tiffFindEntry(ifd.entries, 279);
      const cnts = cntE ? C.tiffEntryValues(u8, ifd.isLE, cntE) : [];
      const chunks = offs.map(function (o, i) {
        const len = cnts[i] || 0;
        return (o >= 0 && o + len <= u8.length) ? u8.slice(o, o + len) : new Uint8Array(0);
      }).filter(function (c) { return c.length > 0; });
      if (!chunks.length) throw new Error('DNG strip data could not be located.');
      const stream = chunks.length === 1 ? normalizeJpegStream(chunks[0]) : C.stitchJpegStrips(chunks);
      return { jpeg: stream, width, height, tiled: false };
    }

    if (tiles && tiles.count && tiles.count < 4096) {
      const offs = C.tiffEntryValues(u8, ifd.isLE, tiles);
      const cntE = C.tiffFindEntry(ifd.entries, 325);
      const cnts = cntE ? C.tiffEntryValues(u8, ifd.isLE, cntE) : [];
      const tileW = C.tiffFindEntry(ifd.entries, 322);
      const tileH = C.tiffFindEntry(ifd.entries, 323);
      const tw = tileW ? C.tiffEntryValues(u8, ifd.isLE, tileW)[0] : 0;
      const th = tileH ? C.tiffEntryValues(u8, ifd.isLE, tileH)[0] : 0;
      const cols = tw ? Math.ceil(width / tw) : 1;
      const chunks = offs.map(function (o, i) {
        const len = cnts[i] || 0;
        return (o >= 0 && o + len <= u8.length) ? u8.slice(o, o + len) : new Uint8Array(0);
      }).filter(function (c) { return c.length > 0; });
      if (!chunks.length) throw new Error('DNG tile data could not be located.');
      return { tiles: chunks.map(normalizeJpegStream), cols, tileWidth: tw, tileHeight: th, width, height, tiled: true };
    }

    throw new Error('No JPEG-compressed image found in this DNG.');
  };

  /* ---- EXIF re-serializer: rebuild a compact TIFF/EXIF block from a DNG's IFD0,
     copying every value byte-for-byte, dropping bulky or image-data tags. ---- */

  const EXIF_SKIP = new Set([
    256, 257, 258, 259, 262, 273, 277, 278, 279, 282, 283, 284, 296, 317,
    322, 323, 324, 325, 330, 513, 514, 515, 516, 700, 34675,
    50706, 50707, 50708, 50739, 50829, 50830, 51008, 51009, 51183, 51206, 51209
  ]);

  const EXIF_KEEP_AT_ALL_COSTS = new Set([
    271, 272, 305, 274, 306, 315, 33432, 270, 36867, 36868, 37500, 34665, 34853
  ]);

  C.buildExifPayload = function (u8, ifd0Offset) {
    const isLE = C.tiffIsLittleEndian(u8);
    const ifd0 = C.tiffReadIFD(u8, isLE, ifd0Offset);
    const one = function (entries, tag) {
      const e = C.tiffFindEntry(entries, tag);
      if (!e) return null;
      return C.tiffEntryValues(u8, isLE, e)[0];
    };

    let exifEntries = null, gpsEntries = null, interopEntries = null;
    const exifOff = one(ifd0, 34665);
    const gpsOff = one(ifd0, 34853);
    if (exifOff) exifEntries = C.tiffReadIFD(u8, isLE, exifOff);
    if (gpsOff) gpsEntries = C.tiffReadIFD(u8, isLE, gpsOff);
    if (exifEntries) {
      const interopOff = one(exifEntries, 40965);
      if (interopOff) interopEntries = C.tiffReadIFD(u8, isLE, interopOff);
    }

    const filter = function (entries, kind) {
      const out = [];
      for (const e of entries || []) {
        if (kind !== 'ifd0' && (e.tag === 34665 || e.tag === 34853)) continue;
        if (kind === 'exif' && e.tag === 40965) continue;
        if (EXIF_SKIP.has(e.tag)) continue;
        if (e.tag === 37520 || e.tag === 37521) continue;
        out.push(e);
      }
      return out;
    };

    const tables = [
      { kind: 'ifd0', entries: filter(ifd0, 'ifd0') },
      { kind: 'exif', entries: filter(exifEntries, 'exif') },
      { kind: 'gps', entries: filter(gpsEntries, 'gps') },
      { kind: 'interop', entries: filter(interopEntries, 'interop') }
    ].filter(function (t) { return t.entries.length > 0; });

    /* serializable entries: inline values are copied as-is; external values need a blob */
    const serial = [];
    for (const t of tables) {
      for (const e of t.entries) {
        serial.push({ table: t.kind, entry: e, blob: e.inline ? null : C.tiffEntryData(u8, e) });
      }
    }

    /* drop oversized blobs first, then anything else, until the payload fits */
    let total = 8;
    for (const t of tables) total += 2 + t.entries.length * 12 + 4;
    for (const s of serial) if (s.blob) total += 4 + s.blob.length;

    const removable = serial.filter(function (s) {
      return s.blob && !EXIF_KEEP_AT_ALL_COSTS.has(s.entry.tag) && s.entry.size > 8;
    });
    removable.sort(function (a, b) { return b.entry.size - a.entry.size; });

    while (total > 65000 && removable.length) {
      const s = removable.pop();
      total -= 4 + s.blob.length;
      s.dropped = true;
    }
    if (total > 65000) throw new Error('EXIF metadata is too large to fit in a JPEG (over 64&nbsp;KB).');

    const live = serial.filter(function (s) { return !s.dropped; });

    /* layout: header (8) → tables → blobs (4-aligned) */
    const cursor = { at: 8 };
    const tableAddrs = {};
    for (const t of tables) {
      tableAddrs[t.kind] = cursor.at;
      cursor.at += 2 + t.entries.length * 12 + 4;
    }
    const blobAddrs = {};
    for (const s of live) {
      if (!s.blob) continue;
      cursor.at = Math.ceil(cursor.at / 4) * 4;
      blobAddrs[s.entry.tag + ':' + s.table] = cursor.at;
      cursor.at += s.blob.length;
    }

    const out = new Uint8Array(cursor.at);
    const dv = dvOf(out);
    out[0] = out[1] = isLE ? 0x49 : 0x4d;
    dv.setUint16(2, 42, isLE);
    dv.setUint32(4, tableAddrs.ifd0, isLE);

    const writeTable = function (t, addr, patchPointers) {
      const dvw = dvOf(out);
      dvw.setUint16(addr, t.entries.length, isLE);
      let p = addr + 2;
      for (const e of t.entries) {
        dvw.setUint16(p, e.tag, isLE);
        dvw.setUint16(p + 2, e.type, isLE);
        dvw.setUint32(p + 4, e.count, isLE);
        const s = live.find(function (x) { return x.entry === e; });
        const isPtr = patchPointers && patchPointers[e.tag];
        if (isPtr) {
          dvw.setUint32(p + 8, isPtr, isLE);
        } else if (e.inline) {
          for (let k = 0; k < 4; k++) out[p + 8 + k] = e.raw4[k];
        } else {
          dvw.setUint32(p + 8, blobAddrs[e.tag + ':' + t.kind], isLE);
        }
        p += 12;
      }
      dvw.setUint32(p, 0, isLE);
    };

    for (const t of tables) {
      const ptrs = {};
      if (t.kind === 'ifd0') {
        if (exifOff !== undefined && exifOff !== null) ptrs[34665] = tableAddrs.exif || 0;
        if (gpsOff !== undefined && gpsOff !== null) ptrs[34853] = tableAddrs.gps || 0;
      }
      if (t.kind === 'exif') {
        ptrs[40965] = tableAddrs.interop || 0;
      }
      writeTable(t, tableAddrs[t.kind], ptrs);
    }

    for (const s of live) {
      if (!s.blob) continue;
      const at = blobAddrs[s.entry.tag + ':' + s.table];
      out.set(s.blob, at);
    }

    return out;
  };

  /* Has GPS (tag 34853) in IFD0 of a TIFF block that may carry an Exif\0\0 prefix? */
  C.tiffHasGps = function (tiff) {
    if (!tiff || tiff.length < 14) return false;
    const off = startsWith(tiff, 0, 'Exif') ? 6 : 0;
    if (tiff.length < off + 8) return false;
    const dv = dvOf(tiff);
    const isLE = tiff[off] === 0x49;
    if (dv.getUint16(off + 2, isLE) !== 42) return false;
    const ifd0 = dv.getUint32(off + 4, isLE);
    if (off + ifd0 + 2 > tiff.length) return false;
    const entries = C.tiffReadIFD(tiff, isLE, off + ifd0);
    return entries.some(function (e) { return e.tag === 34853; });
  };

  /* =============================== HEIF ================================= */

  /* Parse the metadata items of a HEIF container: 'Exif', XMP ('mime') and ICC ('colr'). */
  C.parseHeifMetadata = function (u8) {
    const dv = dvOf(u8);
    let view = u8; /* file-level at first; rebound to the meta payload copy below */
    const fourcc = function (p) {
      if (p + 4 > view.length) return '';
      return String.fromCharCode(view[p], view[p + 1], view[p + 2], view[p + 3]);
    };
    const cstring = function (p) {
      let end = p;
      while (end < view.length && view[end] !== 0) end++;
      return { str: C.utf8String(view.subarray(p, end)), next: Math.min(end + 1, view.length) };
    };

    let metaPayload = null;
    let pos = 0;
    while (pos + 8 <= u8.length) {
      let size = dv.getUint32(pos);
      const type = fourcc(pos + 4);
      let hdr = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(pos + 8));
        hdr = 16;
      } else if (size === 0) {
        size = u8.length - pos;
      }
      if (type === 'meta') { metaPayload = u8.subarray(pos + hdr, pos + size); break; }
      pos += size;
    }
    if (!metaPayload) return {};

    /* children are indexed relative to metaPayload, so copy it into a standalone
     * buffer and parse against that; file-level reads (readItem method 0) still
     * use the full file view u8/dv. */
    const p8 = new Uint8Array(metaPayload);
    const pdv = dvOf(p8);
    view = p8;

    /* children of the meta box */
    let pitm = -1, idat = null;
    const items = {};          /* id -> {type, contentType} */
    const locations = {};      /* id -> {method, chunks: [{off, len}]} */
    let icc = null;

    let p = 4; /* meta is a FullBox */
    const walkChildren = function (start, end) {
      let q = start;
      while (q + 8 <= end) {
        let sz = pdv.getUint32(q);
        const ty = fourcc(q + 4);
        let hd = 8;
        if (sz === 1) { sz = Number(pdv.getBigUint64(q + 8)); hd = 16; }
        else if (sz === 0) sz = end - q;
        if (ty === 'pitm' && q + 12 <= end) {
          const ver = pdv.getUint8(q + hd);
          pitm = ver === 0 ? pdv.getUint16(q + hd + 4) : pdv.getUint32(q + hd + 4);
        } else if (ty === 'idat') {
          idat = p8.subarray(q + hd, Math.min(q + sz, end));
        } else if (ty === 'iinf') {
          const ver = pdv.getUint8(q + hd);
          let r = q + hd + 4;
          const count = ver === 0 ? pdv.getUint16(r) : pdv.getUint32(r);
          r += ver === 0 ? 2 : 4;
          for (let i = 0; i < count && r + 8 <= end; i++) {
            const isz = pdv.getUint32(r);
            if (fourcc(r + 4) !== 'infe') { r += Math.max(isz, 8); continue; }
            const iver = pdv.getUint8(r + 8);
            let ir = r + 12;
            const id = iver >= 3 ? pdv.getUint32(ir) : pdv.getUint16(ir);
            ir += iver >= 3 ? 4 : 2;
            ir += 2; /* protection index */
            let type = 'pict';
            if (iver >= 2) {
              type = fourcc(ir);
              ir += 4;
              const name = cstring(ir);
              ir = name.next;
              if (type === 'mime') {
                const ct = cstring(ir);
                items[id] = { type, contentType: ct.str };
              } else {
                items[id] = { type };
              }
            } else {
              items[id] = { type };
            }
            r += Math.max(isz, 8);
          }
        } else if (ty === 'iloc') {
          const ver = pdv.getUint8(q + hd);
          const b1 = pdv.getUint8(q + hd + 4);
          const b2 = pdv.getUint8(q + hd + 5);
          const offsetSize = b1 >> 4;
          const lengthSize = b1 & 0x0f;
          const baseOffsetSize = b2 >> 4;
          const indexSize = b2 & 0x0f;
          let r = q + hd + 6;
          const count = ver < 2 ? pdv.getUint16(r) : pdv.getUint32(r);
          r += ver < 2 ? 2 : 4;
          const readN = function (size, at) {
            let v = 0;
            for (let k = 0; k < size; k++) v = (v * 256) + p8[at + k];
            return v;
          };
          for (let i = 0; i < count && r + 8 <= end; i++) {
            const id = ver < 3 ? pdv.getUint16(r) : pdv.getUint32(r);
            r += ver < 3 ? 2 : 4;
            let method = 0;
            if (ver >= 1) { method = pdv.getUint16(r) >> 4; r += 2; }
            r += 2; /* data_reference_index */
            const base = readN(baseOffsetSize, r);
            r += baseOffsetSize;
            const extCount = pdv.getUint16(r);
            r += 2;
            const chunks = [];
            for (let e = 0; e < extCount && r < end; e++) {
              if (ver >= 1 && indexSize) r += indexSize;
              const eo = readN(offsetSize, r);
              r += offsetSize;
              const el = readN(lengthSize, r);
              r += lengthSize;
              chunks.push({ off: eo, len: el });
            }
            locations[id] = { method, base, chunks };
          }
        } else if (ty === 'iprp' && q + 8 <= end) {
          /* find ipco inside iprp */
          let r = q + hd;
          while (r + 8 <= q + sz && r + 8 <= end) {
            const psz = pdv.getUint32(r);
            if (fourcc(r + 4) === 'ipco') {
              let c = r + 8;
              while (c + 8 <= r + psz && c + 8 <= end) {
                const csz = pdv.getUint32(c);
                const cty = fourcc(c + 4);
                if (cty === 'colr' && c + 12 <= end) {
                  const colourType = fourcc(c + 8);
                  if (colourType === 'prof') {
                    const body = p8.subarray(c + 12, Math.min(c + csz, r + psz));
                    if (body.length > 100) icc = body;
                  }
                }
                c += Math.max(csz, 8);
              }
              break;
            }
            r += Math.max(psz, 8);
          }
        }
        q += Math.max(sz, 8);
      }
    };
    walkChildren(p, metaPayload.length);

    const readItem = function (id) {
      const loc = locations[id];
      if (!loc) return null;
      const parts = [];
      for (const ch of loc.chunks) {
        if (loc.method === 1) {
          if (!idat || ch.off + ch.len > idat.length) return null;
          parts.push(idat.subarray(ch.off, ch.off + ch.len));
        } else {
          const at = loc.base + ch.off;
          if (at + ch.len > u8.length) return null;
          parts.push(u8.subarray(at, at + ch.len));
        }
      }
      return concatBytes(parts);
    };

    const result = { icc, primaryId: pitm };
    for (const id of Object.keys(items)) {
      const item = items[id];
      if (item.type === 'Exif') {
        const data = readItem(id);
        if (!data) continue;
        let tiff = null;
        const tiffMagic = function (b) {
          return (b.length > 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
                                  (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)));
        };
        if (startsWith(data, 0, 'Exif')) {
          tiff = tiffMagic(data.subarray(6)) ? data.subarray(6) : null;
        } else if (data.length > 8) {
          /* Apple writes [u32 nameLength]["Exif\0\0"][TIFF] */
          const nameLen = dvOf(data).getUint32(0);
          if (nameLen > 0 && nameLen < data.length - 8) {
            const cand = data.subarray(4 + nameLen);
            if (tiffMagic(cand)) tiff = cand;
            else if (startsWith(cand, 0, 'Exif') && tiffMagic(cand.subarray(6))) tiff = cand.subarray(6);
          }
          if (!tiff && tiffMagic(data)) tiff = data;
        }
        if (tiff) result.exif = tiff;
      } else if (item.type === 'mime' && item.contentType === 'application/rdf+xml') {
        const data = readItem(id);
        if (!data) continue;
        let xml = data;
        if (startsWith(data, 0, 'application/rdf+xml') && data[20] === 0) xml = data.subarray(21);
        const str = C.utf8String(xml).replace(/^\uFEFF/, '');
        if (str.trim().length) result.xmp = str;
      }
    }
    return result;
  };

  /* ============================ converters ============================== */

  const decodeHeicToImageData = function (arrayBuffer, libheif) {
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(new Uint8Array(arrayBuffer));
    if (!images || !images.length) throw new Error('Could not decode this file as HEIC/HEIF.');
    let img = null;
    for (const im of images) if (im.is_primary && im.is_primary()) { img = im; break; }
    if (!img) img = images[0];
    const width = img.get_width();
    const height = img.get_height();
    if (!width || !height) throw new Error('Decoded image has no dimensions — unsupported HEIC variant.');
    return new Promise(function (resolve, reject) {
      const data = new Uint8ClampedArray(width * height * 4);
      img.display({ width, height, data: data }, function (displayData) {
        if (!displayData) reject(new Error('Decoding failed — this HEIC may be corrupt or use an unsupported codec.'));
        else resolve({ width, height, data: displayData.data });
      });
    });
  };

  const canvasFromImageData = function (width, height, data) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  };

  const canvasToJpeg = function (canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('JPEG encoding failed in this browser.'));
      }, 'image/jpeg', quality);
    });
  };

  /* Assemble the final JPEG from a base JPEG plus extracted metadata blocks. */
  C.assembleJpeg = function (baseJpeg, meta) {
    let stripped = C.jpegStripMetadata(baseJpeg);
    const segments = [];
    if (meta.exif && meta.exif.length > 8) {
      segments.push({ marker: 0xe1, payload: C.exifApp1Payload(meta.exif) });
    }
    if (meta.xmp && meta.xmp.length <= 64000) {
      segments.push({ marker: 0xe1, payload: C.xmpApp1Payload(meta.xmp) });
    }
    if (meta.icc && meta.icc.length >= 128) {
      segments.push.apply(segments, C.iccApp2Segments(meta.icc));
    }
    return C.jpegInjectSegments(stripped, segments);
  };

  /* Shared HEIC/HEIF conversion. Pixels: one decode + one encode at the chosen quality. */
  const convertHeif = async function (arrayBuffer, quality, libheif, mode) {
    const meta = C.parseHeifMetadata(new Uint8Array(arrayBuffer));
    const decoded = await decodeHeicToImageData(arrayBuffer, libheif);
    const canvas = canvasFromImageData(decoded.width, decoded.height, decoded.data);
    const blob = await canvasToJpeg(canvas, quality);
    const out = C.assembleJpeg(new Uint8Array(await blob.arrayBuffer()), meta);
    return {
      arrayBuffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
      width: decoded.width,
      height: decoded.height,
      meta,
      mode,
      quality: Math.round(quality * 100)
    };
  };

  /* Convert a HEIC file. Pixels: one decode + one encode at the chosen quality. */
  C.convertHeic = function (arrayBuffer, quality, libheif) {
    return convertHeif(arrayBuffer, quality, libheif, 'heic');
  };

  /* Convert a HEIF file. Pixels: one decode + one encode at the chosen quality. */
  C.convertHeif = function (arrayBuffer, quality, libheif) {
    return convertHeif(arrayBuffer, quality, libheif, 'heif');
  };

  /* Convert a ProRAW (DNG) file. Pixels: extracted verbatim from the embedded JPEG. */
  C.convertDng = async function (arrayBuffer, quality) {
    const u8 = new Uint8Array(arrayBuffer);
    if (u8.length < 12 || !C.tiffIsValid(u8, C.tiffIsLittleEndian(u8))) {
      throw new Error('Not a DNG/TIFF file.');
    }
    const ifds = C.dngFindIfds(u8);
    if (!ifds) throw new Error('Could not read the DNG structure.');
    const jpegIfd = C.dngFindJpegIfd(u8, ifds);
    const ifd0 = ifds[0];

    let meta = { icc: null, xmp: null, exif: null };
    try {
      const exif = C.buildExifPayload(u8, ifd0.offset);
      if (exif && exif.length > 8) meta.exif = exif;
    } catch (e) {
      meta.exifError = e.message;
    }
    const iccE = C.tiffFindEntry(ifd0.entries, 34675);
    if (iccE) {
      const icc = C.tiffEntryData(u8, iccE);
      if (icc && icc.length >= 128) meta.icc = icc;
    }
    const xmpE = C.tiffFindEntry(ifd0.entries, 700);
    if (xmpE) {
      const xmp = C.tiffEntryData(u8, xmpE);
      if (xmp) meta.xmp = C.utf8String(xmp).replace(/^\uFEFF/, '').replace(/\0+$/, '');
    }
    meta.gps = C.tiffHasGps(meta.exif || u8);

    if (!jpegIfd) {
      throw new Error(
        'This DNG stores raw sensor data only. Converting it requires demosaicing, which invents pixels — ReWrap never does that. ProRAW DNGs embed a full-quality JPEG; this file does not.'
      );
    }

    const extracted = C.dngExtractJpeg(u8, jpegIfd);
    if (!extracted.tiled) {
      const out = C.assembleJpeg(extracted.jpeg, meta);
      return {
        arrayBuffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
        width: extracted.width,
        height: extracted.height,
        meta,
        mode: 'dng'
      };
    }

    /* tiled JPEG DNGs: stitch tiles through a canvas (one re-encode, flagged honestly) */
    const canvas = document.createElement('canvas');
    canvas.width = extracted.width;
    canvas.height = extracted.height;
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < extracted.tiles.length; i++) {
      const tile = extracted.tiles[i];
      const bitmap = await createImageBitmap(new Blob([tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength)], { type: 'image/jpeg' }));
      const col = i % extracted.cols;
      const row = Math.floor(i / extracted.cols);
      ctx.drawImage(bitmap, col * extracted.tileWidth, row * extracted.tileHeight);
      bitmap.close();
    }
    const blob = await canvasToJpeg(canvas, quality);
    const out = C.assembleJpeg(new Uint8Array(await blob.arrayBuffer()), meta);
    return {
      arrayBuffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
      width: extracted.width,
      height: extracted.height,
      meta,
      mode: 'dng-tiles',
      quality: Math.round(quality * 100)
    };
  };

  /* ============================== UI ==================================== */

  if (typeof document === 'undefined') return;

  const $ = function (sel) { return document.querySelector(sel); };

  const state = {
    items: [],
    converting: false,
    stopRequested: false,
    usedNames: new Set()
  };

  let nextId = 1;

  const SUPPORTED = { heic: 'HEIC', heif: 'HEIF', dng: 'ProRAW (DNG)' };

  const libheifStatus = { state: 'loading' };

  window.addEventListener('libheif-ready', function () {
    libheifStatus.state = 'ready';
    renderDecoderNotice();
  });
  window.addEventListener('libheif-failed', function () {
    libheifStatus.state = 'failed';
    renderDecoderNotice();
  });

  const getLibheif = function () {
    let lib = window.libheif || null;
    if (lib && typeof lib === 'function') {
      try { lib = lib(); } catch (e) { return null; }
    }
    if (!lib || !lib.HeifDecoder) return null;
    window.libheif = lib;
    for (const k in lib) {
      if (/^(heif_|de265_)/.test(k) && typeof lib[k] === 'function') {
        try { window[k] = lib[k]; } catch (e) {}
      }
    }
    return lib;
  };

  const renderDecoderNotice = function () {
    if (libheifStatus.state !== 'failed') return;
    const summary = $('#queueSummary');
    if (!summary) return;
    const msg = document.createElement('span');
    msg.className = 'decoder-warning';
    msg.textContent = 'The HEIC/HEIF decoder could not be loaded (network or blocker issue). .dng files still work; .heic/.heif will show an error. Try reloading with a connection, or check for an ad-blocker.';
    summary.replaceChildren(msg);
  };

  const extOf = function (name) {
    const m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  };

  const baseOf = function (name) {
    return name.replace(/\.[^.]+$/, '');
  };

  const uniqueName = function (base) {
    let name = base + '.jpeg';
    let i = 1;
    while (state.usedNames.has(name)) {
      name = base + ' (' + i + ').jpeg';
      i++;
    }
    state.usedNames.add(name);
    return name;
  };

  const qualityValue = function () {
    return Math.min(1, Math.max(0, (parseInt($('#quality').value, 10) || 100) / 100));
  };

  /* ---------- row rendering ---------- */

  const rowTemplate = function (item) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = item.id;

    const main = document.createElement('div');
    main.className = 'row-main';
    const name = document.createElement('div');
    name.className = 'row-name';
    name.textContent = item.name;
    name.title = item.name;
    main.appendChild(name);
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    const subPieces = [SUPPORTED[item.ext] || item.ext.toUpperCase(), C.formatBytes(item.file.size)];
    if (item.outBlob) subPieces.push('→ ' + C.formatBytes(item.outBlob.size));
    sub.textContent = subPieces.join(' · ');
    main.appendChild(sub);
    li.appendChild(main);

    const status = document.createElement('div');
    status.className = 'row-status';
    li.appendChild(status);

    if (item.status === 'done') {
      const mf = renderManifest(item);
      li.appendChild(mf);
    }

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (item.status === 'done') {
      const save = iconButton('save', 'Save ' + item.outName, item.outName);
      actions.appendChild(save);
    }
    if (item.status === 'error') {
      const retry = iconButton('retry', 'Retry ' + item.name);
      actions.appendChild(retry);
    }
    const remove = iconButton('remove', 'Remove ' + item.name + ' from the queue');
    actions.appendChild(remove);
    li.appendChild(actions);

    if (item.status === 'error' && item.error) {
      const err = document.createElement('p');
      err.className = 'row-error-msg';
      err.textContent = item.error;
      li.appendChild(err);
    }

    return li;
  };

  const iconButton = function (kind, label, outName) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn' + (kind === 'save' ? ' save' : '');
    b.setAttribute('aria-label', label);
    b.dataset.act = kind;
    if (outName) b.dataset.out = outName;
    b.innerHTML = SVG_ICONS[kind];
    return b;
  };

  const SVG_ICONS = {
    save: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16 L12 4"/><path d="M7 9 L12 4 L17 9"/><path d="M4 20 L20 20"/></svg>',
    retry: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12 a8 8 0 1 1 -2.3 -5.7"/><path d="M20 3 L20 7 L16 7"/></svg>',
    remove: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 7 L20 7"/><path d="M9 7 L9 4 L15 4 L15 7"/><path d="M6.5 7 L7.5 20 L16.5 20 L17.5 7"/></svg>'
  };

  const renderManifest = function (item) {
    const wrap = document.createElement('div');
    wrap.className = 'manifest';
    wrap.setAttribute('aria-label', 'Metadata ledger for ' + item.outName);
    const meta = item.result.meta;
    const ok = '<span class="m-ok">✓</span>';
    const na = '<span class="m-na">—</span>';
    const line = function (k, v, okMark) {
      const d = document.createElement('div');
      d.className = 'm-line';
      d.innerHTML = '<span class="m-k"></span>'.replace('</span>', k + '</span>') +
        '<span class="m-v">' + v + '</span>' +
        (okMark === undefined ? '' : ' ' + okMark);
      return d;
    };

    const gpsNote = meta.gps ? ok + ' included in EXIF' : na + ' not present in source';
    const lines = [
      { k: 'EXIF', v: meta.exif ? C.formatBytes(meta.exif.length) + ' · copied verbatim' : (meta.exifError ? 'not copied — ' + meta.exifError : 'not present in source'), m: meta.exif ? ok : na },
      { k: 'GPS', v: gpsNote },
      { k: 'ICC', v: meta.icc ? C.formatBytes(meta.icc.length) + ' · copied verbatim' : 'not present in source', m: meta.icc ? ok : na },
      { k: 'XMP', v: meta.xmp ? C.formatBytes(meta.xmp.length) + ' · copied verbatim' : (meta.xmpDropped ? 'dropped — exceeds 64 KB JPEG limit' : 'not present in source'), m: meta.xmp ? ok : na }
    ];
    let pixelsLine;
    if (item.result.mode === 'dng') {
      pixelsLine = 'PIXELS  extracted verbatim from the DNG · 0 bytes changed · ' + item.result.width + '×' + item.result.height;
    } else if (item.result.mode === 'dng-tiles') {
      pixelsLine = 'PIXELS  tiled JPEG re-stitched and re-encoded once @ q' + item.result.quality + ' · ' + item.result.width + '×' + item.result.height;
    } else {
      pixelsLine = 'PIXELS  decoded once, re-encoded once @ q' + item.result.quality + ' · no resize, no rotate, no filter · ' + item.result.width + '×' + item.result.height;
    }

    for (const l of lines) wrap.appendChild(line(l.k, l.v, l.m));
    const p = document.createElement('div');
    p.className = 'm-line';
    p.innerHTML = '<span class="m-k">PIXELS</span><span class="m-v m-strong">' + pixelsLine.slice('PIXELS'.length).trim() + '</span>';
    wrap.appendChild(p);
    return wrap;
  };

  /* ---------- queue control ---------- */

  const addFiles = function (files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    let added = 0;
    for (const file of list) {
      const ext = extOf(file.name);
      if (!SUPPORTED[ext]) {
        state.items.push({
          id: nextId++, file, name: file.name, ext,
          status: 'error', error: 'Unsupported format — only .heic, .heif and .dng files are accepted.'
        });
        continue;
      }
      state.items.push({ id: nextId++, file, name: file.name, ext, status: 'queued' });
      added++;
    }
    $('#rows').appendChild(rowTemplate(state.items[state.items.length - list.length]));
    updateAll();
    if (added) startQueue();
  };

  const startQueue = async function () {
    if (state.converting) return;
    state.converting = true;
    state.stopRequested = false;
    $('#stopBtn').disabled = false;
    while (true) {
      if (state.stopRequested) break;
      const item = state.items.find(function (i) { return i.status === 'queued'; });
      if (!item) break;
      await convertOne(item);
      await new Promise(function (r) { setTimeout(r, 20); });
    }
    state.converting = false;
    $('#stopBtn').disabled = true;
    updateAll();
  };

  const convertOne = async function (item) {
    item.status = 'working';
    updateRow(item);
    try {
      const buf = await item.file.arrayBuffer();
      let result;
      const libheif = getLibheif();
      if (item.ext === 'dng') {
        result = await C.convertDng(buf, qualityValue());
      } else if (!libheif || !libheif.HeifDecoder) {
        if (libheifStatus.state === 'failed') {
          throw new Error('The HEIC/HEIF decoder could not be loaded — check your connection or ad-blocker, then reload.');
        }
        throw new Error('The HEIC decoder is still loading — please wait a moment and try again.');
      } else {
        result = item.ext === 'heif'
          ? await C.convertHeif(buf, qualityValue(), libheif)
          : await C.convertHeic(buf, qualityValue(), libheif);
      }
      item.result = result;
      item.outName = uniqueName(baseOf(item.name));
      item.outBlob = new Blob([result.arrayBuffer], { type: 'image/jpeg' });
      item.status = 'done';
      item.doneAt = Date.now();
      if ($('#autoSave').checked) saveItem(item);
    } catch (e) {
      item.status = 'error';
      item.error = e && e.message ? e.message : 'Conversion failed for an unknown reason.';
    }
    updateRow(item);
    updateAll();
  };

  const updateRow = function (item) {
    const li = document.querySelector('.row[data-id="' + item.id + '"]');
    if (!li) return;
    const fresh = rowTemplate(item);
    li.replaceWith(fresh);
  };

  const updateAll = function () {
    const total = state.items.length;
    const done = state.items.filter(function (i) { return i.status === 'done'; }).length;
    const errors = state.items.filter(function (i) { return i.status === 'error'; }).length;
    const working = state.items.filter(function (i) { return i.status === 'working'; }).length;

    const summary = $('#queueSummary');
    if (!total) {
      summary.textContent = 'Drop photos to begin — nothing happens until you add files.';
    } else {
      const bits = [];
      bits.push(done + ' of ' + total + ' converted');
      if (working) bits.push(working + ' converting');
      if (errors) bits.push(errors + ' failed');
      if (state.stopRequested) bits.push('stopped');
      summary.textContent = bits.join(' · ') + '.';
    }

    const prog = $('#progress');
    if (total) {
      prog.hidden = false;
      const pct = total ? Math.round(((done + errors) / total) * 100) : 0;
      prog.setAttribute('aria-valuenow', String(pct));
      $('#progressFill').style.width = pct + '%';
    } else {
      prog.hidden = true;
      prog.setAttribute('aria-valuenow', '0');
      $('#progressFill').style.width = '0%';
    }

    $('#zipBtn').disabled = done === 0;
    $('#clearBtn').disabled = total === 0;
    $('#stopBtn').disabled = !state.converting;

    const empty = $('#emptyState');
    empty.hidden = total > 0;
  };

  /* ---------- saving ---------- */

  const saveItem = function (item) {
    if (!item.outBlob) return;
    const url = URL.createObjectURL(item.outBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.outName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  };

  const downloadZip = async function () {
    if (typeof window.JSZip === 'undefined') {
      $('#queueSummary').textContent = 'ZIP support failed to load. Use the per-file Save buttons instead.';
      return;
    }
    const done = state.items.filter(function (i) { return i.status === 'done'; });
    const zip = new window.JSZip();
    for (const item of done) {
      zip.file(item.outName, item.outBlob, { compression: 'STORE' });
    }
    $('#zipBtn').disabled = true;
    $('#queueSummary').textContent = 'Packing ' + done.length + ' files into a ZIP…';
    try {
      const blob = await zip.generateAsync({ type: 'blob' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'rewrap-' + stamp + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
    } catch (e) {
      $('#queueSummary').textContent = 'ZIP failed: ' + (e && e.message ? e.message : 'unknown error');
    }
    updateAll();
  };

  /* ---------- events ---------- */

  const init = function () {
    const input = $('#fileInput');
    const dropzone = $('#dropzone');

    $('#pickBtn').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      addFiles(input.files);
      input.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropzone.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        dropzone.classList.remove('drag');
      });
    });
    dropzone.addEventListener('drop', function (e) {
      addFiles(e.dataTransfer.files);
    });

    $('#rows').addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const li = btn.closest('.row');
      const item = state.items.find(function (i) { return i.id === Number(li.dataset.id); });
      if (!item) return;
      const act = btn.dataset.act;
      if (act === 'save') saveItem(item);
      else if (act === 'retry') { item.status = 'queued'; item.error = null; item.outBlob = null; updateRow(item); updateAll(); startQueue(); }
      else if (act === 'remove') {
        const idx = state.items.indexOf(item);
        if (idx >= 0) state.items.splice(idx, 1);
        li.remove();
        updateAll();
      }
    });

    $('#zipBtn').addEventListener('click', downloadZip);

    $('#stopBtn').addEventListener('click', function () {
      state.stopRequested = true;
    });

    $('#clearBtn').addEventListener('click', function () {
      state.stopRequested = true;
      state.items = [];
      state.usedNames.clear();
      $('#rows').innerHTML = '';
      updateAll();
    });

    /* FAQ accordions */
    document.querySelectorAll('.faq-q').forEach(function (q) {
      q.addEventListener('click', function () {
        const item = q.closest('.faq-item');
        const open = item.classList.toggle('open');
        const a = item.querySelector('.faq-a');
        a.hidden = !open;
        q.setAttribute('aria-expanded', String(open));
      });
    });

    updateAll();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
