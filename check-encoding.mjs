/**
 * Repo invariant check: no UTF-8 BOM anywhere, every .json parses, and every
 * shipped script passes a syntax check.
 *
 * This exists because a BOM written by PowerShell's `Set-Content -Encoding utf8`
 * broke `package.json` badly enough that `install_bundle` from GitHub failed with
 * "Unexpected token '\uFEFF'" — the most damaging possible place for it.
 *
 * Usage: node check-encoding.mjs [--fix]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawnSync } from 'node:child_process'

const FIX = process.argv.includes('--fix')
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const BOM = [0xef, 0xbb, 0xbf]

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (statSync(full).isFile()) acc.push(full)
  }
  return acc
}

const problems = []
const fixed = []

for (const file of walk('.')) {
  const bytes = readFileSync(file)
  const hasBom = bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
  if (hasBom) {
    if (FIX) {
      writeFileSync(file, bytes.subarray(3))
      fixed.push(`${file} (BOM 已移除)`)
    } else {
      problems.push(`${file}: 含 UTF-8 BOM`)
    }
  }
  if (extname(file) === '.json') {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    try {
      JSON.parse(text)
    } catch (error) {
      problems.push(`${file}: JSON 无法解析 (${error.message})`)
    }
  }
}

for (const script of [
  'assets/api-test/scripts/md2pdf.mjs',
  'assets/api-test/scripts/digraph.mjs',
  'assets/api-test/scripts/classmap.mjs'
]) {
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    problems.push(`${script}: 语法检查失败 (${(result.stderr || '').trim().split('\n')[0]})`)
  }
}

for (const line of fixed) console.log(`  fixed  ${line}`)
if (problems.length === 0) {
  console.log('ENCODING OK (no BOM, all JSON parses, all scripts parse)')
} else {
  for (const line of problems) console.log(`  FAIL   ${line}`)
  console.log(`${problems.length} encoding problem(s)`)
  process.exitCode = 1
}
