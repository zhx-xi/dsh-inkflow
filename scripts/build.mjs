/**
 * Build dsh-inkflow's two halves.
 *
 *   lib/index.js   Host half   — ESM, bundled, platform=node (node: builtins external)
 *   lib/client.js  Client half — CJS factory wrapped for window.__ModuleLoader__
 *
 * WHY ESBUILD AND NOT tsdown (decided in P0, see docs/adr/0003-build-chain.md):
 * the Client half must be emitted as exactly
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 * with React resolved through the injected `require` and nothing else bundled in.
 * esbuild's banner/footer + CJS output produces that byte-for-byte and is the
 * pattern already proven by a shipped DSH plugin (dsh-memory-evolve). One
 * toolchain for both halves keeps the failure surface small; if we later need
 * .d.ts emit for library consumers, tsdown is added for the Host half only.
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PLUGIN_ID = manifest.name

/**
 * Build stamp: `<git short sha>@<ISO>`.
 *
 * DSH loads `lib/` ONCE at startup and HMR never swaps an already-loaded plugin,
 * so the process can be executing a generation that no longer exists on disk —
 * and no file on disk can be modified afterwards to say so. The only place a
 * running process can learn "which code am I" is a value baked in at build time,
 * which is what `__INKFLOW_BUILD__` is for (`src/host/build-info.ts` reads it and
 * compares it with the mtime of its own file).
 *
 * Git is optional (a tarball, a checkout without `.git`): the sha degrades to
 * `unknown` and the timestamp still separates two generations.
 */
function buildStamp() {
  const builtAt = new Date().toISOString()
  let sha = 'unknown'
  try {
    const resolved = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      // stderr is dropped on purpose: a missing git is expected, not an error.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (resolved !== '') sha = resolved
  } catch {
    // keep 'unknown'
  }
  return `${sha}@${builtAt}`
}

const BUILD = buildStamp()

/**
 * The plugin version, injected instead of hand-copied.
 *
 * It used to be a `const VERSION = '0.0.2'` in `src/host/index.ts` *alongside*
 * `package.json`'s `version` — two literals that had to be moved together and never were
 * (the package stayed at 0.0.2 through 0.4.0). Now `package.json` is the single source:
 * the build bakes it into both halves, and `tests/build-info.test.js` asserts the bundle
 * reports the same string, so a forgotten bump fails `npm run check` instead of shipping.
 */
const VERSION = String(manifest.version)
/** Both halves carry the stamp: one value, one generation. */
const BUILD_DEFINE = { __INKFLOW_BUILD__: JSON.stringify(BUILD), __INKFLOW_VERSION__: JSON.stringify(VERSION) }

/**
 * Browser platform module table. Everything here is provided by the DSH web
 * shell through the factory's `require`; everything else is bundled.
 * Keep in sync with the loader's platform module list.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientBanner = [
  `window.__ModuleLoader__.load({`,
  `  id: ${JSON.stringify(PLUGIN_ID)},`,
  `  factory: (require) => {`,
  `    var module = { exports: {} };`,
  `    var exports = module.exports;`,
].join('\n')

const clientFooter = 'return module.exports; } });'

async function buildHost() {
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/host/index.ts')],
    outfile: join(ROOT, 'lib/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: false,
    define: BUILD_DEFINE,
    logLevel: 'warning',
  })
  console.log(`built lib/index.js (host, esm) ${BUILD}`)
}

async function buildClient() {
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/client/index.tsx')],
    outfile: join(ROOT, 'lib/client.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: CLIENT_EXTERNALS,
    jsx: 'automatic',
    // esbuild defaults to `charset: 'ascii'`, which would escape every Chinese
    // label in the panel into `\uXXXX`. The bundle is served as UTF-8 anyway, so
    // keeping the characters literal makes the shipped UI text inspectable —
    // tests/panel-bundle.test.js asserts the wording the user actually sees.
    charset: 'utf8',
    define: {
      'process.env.NODE_ENV': '"production"',
      ...BUILD_DEFINE,
    },
    banner: { js: clientBanner },
    footer: { js: clientFooter },
    sourcemap: false,
    logLevel: 'warning',
  })
  console.log(`built lib/client.js (client, module-loader factory) ${BUILD}`)
}

await buildHost()
await buildClient()
