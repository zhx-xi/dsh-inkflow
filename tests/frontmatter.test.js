/**
 * Frontmatter parser/writer regressions.
 *
 * The defects were seen on hand-written chapter files: trailing `#` comments
 * ended up inside ids/volumes/statuses, a body that starts with a `---` rule
 * lost its first paragraph (and that paragraph was echoed verbatim into
 * FRONTMATTER_ISSUE.detail, i.e. prose in tool output), and write-back had no
 * way to keep comments, unknown fields or quote styles.
 *
 * Everything imports the BUILT host bundle (lib/index.js), like the rest of the
 * suite: the tests must exercise what users actually install.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, frontmatterLine, parseMarkdown, patchFrontmatter, splitFrontmatter } from '../lib/index.js'

// The chapter example from .agents/specs/conventions.md §3.2, comments and all:
// the spec's own examples are the contract, so they must parse here.
const SPEC_CHAPTER = [
  '---',
  'id: 6f1c2c1e-...        # 可选；缺省用相对路径生成稳定 id',
  'title: 第一章 入山',
  'volume: vol-01          # 可选；缺省取 chapters/<vol>/ 的目录名（顶层章为空，不会是 "chapters"）',
  'seq: 1                  # 可选；缺省取文件名前导数字',
  'status: draft           # draft | revised | final',
  'pov: 主角                # 可选',
  '---',
  '',
  '正文第一段……',
].join('\n')

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-frontmatter-'))
}

// ADR-0006 D1: nine content directories plus the derived index/, each with a
// .gitkeep — the gate requires the whole tree before any tool answers.
const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 1, title: '测试之书' }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Rebuild the derived index and hand back the raw tool value.
 *
 * `workspace` is the directory that plays the Session working directory: since
 * the gate made that the only trust anchor for path scope, so the fixture project must
 * live inside it or the tool refuses the path before touching the disk.
 */
async function rebuild(root, workspace) {
  const tools = new Map()
  const ctx = {
    effect(setup) {
      setup()
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => workspace }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    webServer: { register() { return () => {} } },
  }
  apply(ctx, { dataDir: join(root, '..', 'state') })
  const tool = tools.get('inkflow_index_rebuild')
  assert.ok(tool, 'inkflow_index_rebuild must be registered')
  // A real call always comes from a session; the agent makes the fake
  // workingDirectory service reachable (see get() above).
  return tool.execute(
    { projectRoot: root },
    { signal: AbortSignal.timeout(5000), agent: { id: 'test-session' } },
  )
}

test('frontmatter: the spec chapter example parses with its trailing comments stripped', () => {
  const parsed = parseMarkdown(SPEC_CHAPTER)
  assert.equal(parsed.hasFrontmatter, true)
  assert.deepEqual(parsed.data, {
    id: '6f1c2c1e-...',
    title: '第一章 入山',
    volume: 'vol-01',
    seq: '1',
    status: 'draft',
    pov: '主角',
  })
  assert.equal(parsed.body, '\n正文第一段……')
  assert.deepEqual(parsed.issues, [])
})

test('frontmatter: comments are stripped outside quotes only', () => {
  const parsed = parseMarkdown(
    [
      '---',
      'id: "c-1"   # inline comment',
      'volume: vol-01   # 可选',
      'status: draft # draft | revised | final',
      'title: "第 1 章 # 入山"',
      "subtitle: '上 # 下'",
      'escaped: "a \\" # 仍是值"',
      "doubled: 'it''s # fine'",
      'ref: c#1',
      '# 整行注释',
      '---',
      '正文',
    ].join('\n'),
  )
  assert.equal(parsed.hasFrontmatter, true)
  assert.equal(parsed.data.id, 'c-1')
  assert.equal(parsed.data.volume, 'vol-01')
  assert.equal(parsed.data.status, 'draft')
  // A `#` inside quotes is data, not a comment.
  assert.equal(parsed.data.title, '第 1 章 # 入山')
  assert.equal(parsed.data.subtitle, '上 # 下')
  // Escapes do not end the string: `\"` and `''` stay inside it.
  assert.equal(parsed.data.escaped, 'a " # 仍是值')
  assert.equal(parsed.data.doubled, "it's # fine")
  // No whitespace before the `#`: it cannot start a comment.
  assert.equal(parsed.data.ref, 'c#1')
  assert.deepEqual(parsed.issues, [])
})

test('frontmatter: an inline array keeps quoted # characters, drops its comment', () => {
  const parsed = parseMarkdown('---\nkeywords: [白鹤, "鹤#鸣"]  # 世界书触发词\n---\n条目')
  assert.deepEqual(parsed.data.keywords, ['白鹤', '鹤#鸣'])
})

test('frontmatter: a body that starts with a --- rule keeps its first paragraph', () => {
  const doc = ['---', '他走进白鹤门。', '', '---', '', '夜里风很大。'].join('\n')
  const parsed = parseMarkdown(doc)
  // A document whose first "block" is prose is not frontmatter: guessing
  // "no frontmatter" only loses metadata, guessing "frontmatter" eats prose.
  assert.equal(parsed.hasFrontmatter, false)
  assert.deepEqual(parsed.data, {})
  assert.equal(parsed.body, doc)
})

test('frontmatter: a four-dash rule never closes the block', () => {
  const doc = ['---', '他走进白鹤门。', '----', '夜里风很大。'].join('\n')
  const parsed = parseMarkdown(doc)
  // `indexOf('\n---')` matched this line and swallowed the paragraph.
  assert.equal(parsed.hasFrontmatter, false)
  assert.equal(parsed.body, doc)
  assert.equal(JSON.stringify(parsed.issues).includes('他走进白鹤门'), false)
})

test('frontmatter: a real block keeps the title when the body starts with a rule', () => {
  const doc = ['---', 'title: 开篇', '---', '---', '他走进白鹤门。', '---', '夜里风很大。'].join('\n')
  const parsed = parseMarkdown(doc)
  assert.equal(parsed.hasFrontmatter, true)
  assert.equal(parsed.data.title, '开篇')
  assert.equal(parsed.body, '---\n他走进白鹤门。\n---\n夜里风很大。')
  assert.deepEqual(parsed.issues, [])
})

test('frontmatter: the closing delimiter may carry trailing whitespace', () => {
  const parsed = parseMarkdown('---\ntitle: 开篇\n---   \n正文\n')
  assert.equal(parsed.hasFrontmatter, true)
  assert.equal(parsed.data.title, '开篇')
  assert.equal(parsed.body, '正文\n')
})

test('frontmatter: an unclosed block leaves the whole file as body', () => {
  const doc = ['---', 'title: 开篇', '', '他走进白鹤门，风很大。'].join('\n')
  const parsed = parseMarkdown(doc)
  assert.equal(parsed.hasFrontmatter, false)
  assert.deepEqual(parsed.data, {})
  assert.equal(parsed.body, doc)
  // The issue is reported, but without the prose it came from.
  assert.equal(parsed.issues.length, 1)
  assert.equal(JSON.stringify(parsed.issues).includes('他走进白鹤门'), false)
})

test('frontmatter: a close beyond the first 4 KiB is treated as prose', () => {
  const doc = ['---', 'x'.repeat(5000), '---', '正文'].join('\n')
  const parsed = parseMarkdown(doc)
  assert.equal(parsed.hasFrontmatter, false)
  assert.equal(parsed.body, doc)
})

test('frontmatter: an unparsed line is reported by position, never by content', () => {
  const parsed = parseMarkdown('---\ntitle: 开篇\n??? 这是坏行\n---\n正文')
  assert.equal(parsed.hasFrontmatter, true)
  assert.equal(parsed.data.title, '开篇')
  assert.equal(parsed.issues.length, 1)
  // Key names, line numbers and byte offsets are allowed; user text is not.
  assert.match(parsed.issues[0], /line 3/)
  assert.match(parsed.issues[0], /byte \d+/)
  assert.equal(parsed.issues[0].includes('这是坏行'), false)
})

test('frontmatter: index rebuild never echoes prose into FRONTMATTER_ISSUE.detail', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    // A chapter whose body opens with a horizontal rule: the paragraph used to
    // be parsed as frontmatter and land in validation details.
    writeFileSync(join(root, 'chapters', '0001-甲.md'), '---\n他走进白鹤门。\n---\n', 'utf8')
    const result = await rebuild(root, dir)
    assert.equal(result.ok, true)
    assert.equal(result.counts.chapters, 1)
    const reported = JSON.stringify(result.issues)
    assert.equal(reported.includes('他走进白鹤门'), false)
    assert.equal(reported.includes('FRONTMATTER_ISSUE'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A hand-edited chapter: block comment, inline comments, mixed quote styles, a
// field the plugin does not know, and a body that starts with a rule.
const HAND_WRITTEN = [
  '---',
  '# 这份注释不能丢',
  'title: "第一章 入山"   # 引号与注释都属于作者',
  'id: 6f1c2c1e-0001   # 可选',
  'volume: vol-01',
  'seq: 1',
  'mystery: 插件不认识的字段',
  'status: draft',
  '---',
  '',
  '正文第一段。',
  '',
  '---',
  '',
  '正文第二段。',
].join('\n')

test('write-back: patching one field changes exactly that line', () => {
  const before = parseMarkdown(HAND_WRITTEN)
  const patched = patchFrontmatter(HAND_WRITTEN, { status: 'final' })
  assert.deepEqual(patched.replaced, ['status'])
  assert.deepEqual(patched.appended, [])
  assert.deepEqual(patched.skipped, [])

  const beforeLines = HAND_WRITTEN.split('\n')
  const afterLines = patched.text.split('\n')
  assert.equal(afterLines.length, beforeLines.length)
  const changed = afterLines.flatMap((line, index) => (line === beforeLines[index] ? [] : [index]))
  assert.equal(changed.length, 1, 'only the patched line may change')
  assert.equal(beforeLines[changed[0]], 'status: draft')
  assert.equal(afterLines[changed[0]], 'status: final')

  const after = parseMarkdown(patched.text)
  // Unknown fields, comments, quote styles and key order survive; only the
  // value that was patched differs.
  assert.deepEqual(after.data, { ...before.data, status: 'final' })
  assert.deepEqual(Object.keys(after.data), Object.keys(before.data))
  assert.equal(after.body, before.body)
  assert.equal(patched.text.includes('# 这份注释不能丢'), true)
  assert.equal(patched.text.includes('mystery: 插件不认识的字段'), true)
})

test('write-back: the patched line keeps its quote style and inline comment', () => {
  const patched = patchFrontmatter(HAND_WRITTEN, { title: '第二章 夜行', id: 'new-id' })
  assert.equal(patched.text.includes('title: "第二章 夜行"   # 引号与注释都属于作者'), true)
  assert.equal(patched.text.includes('id: new-id   # 可选'), true)
  const after = parseMarkdown(patched.text)
  assert.equal(after.data.title, '第二章 夜行')
  assert.equal(after.data.id, 'new-id')
})

test('write-back: a new key is appended at the end of the block', () => {
  const patched = patchFrontmatter(HAND_WRITTEN, { pov: '主角' })
  assert.deepEqual(patched.appended, ['pov'])
  assert.deepEqual(patched.replaced, [])
  const lines = patched.text.split('\n')
  const close = lines.indexOf('---', 1)
  assert.equal(lines[close - 1], 'pov: 主角')
  // Appending must not disturb the body, which also starts with a rule.
  assert.equal(parseMarkdown(patched.text).body, parseMarkdown(HAND_WRITTEN).body)
  assert.equal(parseMarkdown(patched.text).data.pov, '主角')
})

test('write-back: an empty patch is a byte-for-byte no-op', () => {
  assert.equal(patchFrontmatter(HAND_WRITTEN, {}).text, HAND_WRITTEN)
})

test('write-back: patching a block list takes its items with the key line', () => {
  const doc = ['---', 'aliases:', '  - 甲', '  - 乙', 'title: 清音', '---', '正文'].join('\n')
  const patched = patchFrontmatter(doc, { aliases: '甲' })
  assert.equal(patched.text, ['---', 'aliases: 甲', 'title: 清音', '---', '正文'].join('\n'))
  assert.equal(parseMarkdown(patched.text).data.aliases, '甲')
})

test('write-back: a document without a frontmatter block is left alone', () => {
  const prose = '他走进白鹤门。\n夜里风很大。\n'
  const patched = patchFrontmatter(prose, { id: 'x' })
  assert.equal(patched.text, prose)
  assert.deepEqual(patched.skipped, ['id'])
})

test('write-back: CRLF and a BOM survive the rewrite', () => {
  const doc = '\uFEFF---\r\ntitle: 开篇\r\nstatus: draft\r\n---\r\n正文\r\n'
  const patched = patchFrontmatter(doc, { status: 'final' })
  assert.equal(patched.text, '\uFEFF---\r\ntitle: 开篇\r\nstatus: final\r\n---\r\n正文\r\n')
  // No stray LF may be introduced into a CRLF file.
  assert.equal(patched.text.replace(/\r\n/g, '').includes('\n'), false)
  assert.equal(parseMarkdown(patched.text).data.status, 'final')
})

test('write-back: values that need quoting still round-trip', () => {
  const patched = patchFrontmatter(HAND_WRITTEN, { title: '含 # 号与"引号"', pov: ' 两边空格 ' })
  const after = parseMarkdown(patched.text)
  assert.equal(after.data.title, '含 # 号与"引号"')
  assert.equal(after.data.pov, ' 两边空格 ')
  // Re-patching the same value must not rewrite the line again.
  assert.equal(patchFrontmatter(patched.text, { title: '含 # 号与"引号"' }).text, patched.text)
})

test('write-back: a multi-line value is rejected instead of corrupting the block', () => {
  assert.throws(() => patchFrontmatter(HAND_WRITTEN, { title: '第一行\n第二行' }), /single line/)
})

test('write-back: an unreadable key is rejected instead of writing a dead line', () => {
  assert.throws(() => patchFrontmatter(HAND_WRITTEN, { 'bad key': 'x' }), /not a valid frontmatter key/)
})

test('write-back: removing a key takes its block list and keeps every other line', () => {
  const doc = [
    '---',
    'id: x',
    'title: 第一章',
    'keywords:',
    '  - 白鹤',
    '  - 鹤鸣',
    'status: draft   # 作者标注',
    '---',
    '',
    '正文',
    '',
  ].join('\n')
  const patched = patchFrontmatter(doc, {}, { remove: ['keywords', 'volume'] })
  assert.deepEqual(patched.removed, ['keywords'], 'a key that is not there is not reported')
  assert.equal(patched.text.includes('keywords'), false)
  assert.equal(patched.text.includes('鹤鸣'), false, 'the list items belong to the removed key')
  assert.equal(patched.text.includes('status: draft   # 作者标注'), true)
  const after = parseMarkdown(patched.text)
  assert.equal(after.data.title, '第一章')
  assert.equal(Object.hasOwn(after.data, 'keywords'), false)
  assert.equal(after.body.trim(), '正文')
})

test('split: the two halves are byte-identical to the input', () => {
  const text = '---\r\ntitle: x\r\n---\r\n\r\n正文\r\n'
  const parts = splitFrontmatter(text)
  assert.equal(parts.hasFrontmatter, true)
  assert.equal(parts.head + parts.body, text)
  assert.equal(parts.body, '\r\n正文\r\n')
  const prose = '没有 frontmatter 的正文'
  assert.deepEqual(splitFrontmatter(prose), { hasFrontmatter: false, head: '', body: prose })
})

test('write-back: frontmatterLine quotes a value the parser would misread', () => {
  assert.equal(frontmatterLine('title', '第一章'), 'title: 第一章')
  assert.equal(frontmatterLine('title', '第一章 # 入山'), 'title: "第一章 # 入山"')
  assert.equal(parseMarkdown(`---\n${frontmatterLine('title', '第一章 # 入山')}\n---\n`).data.title, '第一章 # 入山')
  assert.throws(() => frontmatterLine('bad key', 'x'), /not a valid frontmatter key/)
  assert.throws(() => frontmatterLine('title', 'a\nb'), /single line/)
})

// ---------------------------------------------------------------------------
// List values: a card's aliases / 语言基因 / 按章状态 are lists whose items
// contain `,` and `:`, so the patch path has to write them in block form.
// ---------------------------------------------------------------------------

test('write-back: a list value is written in block form and reads back as the same list', () => {
  const doc = ['---', 'id: c-1', 'name: 清音', 'aliases: 青音, 旧名   # 作者标注', '---', '', '正文', ''].join('\n')
  const patched = patchFrontmatter(doc, { aliases: ['青音', '清音仙子'], states: ['1: 初入门墙', '30: 代掌门'] })
  assert.deepEqual(patched.replaced, ['aliases'])
  assert.deepEqual(patched.appended, ['states'])

  const after = parseMarkdown(patched.text)
  assert.deepEqual(after.data.aliases, ['青音', '清音仙子'], 'the old inline value is replaced, not merged')
  assert.deepEqual(after.data.states, ['1: 初入门墙', '30: 代掌门'])
  assert.equal(after.data.name, '清音')
  // The author's comment on the rewritten key survives, and the body is untouched.
  assert.equal(patched.text.includes('aliases: # 作者标注'), true)
  assert.equal(after.body.trim(), '正文')
})

test('write-back: an empty list deletes the key instead of leaving a dangling "key:"', () => {
  const doc = ['---', 'id: c-1', 'aliases:', '  - 青音', '  - 清音仙子', 'name: 清音', '---', '', '正文', ''].join('\n')
  const patched = patchFrontmatter(doc, { aliases: [] })
  assert.deepEqual(patched.removed, ['aliases'])
  const after = parseMarkdown(patched.text)
  assert.equal(Object.hasOwn(after.data, 'aliases'), false)
  assert.equal(patched.text.includes('清音仙子'), false, 'the items belong to the removed key')
  assert.equal(after.data.name, '清音')
})

test('write-back: a multi-line list item is rejected instead of splitting the block', () => {
  assert.throws(() => patchFrontmatter(HAND_WRITTEN, { aliases: ['青音\n清音仙子'] }), /single line/)
})
