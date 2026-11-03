/**
 * Browser recordings (MediaRecorder) are written live, so their WebM never
 * says how long it is: players show no duration and can't scrub. Once a
 * recording is complete, this reads the time of its last frame and writes the
 * duration into the file's header. Anything unexpected leaves the file as is.
 */
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const CLUSTER = 0x1f43b675;
const CUES = 0x1c53bb6b;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
/** Cluster children that carry no frames (Position, PrevSize, Void). */
const CLUSTER_OTHER = new Set([0xa7, 0xab, 0xec]);

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 8 * 1024 * 1024;

function readId(b: Buffer, p: number): { id: number; len: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  const len = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  if (!len || p + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
  return { id, len };
}

function readSize(b: Buffer, p: number): { size: number; len: number; unknown: boolean } | null {
  if (p >= b.length) return null;
  const first = b[p];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || p + len > b.length) return null;
  const mask = 0xff >> len;
  let size = first & mask;
  let unknown = size === mask;
  for (let i = 1; i < len; i++) {
    size = size * 256 + b[p + i];
    if (b[p + i] !== 0xff) unknown = false;
  }
  return { size, len, unknown };
}

function readUint(b: Buffer, p: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[p + i];
  return v;
}

/** An 8-byte EBML size (or the shortest given length that fits). */
function encodeSize(size: number, len = 8): Buffer | null {
  if (size >= 2 ** (7 * len) - 1) return null;
  const out = Buffer.alloc(len);
  let v = size;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

interface Layout {
  segmentSizeAt: number;
  segmentSize: { size: number; len: number; unknown: boolean };
  info: { start: number; dataStart: number; end: number; hasDuration: boolean; scale: number };
}

/** Where the header's Info element is, in the first bytes of the file. */
function layout(head: Buffer): Layout | null {
  const e = readId(head, 0);
  const es = e && readSize(head, e.len);
  if (!e || e.id !== EBML || !es || es.unknown) return null;
  let p = e.len + es.len + es.size;
  const seg = readId(head, p);
  const ss = seg && readSize(head, p + seg.len);
  if (!seg || seg.id !== SEGMENT || !ss) return null;
  const segmentSizeAt = p + seg.len;
  p = segmentSizeAt + ss.len;
  while (p < head.length) {
    const el = readId(head, p);
    const sz = el && readSize(head, p + el.len);
    if (!el || !sz || sz.unknown) return null;
    // Positions in a seek index would shift: leave such files alone (MediaRecorder writes none).
    if (el.id === SEEK_HEAD || el.id === CLUSTER) return null;
    const dataStart = p + el.len + sz.len;
    const end = dataStart + sz.size;
    if (el.id === INFO) {
      if (end > head.length) return null;
      let hasDuration = false;
      let scale = 1_000_000;
      for (let q = dataStart; q < end; ) {
        const c = readId(head, q);
        const cs = c && readSize(head, q + c.len);
        if (!c || !cs || cs.unknown) return null;
        const v = q + c.len + cs.len;
        if (c.id === DURATION) hasDuration = true;
        if (c.id === TIMECODE_SCALE && cs.size >= 1 && cs.size <= 8) scale = readUint(head, v, cs.size) || scale;
        q = v + cs.size;
      }
      return { segmentSizeAt, segmentSize: ss, info: { start: p, dataStart, end, hasDuration, scale } };
    }
    p = end;
  }
  return null;
}

/** The time of the last frame of the cluster starting at `p`, or null if this isn't one. */
function clusterEnd(b: Buffer, p: number): number | null {
  const sz = readSize(b, p + 4);
  if (!sz) return null;
  let q = p + 4 + sz.len;
  const end = sz.unknown ? b.length : Math.min(b.length, q + sz.size);
  let tc: number | null = null;
  let last = 0;
  while (q < end) {
    const c = readId(b, q);
    const cs = c && readSize(b, q + c.len);
    if (!c || !cs || cs.unknown) break;
    const v = q + c.len + cs.len;
    if (c.id === TIMECODE) {
      if (tc !== null || cs.size < 1 || cs.size > 8 || v + cs.size > b.length) return null;
      tc = readUint(b, v, cs.size);
    } else if (c.id === SIMPLE_BLOCK || c.id === BLOCK_GROUP) {
      if (tc === null) return null;
      let blk = v;
      if (c.id === BLOCK_GROUP) {
        const bi = readId(b, v);
        const bs = bi && readSize(b, v + bi.len);
        if (!bi || bi.id !== BLOCK || !bs) break;
        blk = v + bi.len + bs.len;
      }
      const track = readSize(b, blk);
      if (!track || blk + track.len + 2 > b.length) break;
      last = Math.max(last, b.readInt16BE(blk + track.len));
    } else if (c.id === CLUSTER || c.id === CUES) break;
    else if (!CLUSTER_OTHER.has(c.id)) {
      if (tc === null) return null;
      break;
    }
    q = v + cs.size;
  }
  // A real cluster starts with its time; one found inside frame data almost never does.
  return tc === null || tc > 1e9 ? null : tc + last;
}

/** The time of the last frame, in the file's time units, from its last cluster. */
function lastFrameTime(tail: Buffer): number | null {
  for (let i = tail.length - 5; i >= 0; i--) {
    if (tail[i] !== 0x1f || tail[i + 1] !== 0x43 || tail[i + 2] !== 0xb6 || tail[i + 3] !== 0x75) continue;
    const t = clusterEnd(tail, i);
    if (t !== null) return t;
  }
  return null;
}

/**
 * Write the duration into a finished recording. Returns its length in
 * milliseconds (null when the file couldn't be read as a WebM recording).
 */
export async function finishWebm(file: string): Promise<number | null> {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    fs.readSync(fd, head, 0, head.length, 0);
    const lay = layout(head);
    if (!lay) return null;
    const tailLen = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    fs.closeSync(fd);
    fd = null;
    const last = lastFrameTime(tail);
    if (last === null) return null;
    const ms = Math.round((last * lay.info.scale) / 1e6);
    if (lay.info.hasDuration) return ms;

    // Info gains a Duration (a float in the file's time units): ID 0x4489, size 8.
    const duration = Buffer.alloc(11);
    duration.writeUInt16BE(DURATION, 0);
    duration[2] = 0x88;
    duration.writeDoubleBE(last, 3);
    const payload = Buffer.concat([head.subarray(lay.info.dataStart, lay.info.end), duration]);
    const infoSize = encodeSize(payload.length);
    if (!infoSize) return null;
    const info = Buffer.concat([head.subarray(lay.info.start, lay.info.start + readId(head, lay.info.start)!.len), infoSize, payload]);
    const grown = info.length - (lay.info.end - lay.info.start);
    let before = head.subarray(0, lay.info.start);
    if (!lay.segmentSize.unknown) {
      // A segment of known size grows by the same amount, written in the same number of bytes.
      const segSize = encodeSize(lay.segmentSize.size + grown, lay.segmentSize.len);
      if (!segSize) return null;
      before = Buffer.from(before);
      segSize.copy(before, lay.segmentSizeAt);
    }
    const tmp = `${file}.tmp`;
    try {
      const out = fs.createWriteStream(tmp);
      out.write(before);
      out.write(info);
      await pipeline(fs.createReadStream(file, { start: lay.info.end }), out);
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
      return null;
    }
    return ms;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
