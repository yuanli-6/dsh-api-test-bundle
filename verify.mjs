/**
 * Local pre-install check for dsh-api-test-bundle.
 * Mirrors @deepseek-ai/dsh-skill's validateRuntimeSkill()/validateDefinition()
 * rules and exercises apply() with a stub context. Run: node verify.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const failures = []
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label} -> ${error.message}`)
  }
}

// --- manifest -----------------------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const patchPath = pkg.dsh?.bundle?.patch
check('package.json declares dsh.bundle.patch', () => {
  assert.equal(typeof patchPath, 'string')
  assert.ok(patchPath.length > 0)
})
check('package is ESM (type: module)', () => assert.equal(pkg.type, 'module'))
check('exports "." resolves', () => assert.equal(pkg.exports['.'], './index.js'))

const patch = readFileSync(new URL(patchPath, import.meta.url), 'utf8')
check('patch inserts a row named after the package', () => {
  assert.match(patch, /insert:/)
  assert.match(patch, new RegExp(`name: '${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
})
check('patch row id matches the package name', () => {
  assert.match(patch, new RegExp(`id: ${pkg.name}\\b`))
})

// --- plugin module ------------------------------------------------------------
const mod = await import('./index.js')
check('exports apply()', () => assert.equal(typeof mod.apply, 'function'))
check('exports inject = ["skills"]', () => assert.deepEqual([...mod.inject], ['skills']))

let registered
const warnings = []
const ctx = {
  skills: {
    register(skill) {
      registered = skill
      return () => {}
    }
  },
  logger: { warn: (m) => warnings.push(m) }
}
check('apply() registers exactly one skill without throwing', () => {
  mod.apply(ctx)
  assert.ok(registered, 'nothing registered')
})

// --- registration payload (dsh-skill runtime rules) ---------------------------
check('skill name is valid kebab-case', () => assert.ok(SKILL_NAME_RE.test(registered.name)))
check('skill name is "api-test"', () => assert.equal(registered.name, 'api-test'))
check('description is a non-empty string', () => {
  assert.equal(typeof registered.description, 'string')
  assert.ok(registered.description.length > 0)
})
check('whenToUse is a string', () => assert.equal(typeof registered.whenToUse, 'string'))
check('invocation is a complete boolean policy', () => {
  assert.equal(typeof registered.invocation.modelInvocable, 'boolean')
  assert.equal(typeof registered.invocation.userInvocable, 'boolean')
})
check('source is a string', () => assert.equal(typeof registered.source, 'string'))
check('content is a non-empty string (required by skills.get)', () => {
  assert.equal(typeof registered.content, 'string')
  assert.ok(registered.content.length > 200, `body too short: ${registered.content.length}`)
})
check('content has frontmatter stripped', () => {
  assert.ok(!registered.content.startsWith('---'), 'frontmatter leaked into content')
  assert.ok(registered.content.startsWith('# '), 'body should start at the first heading')
})
check('resourceBase is a directory inside the package', () => {
  assert.equal(registered.resourceBase.kind, 'directory')
  assert.ok(registered.resourceBase.path.includes('assets'))
})
check('no unexpected stub keys', () => {
  const allowed = new Set([
    'name',
    'description',
    'whenToUse',
    'invocation',
    'source',
    'resourceBase',
    'metadata',
    'content',
    'path'
  ])
  const extra = Object.keys(registered).filter((k) => !allowed.has(k))
  assert.deepEqual(extra, [], `unknown keys: ${extra.join(', ')}`)
})

// --- required skill content ---------------------------------------------------
const body = registered.content
const required = [
  ['触发条件 接口测试', /要接口测试/],
  ['触发条件 验证接口行为', /验证接口行为/],
  ['第一步 确认测试目标', /确认测试目标/],
  ['第二步 解析接口信息（带缓存）', /解析接口信息（带缓存）/],
  ['@RestController', /@RestController/],
  ['@WebService', /@WebService/],
  ['@DubboService', /@DubboService/],
  ['@GrpcService', /@GrpcService/],
  ['@KafkaListener', /@KafkaListener/],
  ['@RabbitListener', /@RabbitListener/],
  ['@SqsListener', /@SqsListener/],
  ['@MessagingGateway', /@MessagingGateway/],
  ['@ServiceActivator', /@ServiceActivator/],
  ['普通 @Service 方法', /普通 `@Service` 方法/],
  ['缓存落盘位置章节存在', /缓存落盘位置（跨会话复用）/],
  ['第三步 生成测试数据', /生成测试数据/],
  ['第四步 获取实际端点', /获取实际端点/],
  ['读取 server.port', /server\.port/],
  ['context-path', /context-path/],
  ['第五步 检查项目启动状态', /检查项目启动状态/],
  ['第六步 发送请求并验证', /发送请求并验证/],
  ['第七步 统计报错', /统计报错/],
  ['区分接口报错/基础设施报错', /基础设施报错/],
  ['扩展选项 关联关系图', /关联关系图/],
  ['Mermaid', /Mermaid/],
  ['Controller → Service → Mapper', /Controller → Service → Mapper/],
  ['状态码验证', /状态码验证/],
  ['响应结构验证', /响应结构验证/],
  ['边界值测试', /边界值测试/],
  ['幂等性验证', /幂等性验证/],
  ['响应时间记录', /响应时间记录/],
  ['异常场景', /异常场景/],
  ['不写单元测试', /不写单元测试/],
  ['不反复重试', /不反复重试/],
  ['避免使用真实用户数据', /避免使用真实用户数据/],
  ['提示用户提供 Token', /Token/]
]
for (const [label, re] of required) {
  check(`content covers: ${label}`, () => assert.match(body, re))
}

console.log('')
console.log('--- cache contract (assets/api-test/SKILL.md) ---')
const cacheSource = readFileSync('assets/api-test/SKILL.md', 'utf8')
const cacheRequired = [
  ['缓存路径为项目根 .dsh-meow/api-test/cache.json', /<项目根>\/\.dsh-meow\/api-test\/cache\.json/],
  ['缓存文件含 version 字段', /"version":\s*1/],
  ['缓存条目含 sourceFiles 新鲜度字段', /"sourceFiles"/],
  ['sourceFiles 记录 hash', /"hash"/],
  ['sourceFiles 记录 mtime', /"mtime"/],
  ['缓存条目含 endpoint', /"endpoint"/],
  ['缓存条目含 lastVerifiedAt', /"lastVerifiedAt"/],
  ['缓存条目含 lastResult', /"lastResult"/],
  ['读规则：命中则复用不重新解析', /直接复用，不要重新解析源码/],
  ['读规则：变过则重新解析并回写', /重新解析该接口，解析完回写这一条/],
  ['写规则：解析成功后立刻写', /解析成功后立刻写/],
  ['写规则：不覆盖其他条目', /不要覆盖其他条目/],
  ['写规则：写坏一个字符会让整份缓存失效', /写坏一个字符会让整份缓存失效/],
  ['项目根不可确认时先问用户', /先问用户项目根在哪/],
  ['缓存损坏时忽略残缺项', /忽略残缺项并重新解析/],
  ['缓存只是加速手段，未命中也能工作', /没命中缓存也能正常工作/],
  ['汇报时说明命中缓存还是重新解析', /命中缓存」还是「重新解析/]
]
for (const [label, re] of cacheRequired) {
  check(label, () => assert.match(cacheSource, re))
}

console.log('')
console.log('--- interactive flow + report contract (assets/api-test/SKILL.md) ---')
const flowSource = readFileSync('assets/api-test/SKILL.md', 'utf8')
const flowRequired = [
  ['交互流程一节存在', /## 交互流程/],
  ['要求用 ask_user_question 提问', /ask_user_question/],
  ['说明该工具没有数字输入框', /没有数字输入框/],
  ['选择 1 测试范围', /选择 1：测试范围/],
  ['范围选项合并了出图选择', /整个 Controller 的所有接口 \+ 纵向关系图/],
  ['支持多选接口', /multi_select: true/],
  ['能选整个 Controller', /整个 Controller 的所有接口/],
  ['选择 3 只确认图形态', /这里只确认\*\*图的形态\*\*|只确认\*\*图的形态\*\*/],
  ['用户说不要图就不出图', /不要出图/],
  ['选择 2 测试次数', /选择 2：测试次数/],
  ['给出 1/3/5/10 轮选项', /3 轮（推荐）/],
  ['要求每轮参数完全不同', /每一轮的所有参数必须完全不同/],
  ['参数生成含随机串规则', /6 位随机/],
  ['要求生成后自检不重复', /必须自检/],
  ['手机号生成规则', /8 位随机数字/],
  ['选择 3 关联关系图', /选择 3：是否导出关联关系图/],
  ['关系图链路定义', /Controller → Service → Mapper → Entity → DTO/],
  ['图形态可选纵向/横向', /纵向拓扑图/],
  ['选择 4 导出格式', /选择 4：导出格式/],
  ['报告与产物一节', /## 报告与产物/],
  ['产物放项目根 docs/ 目录', /项目根的 `docs\/` 目录/],
  ['产物含 md/PDF/json/svg', /api-test-result\.json/],
  ['报告含接口清单总表', /接口清单总表/],
  ['报告含逐接口详情', /逐接口详情/],
  ['详情含 Java 方法签名与源码行号', /Java 方法签名/],
  ['详情含直连与经网关地址', /经网关地址/],
  ['详情含参数位置/类型/必填/约束', /位置\(query\|path\|body\)/],
  ['详情含成功示例报文', /成功示例报文/],
  ['详情含异常与边界', /异常与边界/],
  ['参数变化记录一节', /参数变化记录/],
  ['md2pdf 脚本用法', /scripts\/md2pdf\.mjs/],
  ['digraph 脚本用法', /scripts\/digraph\.mjs/],
  ['classmap 脚本用法', /scripts\/classmap\.mjs/],
  ['classmap 输入格式示例', /"marker": "PK"/],
  ['关系类型语义表', /实心菱形 \+ 箭头/],
  ['要求标注基数', /每条关系标注基数/],
  ['关系图四子节要求', /调用链路图/],
  ['Mermaid classDiagram 源码要求', /Mermaid `classDiagram` 源码/],
  ['禁止画不存在的线', /不要画不存在的线/],
  ['扩展章节不再写 Mermaid 格式', /是否出图在\*\*交互流程\*\*/],
  ['交付前自检一节存在', /### 交付前自检/],
  ['自检：图未进 PDF 的坑', /不会加载页面引用的本地 `file:\/\/` 图片/],
  ['自检：不能用 Image 资源判断', /不要用 PDF 里有没有 `\/Subtype \/Image` 判断/],
  ['自检：禁止占位内容进图', /图里不能有"示意 \/ 占位"内容|图里不能有/],
  ['自检：失败要如实说', /不要伪造产物/],
  ['图宽限制 740px', /740px 以内/],
  ['说明类多时自动紧凑模式', /类数超过 24 个会自动进入紧凑模式/],
  ['说明可强制 compact 与阈值', /"compactThreshold": N/],
  ['说明环是正常且会自动打破', /图里有环是正常的/],
  ['说明 maxWidth 可调', /"maxWidth"` 调整/],
  ['digraph 输入格式示例', /"layout": "vertical"/],
  ['纵向为默认布局', /默认 `vertical`/],
  ['SVG 嵌入 Markdown 的写法', /!\[\]\(api-test-graph\.svg\)/],
  ['能力边界表存在', /能力边界（做不到就如实说，不要假装成功）/],
  ['PDF 可用 DSH_PDF_BROWSER 指定', /DSH_PDF_BROWSER/],
  ['缺 PDF 能力时如实告知', /不要伪造 PDF/],
  ['要求验证 PDF 文件头', /%PDF-/]
]
for (const [label, re] of flowRequired) {
  check(label, () => assert.match(flowSource, re))
}

console.log('')
console.log('--- bundled helper scripts present ---')
for (const rel of [
  'assets/api-test/scripts/md2pdf.mjs',
  'assets/api-test/scripts/digraph.mjs',
  'assets/api-test/scripts/classmap.mjs'
]) {
  check(`${rel} 存在且非空`, () => assert.ok(readFileSync(rel, 'utf8').length > 500))
}

console.log('')
if (warnings.length > 0) console.log(`activation warnings: ${warnings.join(' | ')}`)
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exitCode = failures.length === 0 ? 0 : 1
