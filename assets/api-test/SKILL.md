---
name: api-test
description: 对项目中的接口做本地接口测试：识别协议类型、定位接口定义、生成测试数据、拼接实际端点、发送请求并验证结果，最后统计报错。
---

# 接口测试（api-test）

本地测试直接调用实际接口，**不写单元测试**。

## 触发条件

当用户说「要接口测试」「测一下这个接口」「验证接口行为」「检查接口返回」「这个接口报错了」时启用本技能。

## 交互流程（每次测试都要走）

用 `ask_user_question` 依次确认下面的选择，**不要自己替用户决定**。
该工具只支持选项（单选 / 多选），**没有数字输入框**——凡是需要数字的地方，
都要用选项给出建议值，并允许用户自己填写其它数值。

### 选择 1：测试范围

先问用户要测哪一层，再给具体清单：

- 某个 Controller 的**单个或多个接口**：列出该 Controller 下所有接口名让用户多选（`multi_select: true`）
- **整个 Controller 的所有接口**
- **多个 Controller**（项目里存在多个时才给）
- **全部接口**

项目里 Controller 超过一个时，先问"测哪个 Controller / 全部"，再问具体接口。

### 选择 2：测试次数

问每个接口跑几轮，建议选项：`1 轮（快速冒烟）` / `3 轮（推荐）` / `5 轮` / `10 轮`，
并说明用户可自行填写任意次数。

**每一轮的所有参数必须完全不同**——不是改一个值就算，要整体换一套。生成规则：

- 字符串：`<语义前缀>_<轮次>_<6 位随机>`，如 `apitest_r2_9f3a1c`
- 昵称：中文形容词 + 名词 + 轮次序号，如 `接口测试三号`
- 邮箱：`<该轮 username>@example.com`
- 手机号：`139` + 8 位随机数字（满足 `^1[3-9]\d{9}$`）
- 分页：`current` / `size` 每轮取不同组合
- 数值：在合法区间内取不同值

生成后**必须自检**：把所有轮次的参数摆在一起比对，确认没有任意两轮完全相同。
接口带唯一约束（如 username 唯一）时尤其要保证轮次之间不撞。

### 选择 3：是否导出关联关系图

问用户是否需要 `Controller → Service → Mapper → Entity → DTO` 的关联关系图。
需要时再问图的形态：**纵向拓扑图**（默认，适合放进文档）/ 横向调用链。

### 选择 4：导出格式

最后问要哪些产物：`Markdown` / `Markdown + PDF` / `再加接口类与字段关系明细`。

PDF 与关系图的生成能力、以及能力不足时怎么如实告知，见《报告与产物》一节。

## 工作流程

### 第一步：确认测试目标

先询问用户要测试哪个接口。用户可能提供：

- 方法名
- Controller 类名
- 接口路径
- 消息 Topic
- RPC 接口名

目标不明确就不要猜，问清楚再往下走。

### 第二步：解析接口信息（带缓存）

在项目中定位接口定义，并按注解 / 基类识别协议类型：

| 特征 | 协议类型 |
| --- | --- |
| `@RestController` / `@Controller` | HTTP 类（RESTful、表单） |
| `@WebService` / `@WebMethod` | SOAP |
| `@DubboService` / `@GrpcService` | RPC |
| `@KafkaListener` / `@RabbitListener` / `@SqsListener` | 消息队列 |
| `@MessagingGateway` / `@ServiceActivator` | Spring Integration |
| 普通 `@Service` 方法 | 本地方法调用 |

解析时记录：接口全限定名、HTTP 方法与路径、参数列表与类型、返回值类型、关键注解、所在文件路径。

#### 缓存落盘位置（跨会话复用）

解析结果写到**项目根目录**：

```
<项目根>/.dsh-meow/api-test/cache.json
```

- 用项目根目录，不用当前工作目录：这样你用 dsh 打开项目的任意子目录，命中的都是同一份缓存。
- 项目里没有 `.dsh-meow/` 目录就用 Write 工具创建，不要因为目录不存在而放弃缓存。
- 该目录已被 meow-memory 全局忽略，不要额外动项目的 `.gitignore`。

缓存文件结构：

```json
{
  "version": 1,
  "updatedAt": "2026-10-06T00:00:00.000Z",
  "entries": {
    "<接口全限定名>#<方法名>": {
      "protocol": "http",
      "method": "POST",
      "path": "/api/user/create",
      "params": [{ "name": "req", "type": "UserCreateReq" }],
      "returns": "Result<UserVO>",
      "annotations": ["@RestController", "@PostMapping"],
      "sourceFiles": [{ "file": "src/main/java/.../UserController.java", "hash": "<sha1 或 sha256 前 16 位>", "mtime": 1760000000000 }],
      "endpoint": "http://127.0.0.1:8080/api/user/create",
      "testData": "{...}",
      "lastVerifiedAt": "2026-10-06T00:00:00.000Z",
      "lastResult": "pass"
    }
  }
}
```

`version` 是本缓存的格式版本；发现结构对不上时不要猜，直接按最新格式重建。

**复用规则（读）**

1. 先读 `<项目根>/.dsh-meow/api-test/cache.json`，按 `<接口全限定名>#<方法名>` 取条目。
2. 逐条核对 `sourceFiles` 里的 `mtime` / `hash`：
   - 全部未变 → **直接复用，不要重新解析源码**。
   - 任一变过 → 重新解析该接口，解析完回写这一条，其余条目不要动。
3. 以下情况一律重新解析，并说明原因：用户明说接口有变更、`version` 不是当前格式版本、缓存条目缺少 `sourceFiles`（无法判断新鲜度）。
4. `endpoint` 优先复用，但**正式发请求前**必须再核对一次 `application.yml` 的 `server.port` / `context-path`，端口可能被改过。

**写入规则（写）**

- **解析成功后立刻写**，不要等测试跑完——源码解析是最贵的一步。
- 每次只更新命中的那一条：先读整个文件，替换 `entries` 里对应的键，再写回，**不要覆盖其他条目**。
- 测试成功后回填 `endpoint` / `testData` / `lastVerifiedAt` / `lastResult`。
- 写 JSON 前确认语法合法，写坏一个字符会让整份缓存失效。

**其他约定**

- 项目根探测不到 `.dsh-meow/` 或项目根本身无法确认时，先问用户项目根在哪，**不要**把缓存写进 dsh 工作区的临时目录。
- 缓存文件损坏或条目残缺时，忽略残缺项并重新解析，不要把坏内容当成事实。
- `sourceFiles` 记录相对项目根的路径，方便整份缓存迁移。
- 这是本地测试，不需要写单元测试。

### 第三步：生成测试数据

根据参数类型自动构造测试数据：

- 消息类接口 → 构造消息 Payload
- RPC 接口 → 构造请求对象
- HTTP 接口 → 构造请求体 / 表单 / Query 参数

构造原则：类型正确、边界可预期、字段名与 DTO 定义一致。**避免使用真实用户数据**，用明显是测试数据的值。

### 第四步：获取实际端点

根据项目信息拼接实际测试路径：

- **HTTP / SOAP**：从 `application.yml` / `application-*.yml` 读取 `server.port` 与 `context-path`，拼接完整 URL
- **消息队列**：读取 Topic / Queue 名称与 broker 地址
- **RPC**：读取注册中心地址与服务名
- **本地方法**：通过 Spring 容器获取 Bean

配置缺失时先去找实际生效的 profile 配置，不要默认套用 `8080`。

### 第五步：检查项目启动状态

先确认项目是否已经启动好。

**如果项目没启动好，停止并提示用户启动项目或相关中间件，不要反复重试。**

判断维度：应用端口是否在监听、健康检查 / 探活端点是否响应、依赖的 broker 与注册中心是否可达。

### 第六步：发送请求并验证

按协议类型分派到对应的触发方式，然后验证结果：

- HTTP / SOAP → 发请求
- 消息队列 → 向 Topic / Queue 投递消息
- RPC → 调用对应服务
- 本地方法 → 通过 Spring 容器调用 Bean

验证内容见下方《通用测试规范》。

### 第七步：统计报错

如果报错，把报错信息整理统计出来，并明确区分两类：

- **接口本身报错**：业务异常、参数校验失败、状态码 4xx/5xx、服务端堆栈
- **连接 / 基础设施报错**：端口未监听、连接被拒、超时、认证失败、broker 不可达

两类混在一起会让用户误判根因，必须分开列出。

## 扩展选项：关联关系图

在确认测试目标之后，额外增加一个选项，询问用户是否查看这个接口的关联类、关联字段的关联关系图。

如果用户选择查看，则解析接口涉及的调用链（Controller → Service → Mapper → Entity → DTO），生成一份 **Mermaid 格式**的关系图给用户。

要求：

- 同时给出关系图与关联字段说明
- 节点用实际类名 / 方法名标注，边标注调用关系
- 只画与当前接口相关的链路，不要把整个工程画进去

## 通用测试规范

1. **状态码验证**：按协议语义验证返回状态码，覆盖成功、客户端错误、服务端错误。
2. **响应结构验证**：必填字段存在、类型正确、嵌套结构符合定义。
3. **边界值测试**：最小值、最大值、空值、超长值、特殊字符。
4. **幂等性验证**：重复调用同一请求，确认结果符合接口预期（可重复执行或明确拒绝重复）。
5. **响应时间记录**：记录每次调用的耗时，标出明显偏慢的接口。
6. **异常场景**：参数缺失、权限不足等场景要有明确返回，而不是 500 或静默失败。

## 注意事项

- 本地测试直接调用实际接口，**不写单元测试**。
- 项目未启动时直接提示用户，**不反复重试**。
- 测试数据避免使用真实用户数据。
- 接口需要认证时，提示用户提供 Token。
- 汇报结果时区分「接口本身报错」与「连接 / 基础设施报错」，并说明本次验证覆盖了什么、没覆盖什么。
- 缓存只是加速手段：**没命中缓存也能正常工作**，不要为了省一次解析而瞎猜接口定义。
- 复用缓存前必须核对 `sourceFiles` 的新鲜度；用户说接口改过就无条件重新解析。
- 缓存写在项目根的 `.dsh-meow/api-test/cache.json`，汇报时顺带说明本次是「命中缓存」还是「重新解析」，方便用户判断结果可信度。

## 报告与产物

产物统一放在**项目根的 `docs/` 目录**（不要写进插件包或临时目录）：

```
docs/
├── api-test-report.md        # 完整测试报告（Markdown，主产物）
├── api-test-report.pdf       # 由 md 渲染的 PDF（用户要 PDF 时）
├── api-test-result.json      # 结构化结果，报告由它生成，便于复算与对比
└── api-test-graph.svg        # 关系图（用户要图时）
```

### 报告必须包含的内容

**不允许省略任何一节**，尤其接口清单与逐接口详情——用户要的是完整 API 说明：

1. **测试概览**：时间、被测工程、技术栈、测试范围、总用例数 / 通过 / 失败、总耗时
2. **运行环境**：各组件地址端口、健康检查结果、启动方式、端点拼接过程（`server.port` + `context-path` 或 broker 地址）
3. **接口清单总表**：序号 | 接口名称 | 方法 | 路径 | 说明 | 用例数 | 通过率
4. **逐接口详情**（**每个接口一节，必须包含**）：
   - 基本信息：接口名称、Controller 全限定类名、Java 方法签名、协议类型、源码文件相对路径与行号
   - 完整 API：**直连地址**与**经网关地址**（有网关时）、HTTP 方法、Content-Type、是否需要认证
   - 请求参数：逐个列出名称 / 位置(query|path|body) / 类型 / 是否必填 / 约束（长度、正则、取值范围）/ 说明
   - 返回结果：统一响应结构、data 字段的字段名 / 类型 / 说明、成功示例报文
   - 测试用例表：序号 | 参数组合（完整值）| 预期 | 实际 HTTP + 业务码 | 耗时 | 结论
   - 异常与边界：非法输入的实际返回
5. **参数变化记录**：每种接口列出每轮参数，并明确标注**各轮参数互不相同**
6. **报错统计**：按「接口本身报错」与「连接 / 基础设施报错」分类汇总
7. **关联关系图**（用户需要时）：按下面四个子节给全，不要只丢一张图
   - **调用链路图**：按请求流向分层（网关 → Controller → Service → Mapper → Entity → DTO）
   - **UML 类关系图**：每个类分「类名 / 字段 / 方法」三栏，字段带类型与 `«PK»` `«@Version»` `«@TableLogic»` 等标记
   - **Mermaid `classDiagram` 源码**：便于用户编辑、或在 GitHub 等支持 Mermaid 的地方直接渲染
   - **关联字段说明表**：逐类列出关键字段与关联语义
8. **未覆盖部分**：明确说明哪些没测（并发、鉴权、边界外场景等）

### 关系图的记法（参考成熟工具）

按 PlantUML 类图 / Mermaid `classDiagram` 的约定，**关系用不同箭头区分语义**，不要所有边都画成一个样：

| 记法 | 语义 | 用在本例 |
| --- | --- | --- |
| 实线 + 实心箭头 | 调用 / 委托 | Controller → Service、Service → Mapper |
| 实心菱形 + 箭头 | 组合（由…构建） | Mapper → Entity、Entity → VO、VO → PageResult |
| 空心三角 | 继承（extends） | Mapper extends `BaseMapper<SysUser>` |
| 虚线 + 空心箭头 | 依赖（作为参数） | Controller ⇢ UserCreateRequest / UserUpdateRequest |

另外要做到：
- **每条关系标注基数**（如 `1 → *`、`1 → 0..1`），并配图例说明箭头含义
- **字段必须来自真实源码**，类型、约束、`@Version` / `@TableLogic` 这类关键注解都要标出来，不要凭印象杜撰
- **不要画不存在的线**：没有继承关系就不要画继承箭头；关系方向要核对（谁依赖谁、谁由谁构建）
- 图宽控制在 **740px 以内**能放进一页 A4；类多时用更大的画布并接受整体缩放

### 用脚本生成 PDF 与关系图

本技能自带三个零依赖脚本（`assets/api-test/scripts/`，路径由技能的 `Base directory` 决定）：

```powershell
# Markdown -> PDF（内部用 Chrome/Edge headless 打印，中文字体已适配）
node "<base>/scripts/md2pdf.mjs" <报告.md> [输出.pdf]

# 调用链路图 -> SVG（自算分层布局，无需 Graphviz / Java / mermaid）
node "<base>/scripts/digraph.mjs" <图描述.json> <输出.svg>

# UML 类关系图 -> SVG（类框分栏显示字段与方法，关系带箭头语义与基数）
node "<base>/scripts/classmap.mjs" <类图描述.json> <输出.svg>
```

`classmap.mjs` 的输入格式：

```json
{
  "title": "SysUserController UML 类关系图",
  "classes": [
    {
      "id": "SysUser", "name": "SysUser", "package": "com.example.user.entity",
      "stereotype": "TableName(sys_user)", "color": "entity",
      "fields": [{ "name": "id", "type": "Long", "marker": "PK", "note": "IdType.AUTO" }],
      "methods": ["static from(SysUser): UserVO"]
    }
  ],
  "relations": [
    { "from": "SysUserMapper", "to": "SysUser", "type": "composition", "label": "映射结果", "cardinality": "1 → *" }
  ]
}
```

`color` 取 `controller` / `service` / `mapper` / `entity` / `dto` / `other`；
`relations[].type` 取 `call`（实线箭头）/ `composition`（实心菱形）/ `inheritance`（空心三角）/ `dependency`（虚线箭头）；
`fields[].marker` 是自由文本徽标（`PK` `@Version` `@TableLogic` `必填` 等），脚本会自动配色。

`digraph.mjs` 的输入格式：

```json
{
  "title": "SysUserController 关联关系图",
  "layout": "vertical",
  "nodes": [{ "id": "C", "label": "SysUserController", "sub": "/api/users", "kind": "controller" }],
  "edges": [{ "from": "C", "to": "S", "label": "调用" }]
}
```

`kind` 取 `controller` / `service` / `mapper` / `entity` / `dto` / `other`，决定配色。
`layout` 默认 `vertical`（适合放进 PDF 一页）；链路很长且用户要"横向调用链"时用 `horizontal`。
生成的 SVG 用 `![](api-test-graph.svg)` 引用进 Markdown，再交给 `md2pdf.mjs` 就会一起打进 PDF。

### 能力边界（做不到就如实说，不要假装成功）

| 能力 | 现状 | 缺什么时的做法 |
| --- | --- | --- |
| Markdown | 内置支持 | — |
| PDF | **靠本机 Chromium 内核**（Chrome 或 Edge）。脚本会自动探测常见路径，也可用环境变量 `DSH_PDF_BROWSER` 指定 | 两者都没有时**明确告知用户**："本机没有 Chrome/Edge，无法生成 PDF，请安装其一或改用 Markdown"，不要伪造 PDF |
| 关系图 | **自带两个 SVG 生成器**：`digraph.mjs` 画调用链路、`classmap.mjs` 画 UML 类图（字段/方法/关系语义），无需任何外部依赖 | 想要 Mermaid 源码就另存一份 `.mmd`（报告里也会贴出源码块，GitHub 等能直接渲染） |
| Graphviz / Java 渲染 | 不依赖 | 不要假设本机有 `dot` / `plantuml`；需要时先探测再决定 |

**验证产物真的生成了**：检查文件存在且非空（PDF 还要确认文件头是 `%PDF-`），
再把路径报给用户。生成失败要给出具体原因，不要只说"已完成"。
