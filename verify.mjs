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
if (warnings.length > 0) console.log(`activation warnings: ${warnings.join(' | ')}`)
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exitCode = failures.length === 0 ? 0 : 1
