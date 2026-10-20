/**
 * Plugin-level state (NOT project data).
 *
 * Under ADR-0005 the novel lives in its own git repo; the only thing the
 * plugin keeps for itself is "which project did this machine last touch",
 * so the workbench page has something to show without guessing a path.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PluginState {
  lastProjectRoot?: string
  updatedAt?: string
}

const STATE_FILE = 'state.json'

export function readState(dataDir: string): PluginState {
  try {
    const raw = readFileSync(join(dataDir, STATE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    const state: PluginState = {}
    if (typeof record['lastProjectRoot'] === 'string') state.lastProjectRoot = record['lastProjectRoot']
    if (typeof record['updatedAt'] === 'string') state.updatedAt = record['updatedAt']
    return state
  } catch {
    return {}
  }
}

/** Atomic replace: write a temp file in the same directory, then rename. */
export function writeState(dataDir: string, state: PluginState): void {
  mkdirSync(dataDir, { recursive: true })
  const target = join(dataDir, STATE_FILE)
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, target)
}

export function rememberProject(dataDir: string, root: string): void {
  const current = readState(dataDir)
  if (current.lastProjectRoot === root) return
  writeState(dataDir, { lastProjectRoot: root, updatedAt: new Date().toISOString() })
}
