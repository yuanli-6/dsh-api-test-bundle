/**
 * classmap — render a UML-style class diagram to a standalone SVG.
 *
 * Follows the notation mature tooling converged on (PlantUML class diagrams /
 * Mermaid `classDiagram`): one box per class with compartments, and arrows that
 * carry meaning instead of every edge looking the same.
 *
 *   ──▶  call/delegate       (a controller invoking a service)
 *   ──◆  composition          (a VO built from an entity)
 *   ──▷  inheritance          (a mapper extending BaseMapper)
 *   ┄┄▶  dependency           (a DTO passed into a method)
 *
 * Zero dependencies, same as digraph.mjs: the layout is computed here and the
 * output is plain SVG, so it embeds in Markdown and prints through md2pdf.mjs.
 *
 * Usage:
 *   node classmap.mjs <spec.json> <output.svg>
 *
 * Spec:
 * {
 *   "title": "SysUserController 类关系图",
 *   "columnsPerGroup": 1,
 *   "classes": [
 *     {
 *       "id": "SysUser", "name": "SysUser", "package": "com.example.user.entity",
 *       "stereotype": "entity", "color": "entity",
 *       "fields": [{ "name": "id", "type": "Long", "marker": "PK", "note": "@TableId(AUTO)" }],
 *       "methods": ["from(UserVO)", "selectByNicknameLike(keyword)"]
 *     }
 *   ],
 *   "relations": [
 *     { "from": "SysUserController", "to": "SysUserService", "type": "call", "label": "调用", "cardinality": "1 → *" }
 *   ]
 * }
 *
 * `type` is one of call | composition | inheritance | dependency.
 * `marker` is free text shown as a small badge (PK / FK / @Version / @TableLogic / 必填 …).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const COLORS = {
  controller: { fill: '#eff6ff', stroke: '#3b82f6', header: '#dbeafe' },
  service: { fill: '#f0fdf4', stroke: '#22c55e', header: '#dcfce7' },
  mapper: { fill: '#fffbeb', stroke: '#f59e0b', header: '#fef3c7' },
  entity: { fill: '#fdf4ff', stroke: '#d946ef', header: '#fae8ff' },
  dto: { fill: '#eef2ff', stroke: '#6366f1', header: '#e0e7ff' },
  other: { fill: '#f8fafc', stroke: '#94a3b8', header: '#f1f5f9' }
}
const MARKER_COLORS = {
  PK: '#b45309',
  FK: '#0369a1',
  '@Version': '#7c3aed',
  '@TableLogic': '#be123c'
}

const escapeXml = (t) =>
  String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** CJK glyphs occupy roughly two latin advances; used for box sizing. */
function textWidth(text, fontSize) {
  let units = 0
  for (const ch of String(text)) units += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return units * fontSize * 0.52
}

const FONT = 12
const FIELD_FONT = 11
const NOTE_FONT = 9.5
const HEADER_PAD = 8
const FIELD_LINE = 17
const METHOD_LINE = 16
const BOX_PAD_X = 12
const MIN_WIDTH = 210
const GROUP_GAP_X = 70
const ROW_GAP_Y = 42

const [specPath, outPath] = process.argv.slice(2)
if (!specPath || !outPath) {
  console.error('usage: node classmap.mjs <spec.json> <output.svg>')
  process.exit(1)
}

const spec = JSON.parse(readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''))
const rawClasses = Array.isArray(spec.classes) ? spec.classes : []
if (rawClasses.length === 0) {
  console.error('[classmap] spec has no classes')
  process.exit(1)
}

// A diagram with every field of every class stops fitting a page as the class
// count grows. Above this many classes the boxes keep their identity
// (name / stereotype / package) and drop the detail compartments, so the shape
// of the system stays readable. Force either mode explicitly with
// `"compact": true|false`.
const COMPACT_THRESHOLD = Number.isFinite(spec.compactThreshold) ? spec.compactThreshold : 24
const compact =
  typeof spec.compact === 'boolean' ? spec.compact : rawClasses.length > COMPACT_THRESHOLD
const classes = compact
  ? rawClasses.map((c) => ({ ...c, fields: [], methods: [] }))
  : rawClasses
if (compact) {
  console.log(
    `[classmap] compact mode: ${rawClasses.length} classes > ${COMPACT_THRESHOLD}, ` +
      `field/method compartments omitted (set "compact": false to keep them)`
  )
}
const byId = new Map(classes.map((c) => [c.id, c]))
const relations = (Array.isArray(spec.relations) ? spec.relations : []).filter(
  (r) => byId.has(r.from) && byId.has(r.to)
)

// ---- measure every compartment -------------------------------------------
const metrics = new Map()
for (const c of classes) {
  const fieldRows = (c.fields ?? []).map((f) => {
    const marker = f.marker ? `«${f.marker}» ` : ''
    const note = f.note ? `  ${f.note}` : ''
    return `${marker}${f.name}: ${f.type}${note}`
  })
  const methodRows = (c.methods ?? []).map((m) => String(m))
  const lines = [...fieldRows, ...methodRows]
  const widest = Math.max(
    textWidth(c.name, FONT + 1) + (c.stereotype ? textWidth(c.stereotype, NOTE_FONT) + 26 : 0),
    textWidth(c.package ?? '', NOTE_FONT),
    ...lines.map((l) => textWidth(l, FIELD_FONT) + (l.startsWith('«') ? 8 : 0)),
    MIN_WIDTH
  )
  metrics.set(c.id, {
    width: Math.round(widest + BOX_PAD_X * 2),
    headerHeight: 34 + (c.package ? 13 : 0),
    fieldsHeight: fieldRows.length > 0 ? fieldRows.length * FIELD_LINE + 12 : 0,
    methodsHeight: methodRows.length > 0 ? methodRows.length * METHOD_LINE + 12 : 0,
    fieldRows,
    methodRows
  })
}
for (const m of metrics.values()) m.height = m.headerHeight + m.fieldsHeight + m.methodsHeight

// ---- layered layout (same idea as digraph, boxes are much taller) ---------
/**
 * Assign a layer to every class.
 *
 * Seeding only from zero-in-degree roots is wrong for real code: any cycle
 * (bidirectional dependency, callback, mutually referencing DTOs) means no node
 * has in-degree 0, so nothing would ever be enqueued and every class would land
 * in layer 0. Instead this is Kahn's algorithm with cycle breaking — when the
 * queue empties but nodes remain, the remaining node with the fewest unvisited
 * incoming edges is promoted to a root. Deterministic, and every class lands in
 * a layer.
 */
function assignLayers(ids, edges) {
  const remaining = new Map(ids.map((id) => [id, 0]))
  for (const e of edges) if (remaining.has(e.to)) remaining.set(e.to, remaining.get(e.to) + 1)
  const outgoing = new Map(ids.map((id) => [id, []]))
  for (const e of edges) if (outgoing.has(e.from)) outgoing.get(e.from).push(e.to)

  const layer = new Map()
  const placed = new Set()
  let brokenCycles = 0

  while (placed.size < ids.length) {
    const front = ids.filter((id) => !placed.has(id) && remaining.get(id) === 0)
    if (front.length === 0) {
      // Every unplaced node is part of a cycle: promote the calmest one.
      const candidates = ids.filter((id) => !placed.has(id))
      let best = candidates[0]
      for (const id of candidates) if (remaining.get(id) < remaining.get(best)) best = id
      brokenCycles += 1
      front.push(best)
    }
    for (const id of front) {
      if (placed.has(id)) continue
      const base = layer.get(id) ?? 0
      layer.set(id, base)
      placed.add(id)
      for (const to of outgoing.get(id)) {
        if (placed.has(to)) continue
        layer.set(to, Math.max(layer.get(to) ?? 0, base + 1))
        remaining.set(to, Math.max(0, remaining.get(to) - 1))
      }
    }
  }
  return { layer, brokenCycles }
}

const { layer: depth, brokenCycles } = assignLayers(
  classes.map((c) => c.id),
  relations
)
if (brokenCycles > 0) {
  console.log(`[classmap] note: broke ${brokenCycles} dependency cycle(s) to keep the layout layered`)
}

const layers = new Map()
for (const c of classes) {
  const d = depth.get(c.id)
  if (!layers.has(d)) layers.set(d, [])
  layers.get(d).push(c.id)
}
const maxDepth = Math.max(...layers.keys())

const positions = new Map()
const titleOffset = spec.title ? 34 : 0
// Printable width budget. A report page fits ~740px at 1:1; the default allows
// up to roughly two of those so a dense diagram survives mild downscaling.
const maxWidth = Number.isFinite(spec.maxWidth) && spec.maxWidth > 200 ? spec.maxWidth : 1480
const ROW_GAP_IN_LAYER = 18
let cursorY = titleOffset + 24
const overWideRows = []

for (let d = 0; d <= maxDepth; d += 1) {
  const ids = layers.get(d) ?? []
  if (ids.length === 0) continue
  // Wrap a layer into as many rows as the width budget needs, instead of
  // running every class of the layer across one ever-widening line.
  let rowX = 24
  let rowY = cursorY
  let rowHeight = 0
  let rowCount = 1
  for (const id of ids) {
    const m = metrics.get(id)
    if (rowX > 24 && rowX + m.width > maxWidth) {
      rowY += rowHeight + ROW_GAP_IN_LAYER
      rowX = 24
      rowHeight = 0
      rowCount += 1
    }
    positions.set(id, { x: rowX, y: rowY, ...m })
    rowX += m.width + 26
    rowHeight = Math.max(rowHeight, m.height)
  }
  if (rowX > maxWidth + 1) overWideRows.push({ layer: d, width: Math.round(rowX) })
  cursorY = rowY + rowHeight + ROW_GAP_Y
}

const rightEdge = Math.max(...[...positions.values()].map((p) => p.x + p.width))
const bottomEdge = Math.max(...[...positions.values()].map((p) => p.y + p.height))
const width = Math.max(360, Math.round(rightEdge + 24))
const height = Math.max(200, Math.round(bottomEdge + 24))
if (overWideRows.length > 0) {
  const worst = overWideRows.reduce((a, b) => (a.width > b.width ? a : b))
  console.log(
    `[classmap] warning: ${overWideRows.length} row(s) exceed maxWidth=${maxWidth}px ` +
      `(layer ${worst.layer} is ${worst.width}px) because a single class box is that wide; ` +
      `raise maxWidth or split the diagram`
  )
}

// ---- emit -----------------------------------------------------------------
const parts = []
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`)
parts.push(`<defs>
  <marker id="cm-open" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto">
    <path d="M 1 1 L 11 6 L 1 11" fill="none" stroke="#475569" stroke-width="1.4"/>
  </marker>
  <marker id="cm-tri" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto">
    <path d="M 0.5 1 L 11.5 6 L 0.5 11 z" fill="#ffffff" stroke="#475569" stroke-width="1.4"/>
  </marker>
  <marker id="cm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
    <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/>
  </marker>
  <marker id="cm-diamond" viewBox="0 0 14 10" refX="1" refY="5" markerWidth="12" markerHeight="10" orient="auto">
    <path d="M 1 5 L 5 1 L 9 5 L 5 9 z" fill="#475569"/>
  </marker>
</defs>`)
parts.push(`<style>
  text{font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;}
  .title{font-size:15px;font-weight:700;fill:#0f172a;}
  .cls-name{font-size:13px;font-weight:700;fill:#0f172a;}
  .cls-stereo{font-size:9.5px;fill:#475569;}
  .cls-pkg{font-size:9.5px;fill:#64748b;}
  .field{font-size:11px;fill:#1e293b;}
  .method{font-size:11px;fill:#334155;}
  .rel-label{font-size:10.5px;fill:#475569;}
  .card{font-size:10px;fill:#0369a1;font-weight:600;}
  .badge{font-size:8.5px;font-weight:700;}
  .legend{font-size:10.5px;fill:#475569;}
</style>`)
parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`)
if (spec.title) parts.push(`<text class="title" x="24" y="26">${escapeXml(spec.title)}</text>`)

const anchor = (id, preferVertical) => {
  const p = positions.get(id)
  return preferVertical
    ? { x: p.x + p.width / 2, y: p.y + p.height, box: p }
    : { x: p.x + p.width, y: p.y + p.height / 2, box: p }
}

const STYLE = {
  call: { stroke: '#475569', dash: '', marker: 'cm-arrow', startMarker: '' },
  composition: { stroke: '#475569', dash: '', marker: 'cm-arrow', startMarker: 'cm-diamond' },
  inheritance: { stroke: '#475569', dash: '', marker: 'cm-tri', startMarker: '' },
  dependency: { stroke: '#64748b', dash: '6 4', marker: 'cm-open', startMarker: '' }
}

for (const r of relations) {
  const style = STYLE[r.type] ?? STYLE.call
  const a = positions.get(r.from)
  const b = positions.get(r.to)
  // Route vertically when the target sits below the source, which is the common
  // shape for a layered layout; otherwise go side to side.
  const vertical = b.y > a.y + a.height + 8
  let path
  let labelX
  let labelY
  if (vertical) {
    const x1 = a.x + a.width / 2
    const y1 = a.y + a.height
    const x2 = b.x + b.width / 2
    const y2 = b.y
    const mid = (y1 + y2) / 2
    path = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
    labelX = (x1 + x2) / 2
    labelY = mid
  } else {
    const x1 = a.x + a.width
    const y1 = a.y + a.height / 2
    const x2 = b.x
    const y2 = b.y + b.height / 2
    const mid = (x1 + x2) / 2
    path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
    labelX = mid
    labelY = (y1 + y2) / 2
  }
  const startAttr = style.startMarker ? ` marker-start="url(#${style.startMarker})"` : ''
  // A start marker (the composition diamond) sits at the path origin, which is
  // exactly on the source box border — and boxes are painted after edges, so the
  // border would hide it. Push the origin a few pixels out along the path.
  let drawPath = path
  if (style.startMarker) {
    const m = /^M ([\d.-]+) ([\d.-]+) C ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+)$/.exec(path)
    if (m) {
      const [x1, y1, , , , , x2, y2] = m.slice(1).map(Number)
      const len = Math.hypot(x2 - x1, y2 - y1) || 1
      const out = 12
      const sx = x1 + ((x2 - x1) / len) * out
      const sy = y1 + ((y2 - y1) / len) * out
      drawPath = `M ${sx} ${sy} C ${m[3]} ${m[4]}, ${m[5]} ${m[6]}, ${x2} ${y2}`
    }
  }
  parts.push(
    `<path d="${drawPath}" fill="none" stroke="${style.stroke}" stroke-width="1.4"` +
      (style.dash ? ` stroke-dasharray="${style.dash}"` : '') +
      ` marker-end="url(#${style.marker})"${startAttr}/>`
  )
  if (r.label) {
    // Cardinality is rendered inside the label box, so it must be measured too,
    // otherwise a long "label (1 → *)" overflows its own background.
    const text = r.cardinality ? `${r.label}  (${r.cardinality})` : r.label
    const lw = textWidth(text, 10.5)
    parts.push(
      `<rect x="${labelX - lw / 2 - 5}" y="${labelY - 9}" width="${lw + 10}" height="16" rx="3" fill="#ffffff" opacity="0.94"/>` +
        `<text class="rel-label" x="${labelX}" y="${labelY + 3}" text-anchor="middle">${escapeXml(text)}</text>`
    )
  }
}

for (const c of classes) {
  const p = positions.get(c.id)
  const palette = COLORS[c.color] ?? COLORS.other
  parts.push(
    `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="7" ` +
      `fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="1.6"/>`
  )
  // header compartment
  parts.push(
    `<path d="M ${p.x} ${p.y + p.headerHeight} H ${p.x + p.width}" stroke="${palette.stroke}" stroke-width="1.2"/>`
  )
  parts.push(
    `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.headerHeight}" rx="7" fill="${palette.header}" opacity="0.85"/>`
  )
  parts.push(
    `<path d="M ${p.x} ${p.y + p.headerHeight - 7} V ${p.y + 7} A 7 7 0 0 1 ${p.x + 7} ${p.y} H ${p.x + p.width - 7} A 7 7 0 0 1 ${p.x + p.width} ${p.y + 7} V ${p.y + p.headerHeight - 7} Z" fill="${palette.header}" opacity="0.85"/>`
  )
  const nameY = p.y + 17
  parts.push(`<text class="cls-name" x="${p.x + p.width / 2}" y="${nameY}" text-anchor="middle">${escapeXml(c.name)}</text>`)
  if (c.stereotype) {
    parts.push(
      `<text class="cls-stereo" x="${p.x + p.width / 2}" y="${nameY + 14}" text-anchor="middle">«${escapeXml(c.stereotype)}»</text>`
    )
  }
  if (c.package) {
    parts.push(
      `<text class="cls-pkg" x="${p.x + p.width / 2}" y="${p.y + p.headerHeight - 5}" text-anchor="middle">${escapeXml(c.package)}</text>`
    )
  }

  // field compartment
  let cursor = p.y + p.headerHeight
  if (p.fieldRows.length > 0) {
    parts.push(
      `<path d="M ${p.x} ${cursor + p.fieldsHeight} H ${p.x + p.width}" stroke="${palette.stroke}" stroke-width="1.2"/>`
    )
    p.fieldRows.forEach((row, i) => {
      const y = cursor + 16 + i * FIELD_LINE
      const marker = (c.fields[i].marker ?? '').trim()
      let textX = p.x + BOX_PAD_X
      if (marker) {
        const label = `«${marker}»`
        const bw = textWidth(label, 8.5) + 8
        const color = MARKER_COLORS[marker] ?? '#475569'
        parts.push(
          `<rect x="${textX}" y="${y - 9}" width="${bw}" height="12" rx="3" fill="${color}" opacity="0.14"/>` +
            `<text class="badge" x="${textX + bw / 2}" y="${y}" text-anchor="middle" fill="${color}">${escapeXml(label)}</text>`
        )
        textX += bw + 5
      }
      const fieldText = `${c.fields[i].name}: ${c.fields[i].type}`
      parts.push(`<text class="field" x="${textX}" y="${y}">${escapeXml(fieldText)}</text>`)
      if (c.fields[i].note) {
        const fw = textWidth(fieldText, FIELD_FONT)
        parts.push(
          `<text class="field" x="${textX + fw + 7}" y="${y}" fill="#94a3b8" font-size="9.5">${escapeXml(c.fields[i].note)}</text>`
        )
      }
    })
    cursor += p.fieldsHeight
  }
  // method compartment
  if (p.methodRows.length > 0) {
    p.methodRows.forEach((row, i) => {
      parts.push(
        `<text class="method" x="${p.x + BOX_PAD_X}" y="${cursor + 16 + i * METHOD_LINE}">${escapeXml(row)}</text>`
      )
    })
  }
}

// ---- legend ---------------------------------------------------------------
const legend = [
  ['call', '调用'],
  ['composition', '组合（由…构建）'],
  ['inheritance', '继承（extends）'],
  ['dependency', '依赖（作为参数）']
]
const legendY = height - 18
let legendX = 24
parts.push(`<text class="legend" x="${legendX}" y="${legendY}" font-weight="700">图例：</text>`)
legendX += textWidth('图例：', 10.5) + 8
for (const [type, text] of legend) {
  const style = STYLE[type]
  const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : ''
  parts.push(
    `<line x1="${legendX}" y1="${legendY - 4}" x2="${legendX + 30}" y2="${legendY - 4}" stroke="${style.stroke}" stroke-width="1.4"${dash} marker-end="url(#${style.marker})"/>`
  )
  legendX += 34
  const tw = textWidth(text, 10.5)
  parts.push(`<text class="legend" x="${legendX}" y="${legendY}">${escapeXml(text)}</text>`)
  legendX += tw + 22
}
parts.push('</svg>')

writeFileSync(outPath, parts.join('\n'), 'utf8')
console.log(`[classmap] ok  classes=${classes.length} relations=${relations.length}`)
console.log(`[classmap] svg=${outPath} (${width}x${height})`)
