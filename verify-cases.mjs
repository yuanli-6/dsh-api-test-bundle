/**
 * Self-test for `assets/api-test/scripts/cases2xlsx.mjs`.
 *
 * The skill tells the model to write its test cases through that script, so a
 * broken writer means the deliverable the user actually opens is broken — and
 * only a real workbook exercises the parts that break: the ZIP container, the
 * inline-string encoding, XML escaping, and Excel's own limits.
 *
 * Two things this deliberately does NOT do:
 *  - it does not ship a toy fixture. Sixty-four cases across four sheets, with
 *    long JSON blobs, missing fields, special characters and a value past
 *    Excel's 32767-character cell limit, is the scale the skill really runs at;
 *  - it does not trust the writer's own exit code. The produced bytes are
 *    unzipped again here and the cell text is read back out of the XML.
 *
 * Run: node verify-cases.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inflateRawSync } from 'node:zlib'

const SCRIPT = 'assets/api-test/scripts/cases2xlsx.mjs'
const failures = []
const warnings = []

const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label} -> ${error.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

// ── fixture: mainstream test-case columns at real scale ──────────────────────
const CASE_COLUMNS = [
  '用例编号', '所属模块', '接口名称', '接口路径', '用例标题', '用例类型', '优先级',
  '前置条件', '测试步骤', '测试数据', '预期结果', '实际结果', '结论'
]
const MODULES = ['用户管理', '任务安排', '工时统计', '技能等级']
const TYPES = ['正向', '业务规则', '边界(合法)', '异常(未被代码校验覆盖)', '幂等', '性能观察']

const cases = []
for (let i = 0; i < 60; i += 1) {
  const module = MODULES[i % MODULES.length]
  const type = TYPES[i % TYPES.length]
  cases.push([
    `TC-SysUser-${String(i + 1).padStart(3, '0')}`,
    module,
    `SysUserController#method${String(i + 1)}`,
    `/api/users/action${String(i + 1)}`,
    `${module}：${type}校验第 ${String(i + 1)} 条`,
    type,
    ['P0', 'P1', 'P2'][i % 3],
    i % 4 === 0 ? null : '应用已启动，数据库连接正常，需登录后携带 Token',
    `1. 调用 ${module} 接口\n2. 核对返回\n3. 记录耗时`,
    JSON.stringify({ userName: `apitest_r${String((i % 3) + 1)}_9f3a1c`, age: 18 + (i % 40), remark: '正常范围备注 <&>"\'\n第二行' }),
    'HTTP 200；code=200；data 关键字段与请求一致；无堆栈',
    i % 7 === 0 ? '' : 'HTTP 200 / code=200 / 12ms',
    i % 7 === 0 ? '失败' : '通过'
  ])
}
cases.push(['TC-SysUser-061', '用户管理', 'f#formula', '/x', '公式样式文本', '边界(合法)', 'P1', '', '1', '=1+1', '文本', '=1+1', '通过'])
cases.push(['TC-SysUser-062', '用户管理', 'f#zeros', '/x', '前导零', '边界(合法)', 'P1', '', '1', '00123', '文本', '00123', '通过'])
cases.push(['TC-SysUser-063', '用户管理', 'f#date', '/x', '日期样式文本', '边界(合法)', 'P2', '', '1', '2026-10-11', '文本', '2026-10-11', '通过'])
cases.push(['TC-SysUser-064', '用户管理', 'f#long', '/x', '超长与表情', '异常(未被代码校验覆盖)', 'P2', '', '1', `😀🚀\t"引号" ${'超长内容'.repeat(9000)}`, '不报错', 'ok', '通过'])

const fixture = {
  title: '接口测试用例',
  sheets: [
    { name: '测试用例', columns: CASE_COLUMNS, rows: cases },
    {
      name: '契约校验已覆盖',
      columns: ['约束', '代码位置', '校验方式', '处理'],
      rows: [['userReq.userName 非空', 'UserServiceImpl#check', 'StringUtils.isBlank → CustomException', '不再单列空值用例']]
    },
    {
      name: '字段来源',
      columns: ['层级', '返回字段', '含义', '来源表', '查询条件', '备注'],
      rows: [[1, 'userName', '姓名', 'user', 'userName="123"', ''], [3, 'emptyRow', null, '', '', null]]
    },
    { name: '空表', columns: ['列A', '列B'], rows: [] },
    // Illegal sheet name: must be sanitized rather than producing a file Excel rejects.
    { name: 'a/b:c*d?e[f]g', columns: ['x'], rows: [['y']] }
  ]
}

// ── minimal ZIP reader (EOCD → central directory → local headers) ────────────
function readZip(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert(eocd !== -1, 'no End Of Central Directory record found')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i += 1) {
    assert(buffer.readUInt32LE(offset) === 0x02014b50, `bad central header at ${String(offset)}`)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

// ── run the writer on the fixture ────────────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'cases2xlsx-selftest-'))
const inputPath = join(workDir, 'cases.json')
const xlsxPath = join(workDir, 'cases.xlsx')
writeFileSync(inputPath, JSON.stringify(fixture), 'utf8')

const run = spawnSync(process.execPath, [SCRIPT, inputPath, xlsxPath, '--csv'], { encoding: 'utf8' })
console.log(`writer exit ${String(run.status)}`)
if (run.stdout) process.stdout.write(run.stdout)
if (run.stderr) {
  process.stderr.write(run.stderr)
  warnings.push(run.stderr.trim())
}
console.log('')

console.log('writer run')
check('exits 0 on a valid fixture', () => assert(run.status === 0, `exit ${String(run.status)}`))
check('reports the truncation it performed', () => {
  assert((run.stderr ?? '').includes('已截断'), 'the over-long cell was not reported')
})
check('rejects a missing argument with a usage error', () => {
  const bad = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert(bad.status === 2, `expected exit 2, got ${String(bad.status)}`)
})
check('rejects a sheet without columns', () => {
  writeFileSync(join(workDir, 'bad.json'), JSON.stringify({ sheets: [{ rows: [] }] }), 'utf8')
  const bad = spawnSync(process.execPath, [SCRIPT, join(workDir, 'bad.json'), join(workDir, 'bad.xlsx')], { encoding: 'utf8' })
  assert(bad.status !== 0, 'invalid input was accepted')
})

// ── read the produced workbook back from its own bytes ───────────────────────
console.log('')
console.log('workbook container')
const book = readFileSync(xlsxPath)
const parts = readZip(book)

check('contains the required OOXML parts', () => {
  for (const name of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml'
  ]) {
    assert(parts.has(name), `missing ${name}`)
  }
})
check('declares one worksheet part per sheet', () => {
  const sheetParts = [...parts.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
  assert(sheetParts.length === fixture.sheets.length, `found ${String(sheetParts.length)} sheet parts`)
})
check('every part is non-empty', () => {
  for (const [name, data] of parts) assert(data.length > 0, `${name} is empty`)
})
check('content types declare every sheet and the styles part', () => {
  const types = parts.get('[Content_Types].xml').toString('utf8')
  for (let i = 1; i <= fixture.sheets.length; i += 1) {
    assert(types.includes(`/xl/worksheets/sheet${String(i)}.xml`), `sheet${String(i)} not declared`)
  }
  assert(types.includes('/xl/styles.xml'), 'styles not declared')
})
check('workbook.xml lists every sheet with a matching relationship', () => {
  const workbook = parts.get('xl/workbook.xml').toString('utf8')
  const rels = parts.get('xl/_rels/workbook.xml.rels').toString('utf8')
  for (let i = 1; i <= fixture.sheets.length; i += 1) {
    assert(workbook.includes(`r:id="rId${String(i)}"`), `rId${String(i)} missing from workbook.xml`)
    assert(rels.includes(`Id="rId${String(i)}"`), `rId${String(i)} missing from workbook rels`)
  }
  assert(rels.includes(`Id="rId${String(fixture.sheets.length + 1)}"`), 'styles relationship missing')
})

const sheet1 = parts.get('xl/worksheets/sheet1.xml').toString('utf8')
const sheetByName = (name) => {
  const index = fixture.sheets.findIndex((sheet) => sheet.name === name)
  return parts.get(`xl/worksheets/sheet${String(index + 1)}.xml`).toString('utf8')
}

console.log('')
console.log('cell content')
check('header row is styled and frozen', () => {
  assert(sheet1.includes('<pane ySplit="1" topLeftCell="A2"'), 'freeze pane missing')
  assert(/<c r="A1" s="1" t="inlineStr">/u.test(sheet1), 'header cell is not using the header style')
})
check('every data row is present', () => {
  const rows = [...sheet1.matchAll(/<row r="(\d+)"/gu)].map((match) => Number(match[1]))
  assert(rows.length === cases.length + 1, `found ${String(rows.length)} rows, expected ${String(cases.length + 1)}`)
  assert(rows[rows.length - 1] === cases.length + 1, 'last row number is wrong')
})
check('formula-looking text is written as an inline string, never a formula', () => {
  assert(sheet1.includes('>=1+1<'), 'the =1+1 cell is missing')
  assert(sheet1.includes('xml:space="preserve">=1+1<'), 'the formula-looking text was mangled')
  assert(!sheet1.includes('<f>'), 'a real formula element was written')
})
check('leading zeros survive', () => assert(sheet1.includes('>00123<'), 'the leading-zero cell was coerced'))
check('date-looking text survives', () => assert(sheet1.includes('>2026-10-11<'), 'the date-looking cell was coerced'))
check('special characters are escaped, not emitted raw', () => {
  assert(sheet1.includes('&lt;&amp;&gt;') || sheet1.includes('&lt;&amp;'), 'the <&> text is not XML-escaped')
  assert(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/u.test(sheet1), 'an unescaped ampersand reached the XML')
})
check('over-long text is truncated below Excel’s limit and marked', () => {
  const match = /已截断 (\d+) 字符/u.exec(sheet1)
  assert(match !== null, 'no truncation marker found')
  const longest = Math.max(...[...sheet1.matchAll(/<t xml:space="preserve">([\s\S]*?)<\/t>/gu)].map((m) => m[1].length))
  assert(longest <= 32767, `a cell holds ${String(longest)} characters`)
})
check('short text is not truncated', () => assert(!sheet1.includes('正常范围备注') === false, 'short cell text disappeared'))
check('null becomes an empty cell, not the string "null"', () => {
  const source = sheetByName('字段来源')
  assert(!source.includes('>null<'), 'a null was rendered as text')
  assert(/<c r="C3"[^>]*\/>/u.test(source), 'the empty cell is not self-closing')
})
check('the empty sheet still has its header and a valid dimension', () => {
  const empty = sheetByName('空表')
  assert(empty.includes('>列A<') && empty.includes('>列B<'), 'header missing on the empty sheet')
  assert(empty.includes('<dimension ref="A1:B1"/>'), 'wrong dimension on the empty sheet')
  assert(!empty.includes('<autoFilter'), 'an auto-filter was written for a header-only sheet')
})
check('ANSI-hostile sheet names are sanitized', () => {
  const workbook = parts.get('xl/workbook.xml').toString('utf8')
  assert(workbook.includes('name="a_b_c_d_e_f_g"'), 'the illegal sheet name was not sanitized')
})
check('no sheet name exceeds Excel’s 31-character limit', () => {
  const names = [...parts.get('xl/workbook.xml').toString('utf8').matchAll(/<sheet name="([^"]*)"/gu)].map((m) => m[1])
  for (const name of names) assert(name.length <= 31, `sheet name too long: ${name}`)
})

console.log('')
console.log('csv side output')

/**
 * Parse a whole CSV document, honoring quoted fields that contain commas,
 * doubled quotes and embedded newlines (the 测试步骤 column really has one).
 *
 * @param {string} text - CSV file content without its BOM.
 * @returns {string[][]} rows of fields.
 */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
    } else field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

// Excel forbids : \ / ? * [ ] in sheet names, so the side files are named after
// the sanitized name — the same rule the workbook's sheet tabs follow.
const csvName = (raw) => raw.replace(/[:\\/?*[\]]/g, '_').slice(0, 31)

check('one BOM-prefixed CSV per sheet, with a header row', () => {
  for (const sheet of fixture.sheets) {
    const path = join(workDir, `cases.${csvName(sheet.name)}.csv`)
    const csv = readFileSync(path)
    assert(csv[0] === 0xef && csv[1] === 0xbb && csv[2] === 0xbf, `no BOM in ${path}`)
    const text = csv.toString('utf8').slice(1)
    assert(text.startsWith(sheet.columns[0]), `header missing in ${path}`)
    assert(text.endsWith('\r\n'), `no CRLF terminator in ${path}`)
  }
})
check('CSV round-trips fields containing commas, quotes and newlines', () => {
  const text = readFileSync(join(workDir, 'cases.测试用例.csv'), 'utf8').slice(1)
  const rows = parseCsv(text)
  assert(rows.length === cases.length + 1, `parsed ${String(rows.length)} CSV rows, expected ${String(cases.length + 1)}`)
  const header = rows[0]
  assert(header.length === CASE_COLUMNS.length, `header parsed into ${String(header.length)} fields`)
  assert(header.join('|') === CASE_COLUMNS.join('|'), 'header fields do not match the declared columns')
  const first = rows[1]
  assert(first[0] === 'TC-SysUser-001', `first case id is ${first[0]}`)
  assert(first[8] === cases[0][8], 'the newline-bearing 测试步骤 field did not round-trip')
  assert(first[9] === cases[0][9], 'the JSON 测试数据 field did not round-trip')
  assert(first[7] === '', 'the null 前置条件 field did not become an empty field')
})

// ── cleanup ─────────────────────────────────────────────────────────────────
check('the temporary working directory is the one this test created', () => {
  assert(workDir.startsWith(tmpdir()) && workDir.includes('cases2xlsx-selftest-'), `refusing to clean ${workDir}`)
})
rmSync(workDir, { recursive: true, force: true })

console.log('')
if (warnings.length > 0) console.log(`${String(warnings.length)} warning(s) from the writer run`)
console.log(
  failures.length === 0
    ? `ALL CHECK CHECKS PASSED (cases2xlsx: ${String(cases.length)} cases, ${String(fixture.sheets.length)} sheets, verified from the produced bytes)`
    : `${String(failures.length)} CHECK(S) FAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}`
)
process.exitCode = failures.length === 0 ? 0 : 1
