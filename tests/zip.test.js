/**
 * The store-only ZIP container (ADR-0018 D3, code half).
 *
 * A backup is a safety net, so the container is deliberately dumb: every entry is
 * stored (method 0) and the CRC-32 is computed here, because the project has no
 * compression library and a hand-rolled deflate would put the only copy of a book
 * behind several hundred lines of arithmetic. What these tests pin down is the part
 * that hurts when it is wrong:
 *
 *   * the bytes survive a round trip (including a subdirectory, an empty file and a
 *     Chinese file name), and the order of the entries is the order they were given;
 *   * the container is a real ZIP — a central directory an external tool can find,
 *     not only local file headers (`readZip` walks that directory, so a package whose
 *     central directory is wrong fails the test that reads it back);
 *   * the reader refuses what it cannot restore safely instead of unpacking half of
 *     it: compressed entries, zip64, and names that would escape the target directory.
 *
 * The header layout is read here by hand rather than with the module's own parser, so
 * a mistake in the writer cannot be hidden by the same mistake in the reader.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { ZipError, crc32, readZip, writeZip } from '../lib/index.js'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

// ---------------------------------------------------------------------------
// Reading the container by hand (independent of src/host/zip.ts)
// ---------------------------------------------------------------------------

/** The end-of-central-directory record, found from the back (a comment may pad it). */
function eocdOffset(buf) {
  for (let offset = buf.length - 22; offset >= 0; offset -= 1) {
    if (buf.readUInt32LE(offset) !== EOCD_SIG) continue
    const commentLength = buf.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buf.length) return offset
  }
  return -1
}

function centralEntries(buf) {
  const eocd = eocdOffset(buf)
  assert.ok(eocd >= 0, 'the package ends with an EOCD record')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let index = 0; index < count; index += 1) {
    assert.equal(buf.readUInt32LE(offset), CENTRAL_SIG, 'every central directory record starts with its signature')
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    out.push({
      at: offset,
      name: buf.toString('utf8', offset + 46, offset + 46 + nameLength),
      versionNeeded: buf.readUInt16LE(offset + 6),
      flags: buf.readUInt16LE(offset + 8),
      method: buf.readUInt16LE(offset + 10),
      time: buf.readUInt16LE(offset + 12),
      date: buf.readUInt16LE(offset + 14),
      crc: buf.readUInt32LE(offset + 16),
      compressedSize: buf.readUInt32LE(offset + 20),
      size: buf.readUInt32LE(offset + 24),
      localOffset: buf.readUInt32LE(offset + 42),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return out
}

/** Where one named entry's payload starts, following its local file header. */
function payloadOffset(buf, entry) {
  const at = entry.localOffset
  assert.equal(buf.readUInt32LE(at), LOCAL_SIG, 'a central directory record points at a local file header')
  return at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
}

/** Replace a run of bytes in place. Used to build the packages the reader must refuse. */
function patchBytes(buf, from, to) {
  const needle = Buffer.from(from, 'utf8')
  const replacement = Buffer.from(to, 'utf8')
  assert.equal(needle.length, replacement.length, `the patch keeps the layout (${from} -> ${to})`)
  const copy = Buffer.from(buf)
  let hits = 0
  let index = copy.indexOf(needle)
  while (index >= 0) {
    replacement.copy(copy, index)
    hits += 1
    index = copy.indexOf(needle, index + needle.length)
  }
  assert.ok(hits > 0, `${from} appears in the package`)
  return copy
}

/** One valid package to patch into an invalid one. */
function samplePackage() {
  return writeZip([{ path: 'xe/escape.md', bytes: 'payload that is long enough\n' }], {
    at: new Date(2026, 9, 24, 17, 13, 30),
  })
}

function codeOf(fn) {
  try {
    fn()
  } catch (cause) {
    assert.ok(cause instanceof ZipError, `expected a ZipError, got ${String(cause)}`)
    return cause.code
  }
  return 'DID_NOT_THROW'
}

// ---------------------------------------------------------------------------
// 1. Round trip
// ---------------------------------------------------------------------------

test('zip: a written package reads back byte for byte, in the order it was written', () => {
  const entries = [
    { path: 'inkflow.json', bytes: '{"schemaVersion":1}\n' },
    { path: 'chapters/vol-01/0001-入山.md', bytes: '第一章 入山\n\n他在雨里等了半日。\n' },
    { path: 'characters/空文件.md', bytes: '' },
    { path: 'world/门派/白鹤门.md', bytes: Buffer.from('山门向北\n', 'utf8') },
  ]
  const bytes = writeZip(entries, { at: new Date(2026, 9, 24, 17, 13, 30) })
  const read = readZip(bytes)

  assert.deepEqual(
    read.map((entry) => entry.path),
    entries.map((entry) => entry.path),
    'the order of the entries is the order they were given',
  )
  for (const [index, source] of entries.entries()) {
    const original = Buffer.isBuffer(source.bytes) ? source.bytes : Buffer.from(source.bytes, 'utf8')
    assert.equal(Buffer.compare(read[index].bytes, original), 0, `${source.path} survives the round trip`)
    assert.ok(Buffer.isBuffer(read[index].bytes), `${source.path} comes back as bytes`)
  }
  // Strings are UTF-8 on the way in, so a Chinese body is not decoded twice.
  assert.equal(read[1].bytes.toString('utf8'), entries[1].bytes)
})

test('zip: the container is a real ZIP — central directory, stored entries, UTF-8 names', () => {
  const entries = [
    { path: 'a.md', bytes: 'alpha\n' },
    { path: 'b/c.md', bytes: 'charlie\n' },
  ]
  const bytes = writeZip(entries, { at: new Date(2026, 9, 24, 17, 13, 30) })

  // The local file header comes first, then the payloads, then the central directory.
  assert.equal(bytes.readUInt32LE(0), LOCAL_SIG, 'the package starts with a local file header')
  const central = centralEntries(bytes)
  assert.equal(central.length, 2, 'one central directory record per entry')
  assert.deepEqual(
    central.map((entry) => entry.name),
    entries.map((entry) => entry.path),
  )
  for (const [index, entry] of central.entries()) {
    const body = Buffer.from(entries[index].bytes, 'utf8')
    assert.equal(entry.method, 0, 'method 0 (stored): the package is readable without a decompressor')
    assert.equal(entry.versionNeeded, 20, 'version 2.0 is what zip64-free stored entries need')
    assert.equal(entry.crc, crc32(body), 'the stored CRC-32 is the CRC-32 of the payload')
    assert.equal(entry.compressedSize, body.length, 'a stored entry compresses to its own size')
    assert.equal(entry.size, body.length, 'a stored entry decompresses to its own size')
    // Bit 11 says "the name is UTF-8", which is what lets a Chinese file name open in
    // Explorer as itself instead of a row of CP437 mojibake.
    assert.equal(entry.flags & 0x0800, 0x0800, 'the UTF-8 name flag is set')
    assert.equal(bytes.readUInt32LE(entry.localOffset), LOCAL_SIG)
    // The payload really is at the offset the two headers claim.
    const start = payloadOffset(bytes, entry)
    assert.equal(Buffer.compare(bytes.subarray(start, start + body.length), body), 0)
  }
})

test('zip: a Windows separator in an entry path is written as a forward slash', () => {
  const bytes = writeZip([{ path: 'chapters\\vol-01\\0001-a.md', bytes: 'x\n' }])
  assert.deepEqual(
    centralEntries(bytes).map((entry) => entry.name),
    ['chapters/vol-01/0001-a.md'],
    'the archive separator is `/`, whatever the caller typed',
  )
  assert.deepEqual(
    readZip(bytes).map((entry) => entry.path),
    ['chapters/vol-01/0001-a.md'],
  )
})

// ---------------------------------------------------------------------------
// 2. Timestamps (MS-DOS date/time fields)
// ---------------------------------------------------------------------------

test('zip: the MS-DOS timestamp comes from `at`, in local time', () => {
  const at = new Date(2026, 9, 24, 17, 13, 30) // 2026-10-24 17:13:30 local
  const [entry] = centralEntries(writeZip([{ path: 'a.md', bytes: 'x' }], { at }))
  assert.equal(entry.date >> 9, 2026 - 1980, 'the date field counts years from 1980')
  assert.equal((entry.date >> 5) & 0x0f, 10, 'October is month 10')
  assert.equal(entry.date & 0x1f, 24, 'and day 24')
  assert.equal(entry.time >> 11, 17, 'hours')
  assert.equal((entry.time >> 5) & 0x3f, 13, 'minutes')
  assert.equal((entry.time & 0x1f) * 2, 30, 'seconds are stored in two-second steps')
})

test('zip: without `at` the stamp is now', () => {
  const before = new Date()
  const [entry] = centralEntries(writeZip([{ path: 'a.md', bytes: 'x' }]))
  const after = new Date()
  const year = (entry.date >> 9) + 1980
  assert.ok(year === before.getFullYear() || year === after.getFullYear(), 'the year is today\'s')
  const local = new Date(year, ((entry.date >> 5) & 0x0f) - 1, entry.date & 0x1f)
  assert.ok(local.toDateString() === before.toDateString() || local.toDateString() === after.toDateString())
})

// ---------------------------------------------------------------------------
// 3. CRC-32
// ---------------------------------------------------------------------------

test('zip: crc32 matches the known vectors', () => {
  // The canonical CRC-32 (IEEE 802.3) check value: "123456789" hashes to 0xCBF43926.
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0, 'the empty input hashes to zero')
})

test('zip: crc32 agrees with node:zlib on every sample', (t) => {
  const samples = [
    '',
    'a',
    '123456789',
    'The quick brown fox jumps over the lazy dog',
    '第一章 入山\n',
    'x'.repeat(4096),
    '\u0000\u0001\u00ff binary-ish',
  ].map((text) => Buffer.from(text, 'utf8'))
  assert.ok(samples.length >= 5, 'at least five samples')
  if (typeof zlib.crc32 !== 'function') {
    t.diagnostic('node:zlib has no crc32 in this runtime; the known vectors above are the whole check')
    return
  }
  for (const sample of samples) {
    assert.equal(crc32(sample), zlib.crc32(sample), `crc32(${sample.length} bytes) matches node:zlib`)
  }
})

test('zip: crc32 takes a Uint8Array slice of a larger buffer, not only an owned Buffer', () => {
  const inner = Buffer.from('123456789', 'utf8')
  const padded = Buffer.concat([Buffer.from('header'), inner, Buffer.from('trailer')])
  assert.equal(crc32(padded.subarray(6, 15)), 0xcbf43926, 'the offset view is hashed as its own bytes')
})

// ---------------------------------------------------------------------------
// 4. What the reader refuses
// ---------------------------------------------------------------------------

test('zip: a compressed entry is refused by name, not skipped', () => {
  const bytes = samplePackage()
  const entry = centralEntries(bytes)[0]
  // Method 8 = deflate. Flipping it in the central directory is enough: the reader
  // must not get as far as reading payload bytes it cannot expand.
  bytes.writeUInt16LE(8, entry.at + 10)
  assert.equal(codeOf(() => readZip(bytes)), 'ZIP_METHOD_UNSUPPORTED')
})

test('zip: zip64 is refused (the EOCD counts, the central directory offset, an entry offset)', () => {
  const truncatedEntries = samplePackage()
  const eocd = eocdOffset(truncatedEntries)
  truncatedEntries.writeUInt16LE(0xffff, eocd + 8) // entries on this disk
  truncatedEntries.writeUInt16LE(0xffff, eocd + 10) // total entries
  assert.equal(codeOf(() => readZip(truncatedEntries)), 'ZIP64_UNSUPPORTED')

  const hugeDirectory = samplePackage()
  const eocd2 = eocdOffset(hugeDirectory)
  hugeDirectory.writeUInt32LE(0xffffffff, eocd2 + 16) // central directory offset
  assert.equal(codeOf(() => readZip(hugeDirectory)), 'ZIP64_UNSUPPORTED')

  const hugeEntry = samplePackage()
  const entry = centralEntries(hugeEntry)[0]
  hugeEntry.writeUInt32LE(0xffffffff, entry.at + 42) // entry's local header offset
  assert.equal(codeOf(() => readZip(hugeEntry)), 'ZIP64_UNSUPPORTED')
})

test('zip: a name that would escape the target directory is refused', () => {
  // `../escape.md` and `/x/escape.md` are the classic zip-slip shapes; the patch keeps
  // every length and CRC intact so only the name can be the reason for the refusal.
  const climb = patchBytes(samplePackage(), 'xe/escape.md', '../escape.md')
  assert.equal(codeOf(() => readZip(climb)), 'ZIP_PATH_INVALID')

  const absolute = patchBytes(samplePackage(), 'xe/escape.md', '/x/escape.md')
  assert.equal(codeOf(() => readZip(absolute)), 'ZIP_PATH_INVALID')
})

test('zip: a backslash or an empty path segment is refused', () => {
  // On Windows `..\..\x` is a path escape that splitting on `/` cannot see, and `a//b`
  // names a path two different tools resolve differently. Both are refused outright.
  const backslash = patchBytes(samplePackage(), 'xe/escape.md', 'x\\..\\esca.md')
  assert.equal(codeOf(() => readZip(backslash)), 'ZIP_PATH_INVALID')

  const doubled = patchBytes(samplePackage(), 'xe/escape.md', 'xe//scape.md')
  assert.equal(codeOf(() => readZip(doubled)), 'ZIP_PATH_INVALID')
})

test('zip: a payload that no longer matches its CRC is refused', () => {
  const bytes = samplePackage()
  const entry = centralEntries(bytes)[0]
  const start = payloadOffset(bytes, entry)
  bytes[start] = bytes[start] === 0x70 ? 0x71 : 0x70 // flip one payload byte
  const code = codeOf(() => readZip(bytes))
  assert.equal(code, 'ZIP_CRC_MISMATCH', 'a corrupted backup is reported, not restored')
})

test('zip: bytes that are not a ZIP, or a truncated ZIP, are refused', () => {
  assert.equal(codeOf(() => readZip(Buffer.from('not a zip at all\n', 'utf8'))), 'ZIP_NOT_ZIP')
  const bytes = samplePackage()
  assert.equal(codeOf(() => readZip(bytes.subarray(0, 12))), 'ZIP_NOT_ZIP', 'no EOCD left to read')
})

// ---------------------------------------------------------------------------
// 5. What the writer refuses (a package we cannot read back is not written)
// ---------------------------------------------------------------------------

test('zip: the writer refuses the paths a restore could not place', () => {
  for (const path of ['../escape.md', '/etc/escape.md', 'a/../../b.md', '', 'chapters//a.md']) {
    const code = codeOf(() => writeZip([{ path, bytes: 'x' }]))
    assert.equal(code, 'ZIP_PATH_INVALID', `${JSON.stringify(path)} is refused`)
  }
  const duplicate = codeOf(() =>
    writeZip([
      { path: 'a.md', bytes: 'first' },
      { path: 'a.md', bytes: 'second' },
    ]),
  )
  assert.equal(duplicate, 'ZIP_ENTRY_DUPLICATE', 'two entries with one name would make the restore ambiguous')
})

test('zip: an empty package is a valid empty ZIP', () => {
  const bytes = writeZip([])
  assert.deepEqual(readZip(bytes), [])
  assert.equal(eocdOffset(bytes), 0, 'with no entries the EOCD is the whole package')
})
