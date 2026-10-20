/**
 * The model-facing tool surface of dsh-inkflow.
 *
 * P0 registers three tools, on purpose: they are the smallest set that proves
 * the DSH tool pipeline works end to end (registration -> schema -> execute ->
 * rendered result) AND that SQLite read/write works from inside the Host.
 * The full inkflow_* surface (25-30 tools) lands in P1 on top of the same
 * data layer.
 *
 * Tools are plain objects, not `defineTool(...)` results: see context.ts for
 * why this package avoids runtime imports of @deepseek-ai/*.
 */

import type { ContentBlock, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import type { Database, ProjectRow } from './db.js'
import { countProjects, createProject, listProjects, SCHEMA_VERSION } from './db.js'

export interface ToolDeps {
  database: Database
  dataDir: string
  dbFile: string
  version: string
}

export interface ProjectView {
  id: string
  title: string
  subtitle: string
  author: string
  genre: string
  /** Empty string when the book is not part of a series. */
  seriesId: string
  status: ProjectRow['status']
  wordCount: number
  chapterCount: number
  rev: number
  createdAt: string
  updatedAt: string
}

function toView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    author: row.author,
    genre: row.genre,
    seriesId: row.series_id ?? '',
    status: row.status,
    wordCount: row.word_count,
    chapterCount: row.chapter_count,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const PROJECT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable project id (UUID v4).' },
    title: { type: 'string' },
    subtitle: { type: 'string' },
    author: { type: 'string' },
    genre: { type: 'string' },
    seriesId: { type: 'string', description: 'Series id, empty when not part of a series.' },
    status: { type: 'string', enum: ['draft', 'writing', 'finished', 'archived'] },
    wordCount: { type: 'integer' },
    chapterCount: { type: 'integer' },
    rev: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: ['id', 'title', 'status', 'wordCount', 'chapterCount'],
  additionalProperties: false,
}

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function buildTools(deps: ToolDeps): ToolDefinition[] {
  const { database } = deps

  const health: ToolDefinition = {
    name: 'inkflow_health',
    description:
      'InkFlow local library health: database path, schema version and project count. ' +
      'Call this first whenever another inkflow_* tool reports a storage problem, or to confirm ' +
      'that the novel library on this machine is readable.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          pluginVersion: { type: 'string' },
          dataDir: { type: 'string' },
          dbFile: { type: 'string' },
          schemaVersion: { type: 'integer' },
          projectCount: { type: 'integer' },
        },
        required: ['ok', 'dataDir', 'dbFile', 'schemaVersion', 'projectCount'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = asRecord(value)
        return text([
          `InkFlow ok=${String(v['ok'])} schema=v${String(v['schemaVersion'])} projects=${String(v['projectCount'])}`,
          `dataDir: ${String(v['dataDir'])}`,
          `db: ${String(v['dbFile'])}`,
        ])
      },
    },
    execute: async () => ({
      ok: true,
      pluginVersion: deps.version,
      dataDir: deps.dataDir,
      dbFile: deps.dbFile,
      schemaVersion: SCHEMA_VERSION,
      projectCount: countProjects(database),
    }),
  }

  const projectList: ToolDefinition = {
    name: 'inkflow_project_list',
    description:
      'List novel projects (books) in the local InkFlow library, newest updated first. ' +
      'Use it to find the project id that every other inkflow_* tool expects.',
    parameters: {
      type: 'object',
      properties: {
        includeArchived: {
          type: 'boolean',
          description: 'Include archived projects. Default false.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum rows to return. Default 100.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          projects: { type: 'array', items: PROJECT_SCHEMA },
        },
        required: ['total', 'projects'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = asRecord(value)
        const projects = Array.isArray(v['projects']) ? (v['projects'] as ProjectView[]) : []
        if (projects.length === 0) return text(['No projects yet. Create one with inkflow_project_create.'])
        return text([
          `${projects.length} project(s):`,
          ...projects.map(
            (p) =>
              `- ${p.title} [${p.status}] ${p.chapterCount} chapters / ${p.wordCount} words — id ${p.id}`,
          ),
        ])
      },
    },
    execute: async (args) => {
      const a = asRecord(args)
      const rows = listProjects(database, {
        includeArchived: a['includeArchived'] === true,
        limit: typeof a['limit'] === 'number' ? a['limit'] : undefined,
      })
      return { total: rows.length, projects: rows.map(toView) }
    },
  }

  const projectCreate: ToolDefinition = {
    name: 'inkflow_project_create',
    description:
      'Create a novel project (book) in the local InkFlow library and return its id. ' +
      'New projects start in status "draft" with zero chapters. Ask the user for the title ' +
      'when it is not stated; do not invent one.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project (book) title. Required, non-empty.' },
        subtitle: { type: 'string', description: 'Optional subtitle.' },
        author: { type: 'string', description: 'Optional author pen name.' },
        genre: { type: 'string', description: 'Optional genre label, e.g. 武侠 / 仙侠.' },
        seriesId: {
          type: 'string',
          description: 'Optional id of the series this book belongs to.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { project: PROJECT_SCHEMA },
        required: ['project'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const project = asRecord(asRecord(value)['project']) as unknown as ProjectView
        return text([`Created project "${project.title}" (${project.id}).`])
      },
    },
    execute: async (args) => {
      const a = asRecord(args)
      const title = typeof a['title'] === 'string' ? a['title'] : ''
      const row = createProject(database, {
        title,
        subtitle: typeof a['subtitle'] === 'string' ? a['subtitle'] : undefined,
        author: typeof a['author'] === 'string' ? a['author'] : undefined,
        genre: typeof a['genre'] === 'string' ? a['genre'] : undefined,
        seriesId: typeof a['seriesId'] === 'string' ? a['seriesId'] : null,
      })
      return { project: toView(row) }
    },
  }

  return [health, projectList, projectCreate]
}

/** Unused today; kept so the first tool that needs cancellation has the shape. */
export type { ToolRunContext }
