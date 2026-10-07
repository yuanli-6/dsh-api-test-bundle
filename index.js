/**
 * `api-test` skill bundle — a pure-skill DSH plugin.
 *
 * It registers no Tools and no Client half: `apply()` only calls
 * `ctx.skills.register()`, so the skill lands in the runtime layer of the
 * calling context (the global layer for a profile-mounted bundle) and is
 * removed again when the plugin is unloaded.
 *
 * `ctx.skills.register()` takes a complete runtime definition: the body is
 * carried as the `content` string, so it is read once during activation. The
 * Markdown file `assets/api-test/SKILL.md` stays the editable source of truth;
 * only the catalog metadata — name, description, whenToUse — is duplicated in
 * code so a damaged body can never stop the skill from being listed.
 *
 * @module dsh-api-test-bundle
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'api-test-bundle'

/** The only Service this plugin touches. */
export const inject = ['skills']

/** Skill name; must satisfy the harness kebab-case grammar. */
const SKILL_NAME = 'api-test'

/** Catalog description shown to the model and to the user. */
const SKILL_DESCRIPTION =
  '接口测试 Skill：覆盖 HTTP/RESTful、SOAP、RPC(Dubbo/gRPC)、消息队列(Kafka/RabbitMQ/SQS)、Spring Integration 与本地 @Service 方法的本地联调。用 ask_user_question 让用户选择测试范围、测试次数与是否导出关系图，每轮参数完全不同；按「定位接口定义 → 解析协议与缓存 → 生成测试数据 → 拼接实际端点 → 检查启动状态 → 分派发送并验证 → 统计报错」的固定工作流执行，最后产出含完整 API 说明的 Markdown/PDF 报告与关联关系图。'

/** Trigger phrases; decides when the harness advertises this skill. */
const SKILL_WHEN_TO_USE =
  '当用户说「要接口测试」「测一下这个接口」「验证接口行为」「检查接口返回」「这个接口报错了」「给我接口测试报告」，或要求对某个 Controller / RPC / MQ / SOAP 接口做本地联调验证、导出接口文档或关系图时使用。'

/** Absolute file URL of the skill body. */
const SKILL_FILE_URL = new URL('./assets/api-test/SKILL.md', import.meta.url)

/** Directory resource base, so relative references inside the skill resolve. */
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('./assets/', import.meta.url))
}

/** Body used when the Markdown asset cannot be read, so lookup still succeeds. */
const FALLBACK_CONTENT = [
  `# ${SKILL_NAME}`,
  '',
  `> 本技能的正文文件 assets/api-test/SKILL.md 未能读取（${SKILL_FILE_URL.pathname}）。`,
  '> 请检查 dsh-api-test-bundle 的安装是否完整（该文件必须随包一起安装），然后重新加载插件。',
  '',
  '在正文恢复之前，按以下要点执行：',
  '',
  '1. 先确认要测试哪个接口（方法名 / Controller 类名 / 路径 / Topic / RPC 接口名）。',
  '2. 在项目中定位接口定义，识别协议类型（HTTP / SOAP / RPC / MQ / Spring Integration / 本地方法）。',
  '3. 按参数类型构造测试数据，避免使用真实用户数据。',
  '4. 从 application.yml 等配置拼接实际端点。',
  '5. 先确认项目与中间件已启动；未启动就停止并提示，不反复重试。',
  '6. 发送请求并验证状态码、响应结构、边界值、幂等性、响应时间与异常场景。',
  '7. 报错时区分「接口本身报错」与「连接/基础设施报错」并统计。'
].join('\n')

/**
 * Read the primary key/value pairs of a leading `---` YAML frontmatter block.
 *
 * Intentionally minimal — scalar `key: value` lines only. It exists so the
 * skill body can carry the usual `name`/`description` frontmatter without
 * pulling a YAML parser (and therefore a dependency) into this bundle.
 *
 * @param {string} text - raw Markdown file content.
 * @returns {{ attributes: Record<string, string>, body: string }} parsed attributes (quotes stripped) and the body after the block.
 */
function parseSkillFile(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { attributes: {}, body: normalized }

  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { attributes: {}, body: normalized }

  const attributes = {}
  for (const line of normalized.slice(3, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value.length > 0) attributes[match[1]] = value
  }

  const bodyStart = normalized.indexOf('\n', end + 1)
  return {
    attributes,
    body: bodyStart === -1 ? '' : normalized.slice(bodyStart + 1).replace(/^\s+/, '')
  }
}

/**
 * Read the skill body from disk, with frontmatter stripped.
 *
 * @param {(message: string) => void} [warn] - sink for non-fatal packaging diagnostics.
 * @returns {string} the Markdown body, or a diagnostic fallback body when the asset is unusable.
 */
function readSkillBody(warn) {
  let raw
  try {
    raw = readFileSync(SKILL_FILE_URL, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warn?.(`api-test: cannot read ${SKILL_FILE_URL.pathname} (${reason}); serving fallback body`)
    return FALLBACK_CONTENT
  }

  const { attributes, body } = parseSkillFile(raw)
  const content = body.trim()
  if (content.length === 0) {
    warn?.(`api-test: ${SKILL_FILE_URL.pathname} has an empty body; serving fallback body`)
    return FALLBACK_CONTENT
  }
  if (attributes.name !== undefined && attributes.name !== SKILL_NAME) {
    warn?.(
      `api-test: SKILL.md declares frontmatter name "${attributes.name}" but this bundle ` +
        `registers it as "${SKILL_NAME}"; the registered name wins`
    )
  }
  return content
}

/**
 * Register the `api-test` skill on the calling context's skills layer.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context, relying on the injected `skills` Service.
 * @returns {void}
 */
export function apply(ctx) {
  const warn = (message) => ctx.logger?.warn?.(message)

  ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    resourceBase: RESOURCE_BASE,
    metadata: { bundle: 'dsh-api-test-bundle', body: 'assets/api-test/SKILL.md' },
    content: readSkillBody(warn)
  })
}
