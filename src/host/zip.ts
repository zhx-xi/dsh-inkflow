/**
 * A store-only ZIP container (ADR-0018 D3), written from scratch because the plugin
 * has no runtime dependencies and a backup the author cannot open is not a backup.
 *
 * Shape: standard ZIP — a local file header and its payload per entry, then the
 * central directory, then the EOCD record. Every entry is **method 0 (stored)**: no
 * compressor, no decompressor, so the only arithmetic between the author's text and
 * the disk is a CRC-32. Deflate was rejected on purpose (ADR-0018 D3): a hand-rolled
 * compressor plus a hand-rolled expander is several hundred lines whose failure mode
 * is corrupting the one copy of a fifty-thousand-word book, and a store-only package
 * of that size is 3–5 MB.
 *
 * Why the reader walks the central directory instead of scanning for local file
 * headers: the central directory is the index a ZIP is *about*, and packages written
 * by other tools routinely carry comments or data descriptors that make a naive
 * "find PK\x03\x04 and read" scan point at bytes that are not a header. Reading the
 * directory also means the two headers must agree, which is what catches a package
 * assembled by a buggy writer.
 *
 * What this module refuses, and why refusal beats skipping: the bytes it reads become
 * files on the author's disk (ADR-0018 D6 restores by unpacking into a temporary
 * directory). A compressed entry it cannot expand, a zip64 marker whose real sizes
 * live in an extra field, and a name like `../escape.md` or `..\..\x` (the zip-slip
 * shapes) are all things whose "best effort" reading is a silent wrong answer, so each
 * one raises a `ZipError` with a code the caller can report.
 */

/** Every way this module can refuse a package. Named so a report can quote one. */
export type ZipErrorCode =
  /** The bytes are not a ZIP this module can even locate the directory of. */
  | 'ZIP_NOT_ZIP'
  /** A record the directory points at is cut short. */
  | 'ZIP_TRUNCATED'
  /** zip64 (the 0xFFFF/0xFFFFFFFF escape values) — the real values live in extra fields. */
  | 'ZIP64_UNSUPPORTED'
  /** A shape other than "stored entries in one file": spanned, encrypted. */
  | 'ZIP_UNSUPPORTED'
  /** A compressed entry: the payload cannot be expanded without a decompressor. */
  | 'ZIP_METHOD_UNSUPPORTED'
  /** The entry name would land outside the restore target, or is ambiguous. */
  | 'ZIP_PATH_INVALID'
  /** Two entries share one name, so a restore would have to pick one silently. */
  | 'ZIP_ENTRY_DUPLICATE'
  /** The stored payload no longer hashes to its recorded CRC-32. */
  | 'ZIP_CRC_MISMATCH'
  /** The payload is not the length the directory claims. */
  | 'ZIP_SIZE_MISMATCH'
  /** Beyond the 4 GiB a non-zip64 field can name. */
  | 'ZIP_TOO_LARGE'

/** A refusal, carrying the code a report quotes and a sentence a reader can act on. */
export class ZipError extends Error {
  readonly code: ZipErrorCode

  constructor(code: ZipErrorCode, message: string) {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

/** One file to store: `path` is archive-relative and always `/`-separated. */
export interface ZipWriteEntry {
  path: string
  bytes: Buffer | string
}

export interface ZipWriteOptions {
  /**
   * The timestamp written into every entry's MS-DOS date/time field. Defaults to now.
   * MS-DOS timestamps carry no timezone, so the components are read in local time —
   * the same reading a user gets when they look at the file in Explorer.
   */
  at?: Date
}

/** One file read back out of a package. */
export interface ZipEntry {
  path: string
  bytes: Buffer
}

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** Zip 2.0: the first version that names everything a stored entry needs. */
const VERSION_NEEDED = 20

/** General purpose bit 11: "the name is UTF-8", which keeps a Chinese file name intact. */
const FLAG_UTF8_NAME = 0x0800

/** Bit 0 of the same field: the payload is encrypted. */
const FLAG_ENCRYPTED = 0x0001

const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22

/** The four 32-bit fields that escape to a zip64 extra field when they overflow. */
const MAX_UINT16 = 0xffff
const MAX_UINT32 = 0xffffffff

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3, the polynomial ZIP uses)
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | undefined

/**
 * The 256-entry lookup table, built on first use.
 *
 * Table-driven rather than bitwise-per-byte because a backup hashes every byte of the
 * book; the table is built once per process and is 1 KiB.
 */
function table(): Uint32Array {
  if (crcTable !== undefined) return crcTable
  const built = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    built[index] = value >>> 0
  }
  crcTable = built
  return built
}

/**
 * CRC-32 of `bytes`, as an unsigned 32-bit integer.
 *
 * Exported because it is checked against `node:zlib` in the tests and because the next
 * consumer of a package (the settings/backup work) verifies its own copies with it.
 */
export function crc32(bytes: Uint8Array): number {
  const lookup = table()
  let crc = MAX_UINT32
  for (const byte of bytes) crc = (crc >>> 8) ^ (lookup[(crc ^ byte) & 0xff] ?? 0)
  return (crc ^ MAX_UINT32) >>> 0
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Refuse an entry name a restore could not place, and return it unchanged.
 *
 * The two hazards this closes are the zip-slip family: `../escape.md` climbs out of the
 * target directory, and on Windows `..\..\x` climbs out even though a split on `/` sees
 * one ordinary segment — which is why a backslash is refused on the read side instead
 * of being treated as a separator. An absolute name (leading `/`, a drive letter, UNC)
 * and an empty segment (`a//b`, a trailing `/`, which is how tools spell a directory
 * entry) are refused for the same reason: two tools resolve those names differently.
 */
function checkEntryPath(path: string): string {
  if (path === '') throw new ZipError('ZIP_PATH_INVALID', 'an entry name is required')
  if (path.includes('\u0000')) throw new ZipError('ZIP_PATH_INVALID', `the entry name ${JSON.stringify(path)} holds a NUL byte`)
  if (path.includes('\\')) {
    throw new ZipError('ZIP_PATH_INVALID', `the entry name ${JSON.stringify(path)} uses a backslash; archive paths are \`/\`-separated`)
  }
  if (path.startsWith('/') || path.startsWith('//') || /^[a-zA-Z]:/.test(path)) {
    throw new ZipError('ZIP_PATH_INVALID', `the entry name ${JSON.stringify(path)} is absolute; a package names files relative to its root`)
  }
  for (const segment of path.split('/')) {
    if (segment === '') {
      throw new ZipError('ZIP_PATH_INVALID', `the entry name ${JSON.stringify(path)} has an empty segment`)
    }
    if (segment === '.' || segment === '..') {
      throw new ZipError('ZIP_PATH_INVALID', `the entry name ${JSON.stringify(path)} climbs out of the target directory`)
    }
  }
  return path
}

/**
 * The name a caller's path is stored under: separators normalised, then validated.
 *
 * A Windows caller writes `chapters\vol-01\0001-a.md`; the archive stores
 * `chapters/vol-01/0001-a.md`, so the package means the same thing on every platform.
 */
function normalizeWritePath(path: string): string {
  if (typeof path !== 'string') throw new ZipError('ZIP_PATH_INVALID', 'an entry name must be a string')
  return checkEntryPath(path.replaceAll('\\', '/'))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** MS-DOS date/time, in local time, clamped to the 1980–2107 the fields can name. */
function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, at.getFullYear()))
  const date = ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
  // Seconds are stored in two-second steps, which is why a package round trip cannot
  // promise an odd second.
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2)
  return { time, date }
}

/**
 * Build a store-only ZIP from `entries`, in the order given.
 *
 * Order is the caller's because a restore replays files in the order a batch recorded
 * them, not the order a directory listing happens to produce.
 */
export function writeZip(entries: ZipWriteEntry[], options: ZipWriteOptions = {}): Buffer {
  if (!Array.isArray(entries)) throw new ZipError('ZIP_NOT_ZIP', 'a package is built from an array of entries')
  const { time, date } = dosStamp(options.at ?? new Date())

  const prepared: Array<{ name: string; nameBytes: Buffer; body: Buffer; crc: number; offset: number }> = []
  const seen = new Set<string>()
  let offset = 0
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) throw new ZipError('ZIP_PATH_INVALID', 'an entry must be `{ path, bytes }`')
    const name = normalizeWritePath(entry.path)
    if (seen.has(name)) throw new ZipError('ZIP_ENTRY_DUPLICATE', `two entries are named ${name}`)
    seen.add(name)
    const body = typeof entry.bytes === 'string' ? Buffer.from(entry.bytes, 'utf8') : Buffer.from(entry.bytes)
    const nameBytes = Buffer.from(name, 'utf8')
    if (nameBytes.length > MAX_UINT16) throw new ZipError('ZIP_TOO_LARGE', `the entry name ${name} is too long for a zip field`)
    if (body.length > MAX_UINT32 - 1) throw new ZipError('ZIP_TOO_LARGE', `${name} is larger than the 4 GiB a stored entry can name`)
    if (offset > MAX_UINT32 - 1) throw new ZipError('ZIP_TOO_LARGE', 'the package would need zip64 offsets')
    prepared.push({ name, nameBytes, body, crc: crc32(body), offset })
    offset += LOCAL_HEADER_SIZE + nameBytes.length + body.length
  }

  const chunks: Buffer[] = []
  const central: Buffer[] = []
  for (const entry of prepared) {
    const local = Buffer.alloc(LOCAL_HEADER_SIZE)
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(FLAG_UTF8_NAME, 6)
    local.writeUInt16LE(0, 8) // method 0: stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.body.length, 18) // compressed size == stored size
    local.writeUInt32LE(entry.body.length, 22) // uncompressed size
    local.writeUInt16LE(entry.nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // no extra field
    chunks.push(local, entry.nameBytes, entry.body)

    const record = Buffer.alloc(CENTRAL_HEADER_SIZE)
    record.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
    // Version made by 2.0 on MS-DOS: nothing platform-specific to record, and Windows
    // Explorer reads a package written this way without complaint.
    record.writeUInt16LE(VERSION_NEEDED, 4)
    record.writeUInt16LE(VERSION_NEEDED, 6)
    record.writeUInt16LE(FLAG_UTF8_NAME, 8)
    record.writeUInt16LE(0, 10) // method 0
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(entry.crc, 16)
    record.writeUInt32LE(entry.body.length, 20)
    record.writeUInt32LE(entry.body.length, 24)
    record.writeUInt16LE(entry.nameBytes.length, 28)
    record.writeUInt16LE(0, 30) // extra field length
    record.writeUInt16LE(0, 32) // comment length
    record.writeUInt16LE(0, 34) // disk number
    record.writeUInt16LE(0, 36) // internal attributes
    record.writeUInt32LE(0, 38) // external attributes
    record.writeUInt32LE(entry.offset, 42)
    central.push(record, entry.nameBytes)
  }

  const directoryOffset = offset
  const directorySize = central.reduce((total, chunk) => total + chunk.length, 0)

  const eocd = Buffer.alloc(EOCD_SIZE)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk holding the directory
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(directorySize, 12)
  eocd.writeUInt32LE(directoryOffset, 16)
  eocd.writeUInt16LE(0, 20) // no archive comment

  return Buffer.concat([...chunks, ...central, eocd])
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Where the EOCD record starts, scanning from the end (an archive comment may pad it). */
function findEndRecord(bytes: Buffer): number {
  if (bytes.length < EOCD_SIZE) {
    throw new ZipError('ZIP_NOT_ZIP', `the package is ${bytes.length} bytes, shorter than an end record`)
  }
  for (let offset = bytes.length - EOCD_SIZE; offset >= 0; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== EOCD_SIG) continue
    if (offset + EOCD_SIZE + bytes.readUInt16LE(offset + 20) === bytes.length) return offset
  }
  throw new ZipError('ZIP_NOT_ZIP', 'no end-of-central-directory record: this is not a ZIP')
}

/**
 * Read a package back into `{ path, bytes }` entries, in directory order.
 *
 * Every entry is verified against its recorded CRC-32 and length before it is handed
 * back: a restore that writes a corrupted chapter over a good one is worse than a
 * restore that stops and says which file is damaged.
 */
export function readZip(bytes: Buffer): ZipEntry[] {
  if (!Buffer.isBuffer(bytes)) throw new ZipError('ZIP_NOT_ZIP', 'a package is read from a Buffer')
  const eocd = findEndRecord(bytes)

  const diskNumber = bytes.readUInt16LE(eocd + 4)
  const directoryDisk = bytes.readUInt16LE(eocd + 6)
  const onThisDisk = bytes.readUInt16LE(eocd + 8)
  const total = bytes.readUInt16LE(eocd + 10)
  const directorySize = bytes.readUInt32LE(eocd + 12)
  const directoryOffset = bytes.readUInt32LE(eocd + 16)

  // The escape values are how zip64 says "look in an extra field"; this reader does
  // not read extra fields, so it says so instead of guessing at 16-bit-high counts.
  if (total === MAX_UINT16 || onThisDisk === MAX_UINT16 || directorySize === MAX_UINT32 || directoryOffset === MAX_UINT32) {
    throw new ZipError('ZIP64_UNSUPPORTED', 'the package needs zip64; this reader only reads the 32-bit form')
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || onThisDisk !== total) {
    throw new ZipError('ZIP_UNSUPPORTED', 'the package is split across disks')
  }
  if (directoryOffset + directorySize > eocd) {
    throw new ZipError('ZIP_TRUNCATED', 'the central directory runs past the end record')
  }

  const out: ZipEntry[] = []
  const seen = new Set<string>()
  let at = directoryOffset
  for (let index = 0; index < total; index += 1) {
    if (at + CENTRAL_HEADER_SIZE > bytes.length) {
      throw new ZipError('ZIP_TRUNCATED', `central directory record ${index + 1} of ${total} is cut short`)
    }
    if (bytes.readUInt32LE(at) !== CENTRAL_HEADER_SIG) {
      throw new ZipError('ZIP_NOT_ZIP', `central directory record ${index + 1} of ${total} has no signature`)
    }
    const flags = bytes.readUInt16LE(at + 8)
    const method = bytes.readUInt16LE(at + 10)
    const crc = bytes.readUInt32LE(at + 16)
    const compressedSize = bytes.readUInt32LE(at + 20)
    const size = bytes.readUInt32LE(at + 24)
    const nameLength = bytes.readUInt16LE(at + 28)
    const extraLength = bytes.readUInt16LE(at + 30)
    const commentLength = bytes.readUInt16LE(at + 32)
    const localOffset = bytes.readUInt32LE(at + 42)
    if (at + CENTRAL_HEADER_SIZE + nameLength > bytes.length) {
      throw new ZipError('ZIP_TRUNCATED', `central directory record ${index + 1} of ${total} has no room for its name`)
    }
    // The name is decoded as UTF-8 whatever the flag says: bit 11 marks UTF-8, and a
    // package this plugin writes always sets it. Reading a legacy CP437 name as UTF-8
    // yields replacement characters, which the path check below refuses rather than
    // writing a file whose name nobody can reproduce.
    const name = bytes.toString('utf8', at + CENTRAL_HEADER_SIZE, at + CENTRAL_HEADER_SIZE + nameLength)

    if (compressedSize === MAX_UINT32 || size === MAX_UINT32 || localOffset === MAX_UINT32) {
      throw new ZipError('ZIP64_UNSUPPORTED', `${name} needs a zip64 field for its size or offset`)
    }
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipError('ZIP_UNSUPPORTED', `${name} is encrypted; a backup the plugin cannot open is not a backup`)
    }
    if (method !== 0) {
      throw new ZipError(
        'ZIP_METHOD_UNSUPPORTED',
        `${name} is compressed (method ${method}); this reader only restores stored entries`,
      )
    }
    const path = checkEntryPath(name)
    if (seen.has(path)) throw new ZipError('ZIP_ENTRY_DUPLICATE', `two entries are named ${path}`)
    seen.add(path)

    // The local header is what actually precedes the payload, so both headers have to
    // agree before the offset the directory gives can be trusted.
    if (localOffset + LOCAL_HEADER_SIZE > bytes.length) {
      throw new ZipError('ZIP_TRUNCATED', `the local header of ${path} is cut short`)
    }
    if (bytes.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG) {
      throw new ZipError('ZIP_NOT_ZIP', `the directory points at no local header for ${path}`)
    }
    if (bytes.readUInt16LE(localOffset + 8) !== 0) {
      throw new ZipError('ZIP_METHOD_UNSUPPORTED', `the local header of ${path} is compressed`)
    }
    const payloadStart =
      localOffset + LOCAL_HEADER_SIZE + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28)
    const payloadEnd = payloadStart + compressedSize
    if (payloadEnd > bytes.length) throw new ZipError('ZIP_TRUNCATED', `the payload of ${path} is cut short`)

    const body = Buffer.from(bytes.subarray(payloadStart, payloadEnd))
    if (body.length !== size) {
      throw new ZipError('ZIP_SIZE_MISMATCH', `${path} holds ${body.length} bytes but the directory says ${size}`)
    }
    const actual = crc32(body)
    if (actual !== crc) {
      throw new ZipError(
        'ZIP_CRC_MISMATCH',
        `${path} does not match its CRC-32 (recorded ${crc.toString(16)}, actual ${actual.toString(16)})`,
      )
    }
    out.push({ path, bytes: body })
    at += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength
  }

  return out
}
