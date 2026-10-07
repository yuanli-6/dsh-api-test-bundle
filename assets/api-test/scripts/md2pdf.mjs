/**
 * md2pdf — render a Chinese-friendly PDF from a Markdown report.
 *
 * Why this exists: the DSH runtime ships no PDF library (no reportlab/weasyprint
 * in Python, no puppeteer/md-to-pdf in Node), but a Chromium browser is almost
 * always installed. So: minimal Markdown -> HTML (self-contained, no network),
 * then Chrome/Edge `--headless --print-to-pdf`.
 *
 * Usage:
 *   node md2pdf.mjs <input.md> [output.pdf]
 *
 * Exits non-zero with a clear message when no Chromium browser can be found, so
 * the caller can report the limitation instead of silently producing nothing.
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge'
]

const escapeHtml = (text) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Inline markdown: code, bold, italic, links. Escapes HTML first. */
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

/** Minimal Markdown -> HTML. Handles the constructs a test report actually uses. */
function markdownToHtml(md, opts = {}) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  let wroteContent = false

  const renderTable = (rows) => {
    const cells = (row) =>
      row
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((c) => c.trim())
    const head = cells(rows[0])
    const body = rows.slice(2).map(cells)
    return [
      '<table>',
      '<thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead>',
      '<tbody>',
      ...body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'),
      '</tbody></table>'
    ].join('\n')
  }

  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }

    // A standalone image: SVG gets inlined, because Chromium's --print-to-pdf
    // does not fetch file:// images referenced from the page (the PDF would come
    // out with no image at all). Other formats keep the normal <img> path.
    const image = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line)
    if (image) {
      const [, alt, src] = image
      const isRemote = /^(?:https?:|data:)/i.test(src)
      const resolved = !isRemote && opts.baseDir ? resolve(opts.baseDir, src) : null
      if (resolved && /\.svg$/i.test(resolved) && existsSync(resolved)) {
        const svg = readFileSync(resolved, 'utf8')
          .replace(/<\?xml[^>]*\?>/i, '')
          .replace(/<!DOCTYPE[^>]*>/i, '')
        out.push(`<figure class="diagram">${svg}<figcaption>${inline(alt)}</figcaption></figure>`)
      } else {
        out.push(`<figure class="diagram"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"><figcaption>${inline(alt)}</figcaption></figure>`)
      }
      wroteContent = true
      i += 1
      continue
    }

    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim()
      const body = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      out.push(
        `<pre class="code${lang ? ` lang-${escapeHtml(lang)}` : ''}"><code>` +
          escapeHtml(body.join('\n')) +
          '</code></pre>'
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i += 1
      continue
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr>')
      i += 1
      continue
    }

    // Table: a header row followed by a separator row.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i])
        i += 1
      }
      out.push(renderTable(rows))
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${body.map(inline).join('<br>')}</blockquote>`)
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i += 1
      }
      out.push('<ul>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ul>')
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i += 1
      }
      out.push('<ol>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ol>')
      continue
    }

    const para = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      para.push(lines[i])
      i += 1
    }
    if (para.length > 0) {
      out.push(`<p>${inline(para.join(' '))}</p>`)
      wroteContent = true
    }
  }
  void wroteContent
  return out.join('\n')
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC",
               "Source Han Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0; padding: 0; color: #1f2328; font-size: 13px; line-height: 1.75;
}
h1 { font-size: 24px; border-bottom: 3px solid #1f2328; padding-bottom: 8px; margin: 0 0 16px; }
h2 { font-size: 19px; border-bottom: 1px solid #d0d7de; padding-bottom: 6px; margin: 26px 0 12px; break-after: avoid; }
h3 { font-size: 16px; margin: 20px 0 10px; break-after: avoid; }
h4 { font-size: 14px; margin: 16px 0 8px; color: #424a53; break-after: avoid; }
p { margin: 8px 0; }
table { border-collapse: collapse; width: 100%; margin: 10px 0 16px; break-inside: auto; }
th, td { border: 1px solid #c9d1d9; padding: 6px 9px; font-size: 12px; text-align: left; vertical-align: top; }
th { background: #f0f3f6; font-weight: 600; }
tr { break-inside: avoid; }
code { font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
       background: #f2f4f7; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
pre.code { background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 6px;
           padding: 10px 12px; overflow-wrap: anywhere; white-space: pre-wrap; break-inside: avoid; }
pre.code code { background: none; padding: 0; }
blockquote { margin: 10px 0; padding: 8px 14px; border-left: 4px solid #d0d7de;
             background: #f6f8fa; color: #424a53; }
ul, ol { margin: 8px 0 8px 22px; padding: 0; }
li { margin: 3px 0; }
hr { border: none; border-top: 1px solid #d8dee4; margin: 22px 0; }
a { color: #0969da; text-decoration: none; }
img { max-width: 100%; break-inside: avoid; }
figure.diagram { margin: 14px 0 18px; text-align: center; break-inside: avoid; }
figure.diagram svg { max-width: 100%; height: auto; }
figure.diagram img { max-width: 100%; }
figure.diagram figcaption { margin-top: 6px; font-size: 11px; color: #6b7280; }
`

function pickBrowser() {
  const fromEnv = process.env.DSH_PDF_BROWSER
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv
    console.error(`[md2pdf] DSH_PDF_BROWSER is set but does not exist: ${fromEnv}`)
    process.exit(2)
  }
  for (const candidate of BROWSERS) if (existsSync(candidate)) return candidate
  console.error(
    '[md2pdf] no Chromium-based browser found.\n' +
      '  Install Google Chrome or Microsoft Edge, or point DSH_PDF_BROWSER at its executable,\n' +
      '  e.g.  $env:DSH_PDF_BROWSER = "C:\\path\\to\\chrome.exe"'
  )
  process.exit(2)
}

const [input, outputArg] = process.argv.slice(2)
if (!input) {
  console.error('usage: node md2pdf.mjs <input.md> [output.pdf]')
  process.exit(1)
}
const inputPath = resolve(input)
if (!existsSync(inputPath)) {
  console.error(`[md2pdf] input not found: ${inputPath}`)
  process.exit(1)
}

const outputPath = resolve(outputArg ?? join(dirname(inputPath), `${basename(inputPath).replace(/\.md$/i, '')}.pdf`))
const cite = basename(inputPath, '.md')
// Strip a UTF-8 BOM: PowerShell's `Out-File -Encoding utf8` writes one, and it
// would otherwise leak into the first rendered line of the document.
const markdown = readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '')
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(cite)}</title>
<style>${CSS}</style></head>
<body>
${markdownToHtml(markdown, { baseDir: dirname(inputPath) })}
</body></html>
`

const work = mkdtempSync(join(tmpdir(), 'md2pdf-'))
const htmlPath = join(work, `${cite}.html`)
writeFileSync(htmlPath, html, 'utf8')

const browser = pickBrowser()
const result = spawnSync(
  browser,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    `--print-to-pdf=${outputPath}`,
    pathToFileURL(htmlPath).href
  ],
  { encoding: 'utf8', windowsHide: true, timeout: 120000 }
)

if (result.error) {
  console.error(`[md2pdf] failed to launch browser: ${result.error.message}`)
  process.exit(3)
}
if (!existsSync(outputPath)) {
  console.error(
    `[md2pdf] browser exited (code ${result.status ?? 'n/a'}) without writing the PDF.\n` +
      `  stderr: ${(result.stderr ?? '').trim().slice(0, 500)}`
  )
  process.exit(3)
}

const bytes = readFileSync(outputPath).length
console.log(`[md2pdf] ok  browser=${browser}`)
console.log(`[md2pdf] html=${htmlPath}`)
console.log(`[md2pdf] pdf=${outputPath} (${bytes} bytes)`)
