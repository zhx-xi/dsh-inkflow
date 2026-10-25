/**
 * Export: EPUB / DOCX / Markdown / TXT (#50, ADR-0024, roadmap X-27).
 *
 * Five properties, each asserted the way the ADR names it:
 *
 *   1. EPUB — `mimetype` is the FIRST entry and its method field is 0 (stored), with the
 *      20-byte OCF payload. Read from the raw bytes, not from a flag the exporter reports:
 *      a reader that skips this is the failure the rule exists to prevent;
 *   2. EPUB — the package reads back through `zip.ts` itself, every manifest href exists in
 *      the package, and the navigation document carries the volume → chapter hierarchy;
 *   3. XHTML — a chapter containing `<`, `&` and `"` arrives escaped; the literal `<script>`
 *      of the source never appears as markup;
 *   4. DOCX — the five parts exist, `[Content_Types].xml` overrides the path `document.xml`
 *      actually has, and volumes are Heading 1 while chapters are Heading 2;
 *   5. the artifact lands in `dataDir/exports` and the BOOK is untouched — the tree digest
 *      (names, kinds, sizes, mtimes) is identical before and after, which is what "`git
 *      status` stays clean" means mechanically.
 *
 * Plus the refusals: a bad `format`, an unknown `volumeId`, a missing `status` and an empty
 * book all answer with a code and write NO file (an empty package named like a finished
 * export is worse than an error).
 *
 * Runs against the built artifact (`../lib/index.js`), like every other contract test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EPUB_MIMETYPE,
  EXPORTS_DIR,
  exportBook,
  exportsDir,
  markdownBlocks,
  readZip,
  escapeXml,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const NINE = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

/** The stamp every test pins, so two runs of one book produce the same file name. */
const AT = new Date('2026-10-25T10:20:30Z')

/**
 * A book with two volumes, one loose chapter and three statuses.
 *
 * Chapter 1 deliberately carries `<script>`, `&` and `"` in its body: escaping is asserted on
 * the artifact a reader would open, not on a unit-test string.
 */
function book(options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'inkflow-export-'))
  const root = join(parent, '我的书')
  for (const dir of [...NINE, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  mkdirSync(join(root, 'chapters', 'vol-01-入山'), { recursive: true })
  mkdirSync(join(root, 'chapters', 'vol-02-问道'), { recursive: true })
  const chapter = (path, fields) => {
    const { bodyText = '', ...frontmatterFields } = fields
    const frontmatter = Object.entries(frontmatterFields)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join('\n')
    writeFileSync(join(root, ...path.split('/')), `---\n${frontmatter}\n---\n\n${bodyText}`, 'utf8')
  }
  const bodyOf = options.emptyBody === true ? '' : '# 开篇\n\n山雨欲来。\n\n他抄起断剑 & 走出庙门，嘴角一句「<script>alert("嘿")</script>」。\n'
  chapter('chapters/vol-01-入山/0001-初入.md', {
    id: 'ch-0001',
    title: '初入',
    seq: 1,
    volume: 'vol-01',
    status: 'revised',
    bodyText: bodyOf,
  })
  chapter('chapters/vol-01-入山/0002-夜行.md', {
    id: 'ch-0002',
    title: '夜行',
    seq: 2,
    volume: 'vol-01',
    status: 'draft',
    bodyText: '## 二更\n\n夜行不点灯。\n',
  })
  chapter('chapters/vol-02-问道/0003-问道.md', {
    id: 'ch-0003',
    title: '问道',
    seq: 3,
    volume: 'vol-02',
    status: 'final',
    bodyText: '问道于野。\n',
  })
  chapter('chapters/0004-外传.md', { id: 'ch-0004', title: '外传', seq: 4, status: 'draft', bodyText: '外传一页。\n' })
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 1, title: '入山记', author: 'zhx' }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  return { parent, root, dataDir: join(parent, 'state'), cleanup: () => rmSync(parent, { recursive: true, force: true }) }
}

/** An empty book: the directories exist, no chapter does. */
function emptyBook() {
  const made = book()
  for (const path of [
    'chapters/vol-01-入山/0001-初入.md',
    'chapters/vol-01-入山/0002-夜行.md',
    'chapters/vol-02-问道/0003-问道.md',
    'chapters/0004-外传.md',
  ]) {
    rmSync(join(made.root, ...path.split('/')), { force: true })
  }
  return made
}

function exported(fixture, request) {
  const result = exportBook(fixture.root, fixture.dataDir, { at: AT, ...request })
  assert.equal(result.ok, true, `export refused: ${JSON.stringify(result.error ?? {})}`)
  return result.value
}

function entriesOf(value) {
  return readZip(readFileSync(value.path))
}

function textOf(entries, path) {
  const found = entries.find((entry) => entry.path === path)
  assert.ok(found !== undefined, `missing entry ${path} (have ${entries.map((entry) => entry.path).join(', ')})`)
  return found.bytes.toString('utf8')
}

// ---------------------------------------------------------------------------
// 1. The OCF rule: `mimetype` first, stored, exact payload (D2)
// ---------------------------------------------------------------------------

test('EPUB：mimetype 是第一个条目、未压缩，内容就是 application/epub+zip', () => {
  const fixture = book()
  try {
    const value = exported(fixture, { format: 'epub', target: 'book' })
    const bytes = readFileSync(value.path)

    // Read the FIRST local file header straight out of the bytes: signature, method, name.
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'the package does not start with a local file header')
    assert.equal(bytes.readUInt16LE(8), 0, 'the first entry is compressed; OCF requires it stored')
    const nameLength = bytes.readUInt16LE(26)
    const extraLength = bytes.readUInt16LE(28)
    assert.equal(bytes.toString('utf8', 30, 30 + nameLength), 'mimetype')
    const payloadStart = 30 + nameLength + extraLength
    const payload = bytes.subarray(payloadStart, payloadStart + 20)
    assert.equal(payload.toString('utf8'), EPUB_MIMETYPE)
    assert.equal(payload.length, 20, 'the OCF payload has no BOM and no trailing newline')
    // Stored means the compressed size equals the uncompressed size, both 20.
    assert.equal(bytes.readUInt32LE(18), 20)
    assert.equal(bytes.readUInt32LE(22), 20)

    // And the same statement through the container's own reader.
    assert.equal(entriesOf(value)[0].path, 'mimetype')
    assert.equal(value.verified.mimetypeFirst, true)
    assert.equal(value.verified.stored, true)
    assert.equal(value.format, 'epub')
    assert.equal(value.container, 'zip')
  } finally {
    fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 2. The package reads back, and the manifest agrees with the files
// ---------------------------------------------------------------------------

test('EPUB：能被 zip.ts 解回来，manifest/spine 与包内文件逐一对上', () => {
  const fixture = book()
  try {
    const value = exported(fixture, { format: 'epub', target: 'book' })
    const entries = entriesOf(value)
    const names = entries.map((entry) => entry.path)
    for (const required of ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/toc.xhtml']) {
      assert.ok(names.includes(required), `missing required part ${required}`)
    }
    assert.equal(value.entryCount, entries.length)

    const container = textOf(entries, 'META-INF/container.xml')
    assert.match(container, /full-path="OEBPS\/content\.opf"/)

    const opf = textOf(entries, 'OEBPS/content.opf')
    assert.match(opf, /<dc:title>入山记<\/dc:title>/)
    assert.match(opf, /<dc:creator>zhx<\/dc:creator>/)
    assert.match(opf, /<meta property="dcterms:modified">2026-10-25T10:20:30Z<\/meta>/)
    assert.match(opf, /properties="nav"/)

    const hrefs = [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((match) => match[1])
    assert.equal(hrefs.length, 5, 'nav + four chapters')
    for (const href of hrefs) assert.ok(names.includes(`OEBPS/${href}`), `manifest names ${href}, which is not in the package`)

    // Every chapter of the book is in the spine, in reading order, once.
    const itemrefs = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((match) => match[1])
    assert.deepEqual(itemrefs, ['ch0001', 'ch0002', 'ch0003', 'ch0004'])
    assert.equal(new Set(itemrefs).size, itemrefs.length, 'a chapter appears in the spine twice')
    assert.equal(names.filter((name) => name.startsWith('OEBPS/text/')).length, 4)
    assert.equal(value.chapters, 4)
    assert.equal(value.volumes, 2)
  } finally {
    fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 3. The table of contents carries 卷 → 章
// ---------------------------------------------------------------------------

test('EPUB：目录树是「卷 → 章」两层（卷名在下钻之前，章挂在卷里）', () => {
  const fixture = book()
  try {
    const value = exported(fixture, { format: 'epub', target: 'book' })
    const nav = textOf(entriesOf(value), 'OEBPS/toc.xhtml')

    assert.match(nav, /<nav epub:type="toc" id="toc">/)
    // One outer <ol> plus one per volume that has chapters: two levels, not a flat list.
    assert.equal((nav.match(/<ol>/g) ?? []).length, 3)

    const firstVolume = nav.indexOf('<span>入山</span>')
    const secondVolume = nav.indexOf('<span>问道</span>')
    const firstChapter = nav.indexOf('初入')
    const thirdChapter = nav.indexOf('问道</a>')
    assert.ok(firstVolume > -1, 'the first volume title is missing from the nav')
    assert.ok(secondVolume > firstVolume, 'volumes are not in reading order')
    assert.ok(firstChapter > firstVolume && firstChapter < secondVolume, 'chapter 1 is not nested under volume 1')
    assert.ok(thirdChapter > secondVolume, 'chapter 3 is not nested under volume 2')
    // The loose chapter is a top-level item, outside both volume groups.
    assert.ok(nav.indexOf('外传') > thirdChapter)
  } finally {
    fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 4. XHTML escaping — the `<` `&` `"` case, asserted on the artifact
// ---------------------------------------------------------------------------

test('EPUB：正文里的 < & " 被转义，源码里的 <script> 不会变成标签', () => {
  const fixture = book()
  try {
    const value = exported(fixture, { format: 'epub', target: 'book' })
    const xhtml = textOf(entriesOf(value), 'OEBPS/text/ch0001.xhtml')

    assert.ok(!xhtml.includes('<script>'), 'the chapter body injected markup into the XHTML')
    assert.ok(xhtml.includes('&lt;script&gt;alert(&quot;嘿&quot;)&lt;/script&gt;'))
    assert.ok(xhtml.includes('&amp;'), 'a bare & survived into the XHTML')
    // Body headings become one level below the chapter title, and paragraphs are wrapped.
    assert.ok(xhtml.includes('<h1>初入</h1>'))
    assert.ok(xhtml.includes('<h2>开篇</h2>'))
    assert.ok(xhtml.includes('<p>山雨欲来。</p>'))
    // Only the XML declaration, the doctype and the html root are markup.
    assert.ok(xhtml.startsWith('<?xml version="1.0" encoding="utf-8"?>'))
  } finally {
    fixture.cleanup()
  }
})

test('渲染器本身：转义、段落与标题分级（被两个格式共用的一条规则）', () => {
  assert.equal(escapeXml('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f')
  assert.deepEqual(markdownBlocks('# 一\n\n正文第一段\n续行\n\n## 二\n\n尾'), [
    { kind: 'heading', level: 1, text: '一' },
    { kind: 'paragraph', text: '正文第一段\n续行' },
    { kind: 'heading', level: 2, text: '二' },
    { kind: 'paragraph', text: '尾' },
  ])
  // A line of `######` more than six deep stays text rather than inventing an h7.
  assert.deepEqual(markdownBlocks('####### 七级'), [{ kind: 'paragraph', text: '####### 七级' }])
})

// ---------------------------------------------------------------------------
// 5. DOCX: the minimal part set, headings, paragraphs (D3)
// ---------------------------------------------------------------------------

test('DOCX：五个部件齐全，Content_Types 的 override 与 document.xml 的真实路径一致', () => {
  const fixture = book()
  try {
    const value = exported(fixture, { format: 'docx', target: 'book' })
    const entries = entriesOf(value)
    assert.deepEqual(entries.map((entry) => entry.path), [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/styles.xml',
    ])

    const types = textOf(entries, '[Content_Types].xml')
    assert.match(types, /<Override PartName="\/word\/document\.xml" ContentType="[^"]*document\.main\+xml"\/>/)
    assert.match(types, /<Override PartName="\/word\/styles\.xml" ContentType="[^"]*styles\+xml"\/>/)

    const rels = textOf(entries, '_rels/.rels')
    assert.match(rels, /Target="word\/document\.xml"/)
    // styles.xml is reached through document.xml.rels, so it must be declared there.
    assert.match(textOf(entries, 'word/_rels/document.xml.rels'), /Target="styles\.xml"/)

    const doc = textOf(entries, 'word/document.xml')
    assert.match(doc, /<w:body>/)
    assert.ok(!doc.includes('<w:sectPr'), 'a section break would be a structure the ADR does not ask for')
    // Volume = Heading 1, chapter = Heading 2: one of each per volume/chapter.
    assert.equal((doc.match(/w:val="Heading1"/g) ?? []).length, 2)
    assert.equal((doc.match(/w:val="Heading2"/g) ?? []).length, 4)
    assert.match(doc, /<w:t xml:space="preserve">入山<\/w:t>/)
    assert.match(doc, /<w:t xml:space="preserve">初入<\/w:t>/)
    // Escaped body text, and a body heading one level below the chapter title.
    assert.ok(doc.includes('&lt;script&gt;'))
    assert.ok(!doc.includes('<script>'))
    assert.match(doc, /w:val="Heading3"/)
  } finally {
    fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 6. Markdown / TXT: one file for a scope, one file per volume for a status filter
// ---------------------------------------------------------------------------

test('Markdown/TXT：整本是单文件，卷是 ## 章是 ###，正文原样', () => {
  const fixture = book()
  try {
    const md = exported(fixture, { format: 'markdown', target: 'book' })
    assert.equal(md.container, 'plain')
    assert.match(md.file, /-markdown-\d{8}-\d{6}\.md$/)
    const text = readFileSync(md.path, 'utf8')
    assert.ok(text.startsWith('# 入山记'))
    assert.ok(text.includes('## 入山'))
    assert.ok(text.includes('### 初入'))
    assert.ok(text.includes('山雨欲来。'))
    // Reading order: volume 1 before volume 2, chapter 1 before chapter 2.
    assert.ok(text.indexOf('## 入山') < text.indexOf('## 问道'))
    assert.ok(text.indexOf('### 初入') < text.indexOf('### 夜行'))

    const txt = exported(fixture, { format: 'txt', target: 'book' })
    assert.match(txt.file, /-txt-\d{8}-\d{6}\.txt$/)
    const plain = readFileSync(txt.path, 'utf8')
    assert.ok(!plain.includes('# 入山记'), 'a .txt export must not keep ATX markers')
    assert.ok(plain.includes('入山记'))
    assert.ok(plain.includes('山雨欲来。'))
  } finally {
    fixture.cleanup()
  }
})

test('Markdown：按状态筛选时打成 zip，一个卷一个条目，只有命中状态的章', () => {
  const fixture = book()
  try {
    const value = exported(fixture, { format: 'markdown', target: 'status', status: 'draft' })
    assert.equal(value.container, 'zip')
    assert.match(value.file, /-markdown-\d{8}-\d{6}\.zip$/)
    const entries = entriesOf(value)
    // vol-01 has a draft (夜行), vol-02 has none (so no entry), the loose chapter is a draft.
    assert.deepEqual(entries.map((entry) => entry.path), ['vol-01.md', 'loose.md'])
    const first = textOf(entries, 'vol-01.md')
    assert.ok(first.includes('### 夜行'))
    assert.ok(!first.includes('初入'), 'a revised chapter leaked into a draft export')
    assert.ok(textOf(entries, 'loose.md').includes('### 外传'))
    assert.equal(value.chapters, 2)
  } finally {
    fixture.cleanup()
  }
})

test('Markdown：按卷导出是一卷的单文件，别的卷不进来', () => {
  const fixture = book()
  try {
    const value = exported(fixture, { format: 'markdown', target: 'volume', volumeId: 'vol-02' })
    assert.equal(value.container, 'plain')
    assert.equal(value.volumes, 1)
    const text = readFileSync(value.path, 'utf8')
    assert.ok(text.includes('### 问道'))
    assert.ok(!text.includes('初入'))
  } finally {
    fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 7. Where it lands: outside the book, and the book is untouched (D4)
// ---------------------------------------------------------------------------

test('落点：导出物在 dataDir/exports，书里零新增（树指纹逐字节不变）', () => {
  const fixture = book()
  try {
    const before = hashTree(fixture.root)
    const epub = exported(fixture, { format: 'epub', target: 'book' })
    const docx = exported(fixture, { format: 'docx', target: 'book' })
    const md = exported(fixture, { format: 'markdown', target: 'book' })
    const after = hashTree(fixture.root)

    assert.equal(after, before, 'exporting changed the book: a size or an mtime moved')
    assert.equal(exportsDir(fixture.dataDir), join(fixture.dataDir, EXPORTS_DIR))
    for (const value of [epub, docx, md]) {
      assert.equal(value.dir, exportsDir(fixture.dataDir))
      assert.equal(value.path, join(exportsDir(fixture.dataDir), value.file))
      assert.ok(!value.path.startsWith(fixture.root), 'an export landed inside the book')
      assert.ok(existsSync(value.path))
    }
    assert.deepEqual(readdirSync(exportsDir(fixture.dataDir)).sort(), [docx.file, epub.file, md.file].sort())
    // Naming is `<bookSlug>-<kind>-<stamp>.<ext>` (D4); the slug is the book directory's name.
    assert.equal(epub.bookSlug, '我的书')
    for (const value of [epub, docx, md]) assert.ok(value.file.startsWith('我的书-'))
    assert.equal(epub.stamp, '20261025-102030')
  } finally {
    fixture.cleanup()
  }
})

test('落点：同一秒导出两次都留着（第二份带 -2，不覆盖第一份）', () => {
  const fixture = book()
  try {
    const first = exported(fixture, { format: 'epub', target: 'book' })
    const second = exported(fixture, { format: 'epub', target: 'book' })
    assert.notEqual(first.file, second.file)
    assert.equal(second.file, first.file.replace(/\.epub$/, '-2.epub'))
    assert.ok(existsSync(first.path))
    assert.ok(existsSync(second.path))
  } finally {
    fixture.cleanup()
  }
})

test('落点：dataDir 在书内时拒绝，一个文件都不写', () => {
  const fixture = book()
  try {
    const before = hashTree(fixture.root)
    const result = exportBook(fixture.root, join(fixture.root, 'state'), { format: 'epub', target: 'book', at: AT })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'EXPORT_DATA_DIR_INSIDE_BOOK')
    assert.equal(hashTree(fixture.root), before)
    assert.ok(!existsSync(join(fixture.root, EXPORTS_DIR)))
  } finally {
    fixture.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 8. Refusals: a code, and no file
// ---------------------------------------------------------------------------

test('拒绝：format 非法 → 结构化拒绝且不写文件', () => {
  const fixture = book()
  try {
    const result = exportBook(fixture.root, fixture.dataDir, { format: 'pdf', target: 'book', at: AT })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'EXPORT_FORMAT_INVALID')
    assert.match(result.error.hint ?? '', /epub, docx, markdown, txt/)
    assert.ok(!existsSync(exportsDir(fixture.dataDir)), 'a refused export created the export directory')
  } finally {
    fixture.cleanup()
  }
})

test('拒绝：target 非法 / volume 缺 id / volume 不存在 / status 缺或非法 / 两条选择轴混用', () => {
  const fixture = book()
  try {
    const cases = [
      [{ format: 'epub', target: 'chapter' }, 'EXPORT_TARGET_INVALID'],
      [{ format: 'epub', target: 'volume' }, 'EXPORT_VOLUME_REQUIRED'],
      [{ format: 'epub', target: 'volume', volumeId: 'vol-09' }, 'EXPORT_VOLUME_UNKNOWN'],
      [{ format: 'epub', target: 'status' }, 'EXPORT_STATUS_REQUIRED'],
      [{ format: 'epub', target: 'status', status: 'polished' }, 'EXPORT_STATUS_INVALID'],
      // A volume is a scope and a status is a cross-volume filter: mixing them would answer
      // a question nobody asked, so it is a refusal rather than a silent ignore.
      [{ format: 'epub', target: 'volume', volumeId: 'vol-01', status: 'draft' }, 'EXPORT_SELECTION_UNUSED'],
      [{ format: 'epub', target: 'book', volumeId: 'vol-01' }, 'EXPORT_SELECTION_UNUSED'],
    ]
    for (const [request, code] of cases) {
      const result = exportBook(fixture.root, fixture.dataDir, { ...request, at: AT })
      assert.equal(result.ok, false, `${JSON.stringify(request)} was accepted`)
      assert.equal(result.error.code, code, `${JSON.stringify(request)} answered ${result.error.code}`)
    }
    const unknown = exportBook(fixture.root, fixture.dataDir, { format: 'epub', target: 'volume', volumeId: 'vol-09', at: AT })
    assert.deepEqual(unknown.error.available, ['vol-01', 'vol-02'])
    assert.ok(!existsSync(exportsDir(fixture.dataDir)), 'a refused export created the export directory')
  } finally {
    fixture.cleanup()
  }
})

test('拒绝：空书 → EXPORT_EMPTY，而不是一个看起来正常的空包', () => {
  const fixture = emptyBook()
  try {
    for (const request of [
      { format: 'epub', target: 'book' },
      { format: 'markdown', target: 'book' },
      { format: 'txt', target: 'status', status: 'final' },
    ]) {
      const result = exportBook(fixture.root, fixture.dataDir, { ...request, at: AT })
      assert.equal(result.ok, false, `${JSON.stringify(request)} produced a file for an empty book`)
      assert.equal(result.error.code, 'EXPORT_EMPTY')
    }
    assert.ok(!existsSync(exportsDir(fixture.dataDir)), 'an empty book produced an export directory')
  } finally {
    fixture.cleanup()
  }
})

test('拒绝：status 筛选命中 0 章 → EXPORT_EMPTY（而不是一个空包）', () => {
  const fixture = book()
  try {
    // Remove the only `final` chapter: the book still has three chapters, so the refusal is
    // about the FILTER, not about an empty book.
    rmSync(join(fixture.root, 'chapters', 'vol-02-问道', '0003-问道.md'), { force: true })
    const none = exportBook(fixture.root, fixture.dataDir, { format: 'markdown', target: 'status', status: 'final', at: AT })
    assert.equal(none.ok, false)
    assert.equal(none.error.code, 'EXPORT_EMPTY')
    assert.match(none.error.message, /status "final"/)

    // The other statuses still export, which is what proves the filter actually filters.
    const drafts = exported(fixture, { format: 'markdown', target: 'status', status: 'draft' })
    assert.equal(drafts.chapters, 2)
    const revised = exported(fixture, { format: 'markdown', target: 'status', status: 'revised' })
    assert.equal(revised.chapters, 1)
  } finally {
    fixture.cleanup()
  }
})
