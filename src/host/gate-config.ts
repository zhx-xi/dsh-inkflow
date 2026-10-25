/**
 * 按书的门禁口径从哪里读（[ADR-0028](../../.agents/adrs/0028-gate-calibration-per-book.md) D1/D2/D5）。
 *
 * 两个落点，两种性质，所以两个读法：
 *
 *   * **数值**：`inkflow.json` 的 `gate` 段。键的集合只有 `GateThresholds` 一个来源，未知键与
 *     非法值一律**拒绝**（拼错的键会静默失效，而作者以为改过了）；段缺失或某键缺失 = 取
 *     `GATE_DEFAULTS`——默认值不复制进书里，否则「同一事实写两遍」就会漂。
 *   * **字面豁免**：`library/gate-whitelist.txt`（[conventions](../../.agents/specs/conventions.md)
 *     的约定文件）。文件不存在 = 零豁免；越界 = 拒绝（解析在 `gate-waiver.ts`）。
 *
 * 为什么这里自己读 `inkflow.json` 而不是加宽 `ProjectMeta`：`readMeta()` 的返回值是**四态门禁**
 * 的输入（每个人都在用它判「这本书是不是一本书」），而 `gate` 段只有质量门禁读；把它塞进
 * `ProjectMeta` 会让每个判项目状态的地方都背上一个与判定无关的字段。这也让质量门禁能在
 * `inkflow.json` 缺失/不可解析时照常回答（那种情况下四态门禁已经拒绝过业务工具，质量门禁
 * 的判断不该多一个失败面——它就是取默认值）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { GATE_WHITELIST_FILE, LIBRARY_DIR, ROOT_META_FILE } from './conventions.js'
import { GATE_DEFAULTS } from './gate-vocabulary.js'
import type { GateThresholds } from './gate-vocabulary.js'
import { parseWhitelist } from './gate-waiver.js'
import type { GateWaiverEntry } from './gate-waiver.js'

/** The `inkflow.json` key that carries the book's gate numbers. */
export const GATE_BOOK_SECTION = 'gate'

/** Project-relative path of the waiver list (conventions.ts owns both half-names). */
export function gateWhitelistPath(): string {
  return `${LIBRARY_DIR}/${GATE_WHITELIST_FILE}`
}

export interface GateBookConfig {
  readonly thresholds: GateThresholds
  readonly whitelist: readonly GateWaiverEntry[]
  readonly whitelistPath: string
}

export interface GateConfigError {
  readonly code: 'GATE_BOOK_CONFIG_INVALID' | 'GATE_WHITELIST_INVALID'
  readonly message: string
  readonly hint?: string
}

export type GateConfigResult =
  | { readonly ok: true; readonly config: GateBookConfig }
  | { readonly ok: false; readonly error: GateConfigError }

const THRESHOLD_KEYS = Object.keys(GATE_DEFAULTS) as (keyof GateThresholds)[]

function refuse(error: GateConfigError): GateConfigResult {
  return { ok: false, error }
}

function invalid(message: string, hint?: string): GateConfigResult {
  return refuse(hint === undefined ? { code: 'GATE_BOOK_CONFIG_INVALID', message } : { code: 'GATE_BOOK_CONFIG_INVALID', message, hint })
}

/**
 * `inkflow.json`'s `gate` object, validated. `undefined` when the book states nothing —
 * which is the old book, and the only case that must stay byte-for-byte unchanged.
 */
function readGateSection(root: string): { readonly overrides?: Partial<GateThresholds> } | GateConfigResult {
  const file = join(root, ROOT_META_FILE)
  if (!existsSync(file)) return {}
  let raw: string
  try {
    // A hand-edited file on Windows may carry a BOM (AGENTS.md §8 trap 4).
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not this module's judgement to make: the workspace gate already refuses an
    // unparseable `inkflow.json` with a message about the file itself.
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const section = (parsed as Record<string, unknown>)[GATE_BOOK_SECTION]
  if (section === undefined) return {}
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return invalid(`${ROOT_META_FILE} ${GATE_BOOK_SECTION}: expected an object of gate numbers`)
  }

  const overrides: Record<string, number> = {}
  for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
    if ((THRESHOLD_KEYS as string[]).includes(key) === false) {
      return invalid(
        `${ROOT_META_FILE} ${GATE_BOOK_SECTION}.${key}: unknown key`,
        `the gate reads ${THRESHOLD_KEYS.join(', ')}`,
      )
    }
    if (typeof value !== 'number' || Number.isFinite(value) === false || value <= 0) {
      return invalid(`${ROOT_META_FILE} ${GATE_BOOK_SECTION}.${key}: expected a positive number, found ${JSON.stringify(value)}`)
    }
    if (key === 'maxFindingsPerRule' && Number.isInteger(value) === false) {
      return invalid(`${ROOT_META_FILE} ${GATE_BOOK_SECTION}.${key}: expected a whole number of findings, found ${JSON.stringify(value)}`)
    }
    overrides[key] = value
  }
  const merged: GateThresholds = { ...GATE_DEFAULTS, ...overrides }
  if (merged.wordCountMin >= merged.wordCountMax) {
    return invalid(
      `${ROOT_META_FILE} ${GATE_BOOK_SECTION}: wordCountMin (${String(merged.wordCountMin)}) must be below ` +
        `wordCountMax (${String(merged.wordCountMax)})`,
      'a range that excludes everything would report every chapter twice',
    )
  }
  return { overrides }
}

/** Read both halves; either half being wrong refuses the whole run (a gate never half-applies口径). */
export function loadGateConfig(root: string): GateConfigResult {
  const section = readGateSection(root)
  if ('ok' in section) return section
  const whitelistPath = gateWhitelistPath()
  let whitelist: readonly GateWaiverEntry[] = []
  const file = join(root, whitelistPath)
  if (existsSync(file)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (cause) {
      return invalid(`cannot read ${whitelistPath}: ${String(cause)}`, 'the file exists but could not be read')
    }
    const parsed = parseWhitelist(text, whitelistPath)
    if (parsed.error !== undefined) {
      return refuse({
        code: 'GATE_WHITELIST_INVALID',
        message: parsed.error.message,
        hint: `the whitelist lives at ${whitelistPath}; one literal fragment per line, # starts a comment`,
      })
    }
    whitelist = parsed.entries
  }
  return {
    ok: true,
    config: {
      thresholds: { ...GATE_DEFAULTS, ...(section.overrides ?? {}) },
      whitelist,
      whitelistPath,
    },
  }
}
