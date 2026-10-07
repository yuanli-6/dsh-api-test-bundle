/**
 * Validate `cordis.patch.yml` against the loader's documented insert dialect.
 *
 * Portable by design:
 *  - validates the structure this bundle relies on (top-level array of
 *    `insert` lists of rows carrying `id` / `name`), not one machine's files;
 *  - uses the real js-yaml when it can find a DSH installation to borrow it
 *    from, and otherwise falls back to a tiny parser covering this patch's
 *    subset, so the check still runs on a bare checkout.
 *
 * Run: node check-patch.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const PATCH = 'cordis.patch.yml'
const PKG = 'package.json'
const PACKAGE_NAME = 'dsh-api-test-bundle'

const failures = []
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label} -> ${error.message}`)
  }
}

/**
 * Parse the subset of YAML this patch uses: nested block maps and arrays, plus
 * the scalar literals `true` / `false` / `null` / `{}` / `[]`. Frames are
 * "current container + its indent", so an `insert:` list nested inside a
 * top-level list item is never mistaken for a second entry.
 *
 * Out of scope by design: anchors and aliases, `!!js` tags, block scalars,
 * multi-line values, and flow collections with contents. The automated check
 * below only relies on the in-scope subset; a real js-yaml is preferred
 * whenever one can be found.
 */
function parseMinimal(text) {
  const root = []
  const stack = [{ indent: -1, container: root }]
  const scalar = (raw) => {
    const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value === 'true') return true
    if (value === 'false') return false
    if (value === 'null' || value === '~') return null
    if (value === '{}') return {}
    if (value === '[]') return []
    return value
  }
  const lines = []

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue
    lines.push({ indent: rawLine.length - rawLine.trimStart().length, text: rawLine.trim() })
  }

  for (let i = 0; i < lines.length; i += 1) {
    const { indent, text: line } = lines[i]
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const container = stack[stack.length - 1].container

    if (line.startsWith('-') && (line.length === 1 || line[1] === ' ')) {
      const rest = line.slice(1).trim()
      if (!Array.isArray(container)) continue
      const pair = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(rest)
      if (pair) {
        const object = {}
        container.push(object)
        const rawValue = (pair[2] ?? '').trim()
        if (rawValue === '') {
          // `- key:` opens a nested map/array decided by the next line.
          const isArray = i + 1 < lines.length && lines[i + 1].text.startsWith('-')
          const child = isArray ? [] : {}
          object[pair[1]] = child
          stack.push({ indent, container: child })
        } else {
          object[pair[1]] = scalar(rawValue)
          stack.push({ indent, container: object })
        }
      } else {
        container.push(scalar(rest))
      }
      continue
    }

    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!pair || Array.isArray(container)) continue
    const [, key, rawValue] = pair
    if (rawValue.trim() !== '') {
      container[key] = scalar(rawValue)
      continue
    }
    const isArray = i + 1 < lines.length && lines[i + 1].text.startsWith('-')
    const child = isArray ? [] : {}
    container[key] = child
    stack.push({ indent, container: child })
  }

  return root
}

/** Candidate js-yaml locations: an unpacked install, or a plain resolvable dep. */
function yamlCandidates() {
  const bases = [
    process.env.DSH_INSTALL,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    'C:/Program Files/DeepSeek Harness',
    'C:/Program Files (x86)/DeepSeek Harness'
  ].filter((value) => typeof value === 'string' && value.length > 0)

  const urls = []
  for (const base of bases) {
    for (const rel of [
      'resources/app.asar.unpacked/node_modules/js-yaml/dist/js-yaml.mjs',
      'resources/app.asar/dsh/node_modules/js-yaml/dist/js-yaml.mjs'
    ]) {
      const onDisk = join(base, ...rel.split('/'))
      if (existsSync(onDisk)) urls.push(pathToFileURL(onDisk).href)
    }
  }
  // A plain (non-asar) install that already has js-yaml resolvable.
  urls.push('js-yaml')
  return urls
}

let parse
let parserLabel = 'built-in minimal parser'
for (const url of yamlCandidates()) {
  const mod = await import(url).then((m) => m.default ?? m).catch(() => null)
  if (mod && typeof mod.load === 'function') {
    parse = (text) => mod.load(text, { filename: PATCH })
    parserLabel = url === 'js-yaml' ? 'js-yaml' : `js-yaml (${url})`
    break
  }
}
if (!parse) parse = parseMinimal
console.log(`parser: ${parserLabel}`)
console.log('')

const ours = parse(readFileSync(PATCH, 'utf8'))

check('patch parses to a top-level array', () => {
  if (!Array.isArray(ours)) throw new Error(`expected an array, got ${typeof ours}`)
})
check('patch has exactly one entry', () => {
  if (ours.length !== 1) throw new Error(`expected 1 entry, got ${ours.length}`)
})
check('entry carries an insert list', () => {
  if (!Array.isArray(ours[0]?.insert)) throw new Error('entry.insert is not an array')
})
check('insert has exactly one row', () => {
  if (ours[0].insert.length !== 1) throw new Error(`expected 1 row, got ${ours[0].insert.length}`)
})

const row = ours[0].insert[0]
check('row has a string id', () => {
  if (typeof row?.id !== 'string') throw new Error(`id is ${typeof row?.id}`)
})
check('row has a string name', () => {
  if (typeof row?.name !== 'string') throw new Error(`name is ${typeof row?.name}`)
})
check(`row id === "${PACKAGE_NAME}"`, () => {
  if (row.id !== PACKAGE_NAME) throw new Error(`got "${row.id}"`)
})
check(`row name === "${PACKAGE_NAME}" (Node resolution)`, () => {
  if (row.name !== PACKAGE_NAME) throw new Error(`got "${row.name}"`)
})
check('row has no unexpected keys', () => {
  const extra = Object.keys(row).filter((k) => !['id', 'name', 'config', 'disabled'].includes(k))
  if (extra.length > 0) throw new Error(`unexpected keys: ${extra.join(', ')}`)
})

// The loader turns `insert` entries into tree rows the composition can resolve.
const tree = []
for (const entry of ours) if (Array.isArray(entry.insert)) for (const r of entry.insert) tree.push({ ...r })
check('simulated loader tree contains the plugin row', () => {
  const foundRow = tree.find((r) => r.id === PACKAGE_NAME)
  if (!foundRow) throw new Error('row missing after insert')
  if (foundRow.name !== PACKAGE_NAME) throw new Error(`row name "${foundRow.name}"`)
})

// The row names a package that must actually be this one.
const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
check('row name equals the manifest package name', () => {
  if (pkg.name !== PACKAGE_NAME) throw new Error(`manifest name is "${pkg.name}"`)
})
check('manifest declares dsh.bundle.patch as this file', () => {
  if (pkg.dsh?.bundle?.patch !== `./${PATCH}`) throw new Error(`got "${pkg.dsh?.bundle?.patch}"`)
})
check('manifest exports "." for the loader', () => {
  if (pkg.exports?.['.'] !== './index.js') throw new Error(`got "${pkg.exports?.['.']}"`)
})

console.log('')
console.log(failures.length === 0 ? 'ALL PATCH CHECKS PASSED' : `${failures.length} PATCH CHECK(S) FAILED`)
process.exitCode = failures.length === 0 ? 0 : 1
