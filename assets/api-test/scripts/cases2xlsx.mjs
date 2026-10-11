/**
 * cases2xlsx — write a test-case / field-source workbook as a real .xlsx.
 *
 * Why hand-rolled: this bundle ships zero runtime dependencies, and the skill
 * must hand the user an Excel file that Excel, WPS and LibreOffice all open.
 * `.xlsx` is a ZIP of XML parts, and Node already has everything needed
 * (`node:zlib` for the members, plus a 20-line CRC32), so the alternative —
 * telling the model to emit CSV and hope Excel guesses the encoding — is worse
 * in exactly the case that matters (Chinese columns, hundreds of rows,
 * multi-sheet workbooks with a "契约校验已覆盖" tab).
 *
 * Design decisions that keep the output trustworthy:
 *  - **Every string is an inline string** (`t="inlineStr"`), never a shared
 *    string and never text that Excel might re-interpret. A cell containing
 *    `=1+1`, `00123` or `2026-10-11` stays exactly the text that was written:
 *    no formula injection, no lost leading zeros, no silent date coercion.
 *  - Numbers and booleans keep their real type so sorting and summing work.
 *  - Cell text is capped at Excel's own 32767-character limit, and XML-illegal
 *    control characters are dropped, instead of producing a file Excel refuses
 *    to open.
 *  - The header row is bold with a fill, frozen, and gets an auto-filter; data
 *    cells wrap, so long 测试数据 JSON blobs stay readable.
 *
 * Input JSON:
 *   {
 *     "title": "接口测试用例",
 *     "sheets": [
 *       { "name": "测试用例", "columns": ["用例编号", …], "rows": [["TC-x-001", …], …],
 *         "widths": [14, 12],          // optional, per column
 *         "freeze": true,              // optional, default true
 *         "filter": true }             // optional, default true
 *     ]
 *   }
 * A single-sheet shorthand `{ "columns": …, "rows": … }` is accepted too.
 *
 * Usage:
 *   node cases2xlsx.mjs <input.json> <output.xlsx> [--csv]
 *
 * `--csv` additionally writes one UTF-8-BOM CSV per sheet next to the xlsx
 * (`<stem>.<sheet name>.csv`), for tools that want plain text.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

/** Excel refuses more than this many characters in one cell. */
const MAX_CELL_CHARS = 32767

/** XML 1.0 forbids most control characters; tab, LF and CR are the exceptions. */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g

const problems = []

/**
 * Escape one string for XML text content.
 *
 * @param {string} value - raw cell text.
 * @returns {string} text safe inside `<t>…</t>`.
 */
function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(ILLEGAL_XML, '')
}

/**
 * Normalize one cell value into the shape written into the sheet.
 *
 * @param {unknown} value - the input value.
 * @returns {{kind: 'empty'} | {kind: 'number', value: number} | {kind: 'boolean', value: boolean} | {kind: 'text', value: string}} normalized cell.
 */
function normalizeCell(value) {
  if (value === null || value === undefined) return { kind: 'empty' }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      problems.push(`非有限数字被写成空单元格：${String(value)}`)
      return { kind: 'empty' }
    }
    return { kind: 'number', value }
  }
  if (typeof value === 'boolean') return { kind: 'boolean', value }

  let text = typeof value === 'string' ? value : JSON.stringify(value)
  text = text.replace(ILLEGAL_XML, '')
  if (text.length > MAX_CELL_CHARS) {
    const dropped = text.length - MAX_CELL_CHARS
    text = `${text.slice(0, MAX_CELL_CHARS - 40)}…[已截断 ${dropped} 字符]`
    problems.push(`单元格超过 Excel 上限，已截断 ${dropped} 字符`)
  }
  return { kind: 'text', value: text }
}

/**
 * Render one cell.
 *
 * @param {string} ref - A1 reference, e.g. `B7`.
 * @param {number} styleIndex - cellXfs index.
 * @param {unknown} raw - cell value.
 * @returns {string} the `<c>` element.
 */
function renderCell(ref, styleIndex, raw) {
  const cell = normalizeCell(raw)
  const style = styleIndex === 0 ? '' : ` s="${String(styleIndex)}"`
  if (cell.kind === 'empty') return `<c r="${ref}"${style}/>`
  if (cell.kind === 'number') return `<c r="${ref}"${style}><v>${String(cell.value)}</v></c>`
  if (cell.kind === 'boolean') return `<c r="${ref}"${style} t="b"><v>${cell.value ? '1' : '0'}</v></c>`
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`
}

/**
 * Convert a zero-based column index to its A1 letters.
 *
 * @param {number} index - zero-based column.
 * @returns {string} column letters, e.g. 0 → `A`, 26 → `AA`.
 */
function columnName(index) {
  let n = index
  let name = ''
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  }
  return name
}

/** CRC32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

/**
 * CRC32 of a buffer, as ZIP requires.
 *
 * @param {Buffer} buffer - member content.
 * @returns {number} unsigned CRC32.
 */
function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/**
 * Encode a timestamp in the DOS date/time pair ZIP stores.
 *
 * @param {Date} date - the timestamp to encode.
 * @returns {{time: number, date: number}} the encoded pair.
 */
function dosStamp(date) {
  const time =
    (Math.floor(date.getSeconds() / 2) & 0x1f) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getHours() & 0x1f) << 11)
  const day =
    (date.getDate() & 0x1f) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    ((Math.max(date.getFullYear() - 1980, 0) & 0x7f) << 9)
  return { time, date: day }
}

/**
 * Build a ZIP archive from in-memory members.
 *
 * Deflate is used when it actually shrinks the member (these parts are XML, so
 * it always does); anything else is stored, which keeps the writer honest for
 * already-compressed payloads.
 *
 * @param {Array<{name: string, data: Buffer}>} members - archive entries.
 * @returns {Buffer} the archive bytes.
 */
function zip(members) {
  const stamp = dosStamp(new Date())
  const chunks = []
  const directory = []
  let offset = 0

  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8')
    const raw = member.data
    const deflated = deflateRawSync(raw, { level: 9 })
    const stored = deflated.length >= raw.length
    const body = stored ? raw : deflated
    const method = stored ? 0 : 8
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)

    chunks.push(local, name, body)
    directory.push(central, name)
    offset += local.length + name.length + body.length
  }

  const centralBuffer = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}

/** The workbook's styles: 0 = plain, 1 = header, 2 = wrapped body. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="\u7b49\u7ebf"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="\u7b49\u7ebf"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

/**
 * Render one worksheet part.
 *
 * @param {{columns: string[], rows: unknown[][], widths?: number[], freeze?: boolean, filter?: boolean}} sheet - normalized sheet.
 * @returns {string} the sheet XML.
 */
function renderSheet(sheet) {
  const columnCount = Math.max(sheet.columns.length, ...sheet.rows.map((row) => row.length), 1)
  const lastColumn = columnName(columnCount - 1)
  const lastRow = sheet.rows.length + 1
  const rows = []

  const headerCells = []
  for (let i = 0; i < columnCount; i += 1) {
    headerCells.push(renderCell(`${columnName(i)}1`, 1, sheet.columns[i] ?? ''))
  }
  rows.push(`<row r="1" spans="1:${String(columnCount)}">${headerCells.join('')}</row>`)

  for (let r = 0; r < sheet.rows.length; r += 1) {
    const row = sheet.rows[r] ?? []
    const cells = []
    for (let c = 0; c < columnCount; c += 1) {
      cells.push(renderCell(`${columnName(c)}${String(r + 2)}`, 2, row[c]))
    }
    rows.push(`<row r="${String(r + 2)}" spans="1:${String(columnCount)}">${cells.join('')}</row>`)
  }

  const cols = []
  for (let i = 0; i < columnCount; i += 1) {
    const width = sheet.widths?.[i] ?? Math.min(Math.max(12, (sheet.columns[i] ?? '').length * 2 + 4), 40)
    cols.push(`<col min="${String(i + 1)}" max="${String(i + 1)}" width="${String(width)}" customWidth="1"/>`)
  }

  const frozen = sheet.freeze === false ? '' : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
  const filter = sheet.filter === false || sheet.rows.length === 0 ? '' : `<autoFilter ref="A1:${lastColumn}${String(lastRow)}"/>`

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${String(lastRow)}"/><sheetViews><sheetView workbookViewId="0">${frozen}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols.join('')}</cols><sheetData>${rows.join('')}</sheetData>${filter}</worksheet>`
}

/**
 * Normalize the parsed input document into sheets.
 *
 * @param {unknown} document - parsed JSON.
 * @param {string} source - path shown in diagnostics.
 * @returns {Array<{name: string, columns: string[], rows: unknown[][], widths?: number[], freeze?: boolean, filter?: boolean}>} normalized sheets.
 */
function readSheets(document, source) {
  if (typeof document !== 'object' || document === null) throw new Error(`${source}: 顶层必须是对象`)
  const doc = document
  const raw = Array.isArray(doc.sheets) ? doc.sheets : [doc]
  if (raw.length === 0) throw new Error(`${source}: sheets 为空`)

  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`${source}: 第 ${String(index + 1)} 个 sheet 不是对象`)
    const sheet = entry
    if (!Array.isArray(sheet.columns) || sheet.columns.length === 0) {
      throw new Error(`${source}: 第 ${String(index + 1)} 个 sheet 缺少非空 columns`)
    }
    if (!Array.isArray(sheet.rows)) throw new Error(`${source}: 第 ${String(index + 1)} 个 sheet 缺少 rows 数组`)
    for (const [rowIndex, row] of sheet.rows.entries()) {
      if (!Array.isArray(row)) throw new Error(`${source}: 第 ${String(index + 1)} 个 sheet 第 ${String(rowIndex + 1)} 行不是数组`)
    }
    const rawName = typeof sheet.name === 'string' && sheet.name.trim().length > 0 ? sheet.name.trim() : `Sheet${String(index + 1)}`
    // Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 chars.
    const name = rawName.replace(/[:\\/?*[\]]/g, '_').slice(0, 31)
    if (name !== rawName) problems.push(`sheet 名「${rawName}」含非法字符或超长，已改为「${name}」`)
    return {
      name,
      columns: sheet.columns.map((column) => (typeof column === 'string' ? column : JSON.stringify(column))),
      rows: sheet.rows,
      widths: Array.isArray(sheet.widths) ? sheet.widths.map((width) => (typeof width === 'number' ? width : Number(width) || 12)) : undefined,
      freeze: sheet.freeze,
      filter: sheet.filter
    }
  })
}

/**
 * Escape one CSV field.
 *
 * @param {unknown} value - the cell value.
 * @returns {string} the quoted field when needed.
 */
function csvField(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const [inputPath, outputPath, ...flags] = process.argv.slice(2)
if (inputPath === undefined || outputPath === undefined) {
  console.error('用法: node cases2xlsx.mjs <input.json> <output.xlsx> [--csv]')
  process.exit(2)
}

const document = JSON.parse(readFileSync(inputPath, 'utf8'))
const sheets = readSheets(document, inputPath)

const parts = [
  {
    name: '[Content_Types].xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      'utf8'
    )
  },
  {
    name: '_rels/.rels',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'utf8'
    )
  },
  {
    name: 'xl/workbook.xml',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`)
        .join('')}</sheets></workbook>`,
      'utf8'
    )
  },
  {
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((sheet, index) => `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`)
        .join('')}<Relationship Id="rId${String(sheets.length + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'utf8'
    )
  },
  { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
  ...sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${String(index + 1)}.xml`,
    data: Buffer.from(renderSheet(sheet), 'utf8')
  }))
]

const workbook = zip(parts)
writeFileSync(outputPath, workbook)

if (flags.includes('--csv')) {
  const stem = join(dirname(outputPath), basename(outputPath, extname(outputPath)))
  for (const sheet of sheets) {
    const lines = [
      sheet.columns.map(csvField).join(','),
      ...sheet.rows.map((row) => sheet.columns.map((_, index) => csvField(row[index])).join(','))
    ]
    writeFileSync(`${stem}.${sheet.name}.csv`, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8')
  }
}

for (const sheet of sheets) {
  console.log(`  ${sheet.name}: ${String(sheet.rows.length)} 行 × ${String(sheet.columns.length)} 列`)
}
console.log(`已写出 ${outputPath}（${String(workbook.length)} 字节，${String(sheets.length)} 个 sheet）`)
if (problems.length > 0) {
  console.error(`警告 ${String(problems.length)} 条：`)
  for (const problem of [...new Set(problems)]) console.error(`  - ${problem}`)
}
