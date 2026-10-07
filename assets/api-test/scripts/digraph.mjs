/**
 * digraph — render a dependency / call-chain graph to a standalone SVG.
 *
 * Zero dependencies by design: no mermaid-cli, no Graphviz binaries, no Java.
 * A layered (topological) left-to-right layout is computed here and emitted as
 * plain SVG, which embeds in Markdown (`![](graph.svg)`) and prints into the PDF
 * through the same Chromium pipeline `md2pdf.mjs` uses.
 *
 * Usage:
 *   node digraph.mjs <spec.json> <output.svg>
 *
 * Spec format:
 * {
 *   "title": "SysUserController 依赖关系图",
 *   "layout": "vertical",        // "vertical" (default, fits a PDF page) | "horizontal"
 *   "nodes": [
 *     { "id": "C", "label": "SysUserController", "sub": "/api/users", "kind": "controller" }
 *   ],
 *   "edges": [
 *     { "from": "C", "to": "S", "label": "调用" }
 *   ]
 * }
 *
 * `kind` picks the fill colour: controller | service | mapper | entity | dto | other.
 * `layout: "horizontal"` matches a left-to-right call chain but gets very wide on
 * long chains; the default vertical flow keeps the diagram inside one printed page.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILL = {
  controller: '#dbeafe',
  service: '#dcfce7',
  mapper: '#fef3c7',
  entity: '#fae8ff',
  dto: '#e0e7ff',
  other: '#f3f4f6'
}
const STROKE = {
  controller: '#60a5fa',
  service: '#4ade80',
  mapper: '#fbbf24',
  entity: '#e879f9',
  dto: '#818cf8',
  other: '#9ca3af'
}

const escapeXml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Approximate text width: CJK glyphs are about twice as wide as latin ones. */
function textWidth(text, fontSize) {
  let units = 0
  for (const ch of String(text)) units += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
  return units * fontSize * 0.52
}

const [specPath, outPath] = process.argv.slice(2)
if (!specPath || !outPath) {
  console.error('usage: node digraph.mjs <spec.json> <output.svg>')
  process.exit(1)
}

// Strip a UTF-8 BOM: PowerShell's `Out-File -Encoding utf8` writes one, and
// JSON.parse rejects it. Callers should not have to care how the file was saved.
const specText = readFileSync(specPath, 'utf8').replace(/^\uFEFF/, '')
const spec = JSON.parse(specText)
const nodes = Array.isArray(spec.nodes) ? spec.nodes : []
const edges = (Array.isArray(spec.edges) ? spec.edges : []).filter(
  (e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to)
)
if (nodes.length === 0) {
  console.error('[digraph] spec has no nodes')
  process.exit(1)
}

// ---- layered layout -------------------------------------------------------
/**
 * Assign a layer to every node.
 *
 * Seeding only from zero-in-degree roots breaks on cyclic graphs: a real call
 * chain can contain a callback or a mutual reference, and then no node has
 * in-degree 0, nothing is ever enqueued, and every node collapses into layer 0.
 * This is Kahn's algorithm with cycle breaking — when the queue empties with
 * nodes still unplaced, the remaining node with the fewest unvisited incoming
 * edges becomes a root. Deterministic, and every node lands in a layer.
 */
function assignLayers(ids, links) {
  const remaining = new Map(ids.map((id) => [id, 0]))
  for (const e of links) if (remaining.has(e.to)) remaining.set(e.to, remaining.get(e.to) + 1)
  const outgoing = new Map(ids.map((id) => [id, []]))
  for (const e of links) if (outgoing.has(e.from)) outgoing.get(e.from).push(e.to)

  const assigned = new Map()
  const placed = new Set()
  let brokenCycles = 0

  while (placed.size < ids.length) {
    const front = ids.filter((id) => !placed.has(id) && remaining.get(id) === 0)
    if (front.length === 0) {
      const candidates = ids.filter((id) => !placed.has(id))
      let best = candidates[0]
      for (const id of candidates) if (remaining.get(id) < remaining.get(best)) best = id
      brokenCycles += 1
      front.push(best)
    }
    for (const id of front) {
      if (placed.has(id)) continue
      const base = assigned.get(id) ?? 0
      assigned.set(id, base)
      placed.add(id)
      for (const to of outgoing.get(id)) {
        if (placed.has(to)) continue
        assigned.set(to, Math.max(assigned.get(to) ?? 0, base + 1))
        remaining.set(to, Math.max(0, remaining.get(to) - 1))
      }
    }
  }
  return { layer: assigned, brokenCycles }
}

const { layer, brokenCycles } = assignLayers(
  nodes.map((n) => n.id),
  edges
)
if (brokenCycles > 0) {
  console.log(`[digraph] note: broke ${brokenCycles} dependency cycle(s) to keep the layout layered`)
}

// ---- geometry ------------------------------------------------------------
const FONT = 13
const SUB_FONT = 11
const PAD_X = 16
const PAD_Y = 12
const LINE_GAP = 6
const COL_GAP = 96
const ROW_GAP = 28

const sizes = new Map()
for (const n of nodes) {
  const width = Math.max(
    textWidth(n.label ?? n.id, FONT) + PAD_X * 2,
    n.sub ? textWidth(n.sub, SUB_FONT) + PAD_X * 2 : 0,
    132
  )
  const height = (n.sub ? FONT + LINE_GAP + SUB_FONT : FONT) + PAD_Y * 2
  sizes.set(n.id, { width: Math.round(width), height: Math.round(height) })
}

const columns = new Map()
for (const n of nodes) {
  const l = layer.get(n.id)
  if (!columns.has(l)) columns.set(l, [])
  columns.get(l).push(n.id)
}

const positions = new Map()
const titleOffset = spec.title ? 34 : 0
const orientation = spec.layout === 'horizontal' ? 'horizontal' : 'vertical'
const columnHeights = new Map()
for (const [l, ids] of columns) {
  columnHeights.set(
    l,
    ids.reduce((sum, id, index) => sum + sizes.get(id).height + (index > 0 ? ROW_GAP : 0), 0)
  )
}
const tallestColumn = Math.max(...columnHeights.values())

/** Vertical flow: layers stack top-to-bottom; long layers wrap into side columns. */
function layoutVertical() {
  const layerCount = Math.max(...columns.keys()) + 1
  const maxPerColumn = Math.max(
    ...Array.from({ length: layerCount }, (_, l) => (columns.get(l) ?? []).length)
  )
  const nodeWidth = Math.max(...[...sizes.values()].map((s) => s.width))
  const columnWidth = nodeWidth + 60
  const contentHeight = tallestColumn
  // Split layers into equally tall side-by-side columns.
  const groupCount = Math.max(1, Math.ceil(contentHeight / 820))
  const perGroup = Math.ceil(layerCount / groupCount)
  const groups = []
  for (let g = 0; g < groupCount; g += 1) {
    const layers = []
    for (let l = g * perGroup; l < Math.min((g + 1) * perGroup, layerCount); l += 1) layers.push(l)
    if (layers.length > 0) groups.push(layers)
  }
  if (groups.length === 0) groups.push([0])

  let groupX = 24
  for (const layers of groups) {
    const cell = sizes.get((columns.get(layers[0]) ?? [])[0]) ?? { width: nodeWidth }
    const colWidth = Math.max(
      ...[].concat(...layers.map((l) => (columns.get(l) ?? []).map((id) => sizes.get(id).width)))
    )
    let y = titleOffset + 24
    for (const l of layers) {
      const ids = columns.get(l) ?? []
      const rowHeight = columnHeights.get(l) ?? 0
      let x = groupX
      for (const id of ids) {
        const size = sizes.get(id)
        positions.set(id, { x, y, ...size })
        x += size.width + 28
      }
      y += Math.max(rowHeight, cell.height) + 46
    }
    groupX += colWidth + 34
  }
  void maxPerColumn
}

/** Horizontal flow: layers run left-to-right (the classic call-chain shape). */
function layoutHorizontal() {
  let cursorX = 24
  const maxLayer = Math.max(...columns.keys())
  for (let l = 0; l <= maxLayer; l += 1) {
    const ids = columns.get(l) ?? []
    const colWidth = Math.max(0, ...ids.map((id) => sizes.get(id).width))
    // Center shorter columns against the tallest one so the flow reads straight.
    let cursorY = titleOffset + 24 + Math.max(0, (tallestColumn - (columnHeights.get(l) ?? 0)) / 2)
    for (const id of ids) {
      const size = sizes.get(id)
      positions.set(id, { x: cursorX + (colWidth - size.width) / 2, y: cursorY, ...size })
      cursorY += size.height + ROW_GAP
    }
    cursorX += colWidth + COL_GAP
  }
}

if (orientation === 'horizontal') layoutHorizontal()
else layoutVertical()

// Derive the canvas from the actual node extents; a running cursor overshoots.
const rightEdge = Math.max(...[...positions.values()].map((p) => p.x + p.width))
const bottomEdge = Math.max(...[...positions.values()].map((p) => p.y + p.height))
const width = Math.max(320, Math.round(rightEdge + 24))
const height = Math.max(180, Math.round(bottomEdge + 24))

const parts = []
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`)
parts.push(
  '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280"/></marker></defs>'
)
parts.push(
  '<style>' +
    'text{font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;}' +
    '.node-label{font-size:13px;font-weight:600;fill:#111827;}' +
    '.node-sub{font-size:11px;fill:#4b5563;}' +
    '.edge-label{font-size:11px;fill:#4b5563;}' +
    '.title{font-size:15px;font-weight:700;fill:#111827;}' +
    '</style>'
)
parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`)
if (spec.title) {
  parts.push(`<text class="title" x="24" y="26">${escapeXml(spec.title)}</text>`)
}

for (const e of edges) {
  const a = positions.get(e.from)
  const b = positions.get(e.to)
  // `positions` already include the title offset; never add it again here.
  let path
  let labelX
  let labelY
  if (orientation === 'horizontal') {
    const x1 = a.x + a.width
    const y1 = a.y + a.height / 2
    const x2 = b.x
    const y2 = b.y + b.height / 2
    const mid = (x1 + x2) / 2
    path = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
    labelX = mid
    labelY = (y1 + y2) / 2
  } else {
    const x1 = a.x + a.width / 2
    const y1 = a.y + a.height
    const x2 = b.x + b.width / 2
    const y2 = b.y
    const mid = (y1 + y2) / 2
    path = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
    labelX = (x1 + x2) / 2
    labelY = mid
  }
  parts.push(
    `<path d="${path}" fill="none" stroke="#6b7280" stroke-width="1.4" marker-end="url(#arrow)"/>`
  )
  if (e.label) {
    const labelWidth = textWidth(e.label, 11)
    parts.push(
      `<rect x="${labelX - labelWidth / 2 - 4}" y="${labelY - 9}" width="${labelWidth + 8}" height="15" fill="#ffffff" opacity="0.92"/>` +
        `<text class="edge-label" x="${labelX}" y="${labelY + 2}" text-anchor="middle">${escapeXml(e.label)}</text>`
    )
  }
}

for (const n of nodes) {
  const p = positions.get(n.id)
  const y = p.y
  const kind = FILL[n.kind] ? n.kind : 'other'
  const labelY = n.sub ? y + PAD_Y + FONT - 2 : y + p.height / 2 + FONT / 3
  parts.push(
    `<rect x="${p.x}" y="${y}" width="${p.width}" height="${p.height}" rx="8" ` +
      `fill="${FILL[kind]}" stroke="${STROKE[kind]}" stroke-width="1.5"/>`
  )
  parts.push(
    `<text class="node-label" x="${p.x + p.width / 2}" y="${labelY}" text-anchor="middle">${escapeXml(n.label ?? n.id)}</text>`
  )
  if (n.sub) {
    parts.push(
      `<text class="node-sub" x="${p.x + p.width / 2}" y="${labelY + FONT / 2 + LINE_GAP + SUB_FONT - 2}" text-anchor="middle">${escapeXml(n.sub)}</text>`
    )
  }
}
parts.push('</svg>')

writeFileSync(outPath, parts.join('\n'), 'utf8')
console.log(`[digraph] ok  nodes=${nodes.length} edges=${edges.length}`)
console.log(`[digraph] svg=${outPath} (${width}x${height})`)
