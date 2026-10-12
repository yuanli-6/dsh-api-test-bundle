# dsh-api-test-bundle

一个**纯技能（Skill）DSH bundle**：不注册任何工具、没有 Client 半边，只通过
`ctx.skills.register()` 把 `api-test` 接口测试技能注册进 DSH 的技能系统。

## 包结构

```
dsh-api-test-bundle/
├── package.json                     # 声明 dsh.bundle.patch
├── cordis.patch.yml                 # insert 一行插件条目
├── index.js                         # 读取 SKILL.md 并注册技能
├── assets/
│   └── api-test/
│       ├── SKILL.md                 # 技能正文（唯一可编辑的内容源）
│       └── scripts/                 # 四个零依赖脚本
│           ├── md2pdf.mjs           # Markdown → PDF（本机 Chrome/Edge headless）
│           ├── digraph.mjs          # 调用链路图 → SVG
│           ├── classmap.mjs         # UML 类关系图 → SVG
│           └── cases2xlsx.mjs       # 用例表 / 字段来源表 → 真正的 .xlsx（+ 可选 CSV）
├── verify.mjs                       # 本地自检（技能正文 + 注册对象 + 清单）
├── verify-cases.mjs                 # cases2xlsx 自检：真实规模数据 + 从产物字节回读
├── check-patch.mjs                  # patch 结构校验
├── check-encoding.mjs               # 编码与语法不变式
└── LICENSE
```

## 原理

- `package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，profile 把这个 bundle
  列进 `dsh.profile.bundles` 后，patch 会往 loader 树里插入一行插件条目。
- `index.js` 的 `inject = ['skills']` 只依赖 `skills` 服务；`apply()` 做两件事：
  1. 用 `readFileSync` 读取 `assets/api-test/SKILL.md`，剥掉 YAML frontmatter；
  2. 调用 `ctx.skills.register({ name, description, whenToUse, invocation, source, resourceBase, metadata, content })`。
- 注册时正文必须以 `content` 字符串一起给出（运行时技能没有惰性加载回调）；
  元数据（name / description / whenToUse）同时写在代码里，这样即使正文文件出了问题，
  技能仍能在目录里正常出现并给出诊断提示。

## 安装

两种方式，任选一种。**不要**手写 profile 的 `package.json` / `cordis.patch.yml`，
也不要手跑 pnpm——`install_bundle` 会自己完成包安装与 bundle 选择。

### 方式 A：从 GitHub 安装（推荐，换机器也能用）

在 DSH 里让 agent 调用 `plugin_manager`：

```
action: install_bundle
target: github:yuanli-6/dsh-api-test-bundle
```

包内是纯 JS + Markdown，**没有依赖、没有构建步骤**，所以从 Git 拉下来即可运行。
想锁定某个版本就用带 tag 的写法：`github:yuanli-6/dsh-api-test-bundle#v1.0.0`。

### 方式 B：从本地目录安装（改代码时方便）

```
action: install_bundle
target: <本目录绝对路径>
```

本地目录会以 `link:` 方式接入 profile，改动即刻对插件可见。

### 安装结果

- `application: applied` → 已经热加载生效。
- 重新安装/替换包需要**重启 DSH**（要加载新的 JS 模块世代）。

> 注意：插件属于**本机 profile**（`$DSH_HOME/profiles/<profile>/`），不属于 DSH 账号。
> 换机器、换一份 dsh，插件不会跟过去，需要在新机器上重新执行一次上面的安装。
> 这正是方式 A 的意义。

## 改了 SKILL.md 之后怎么让运行中的 dsh 生效

**关键机制**：`ctx.skills.register()` 要求在注册时就把正文以 `content` 字符串交出去，
运行时技能没有惰性加载回调。所以正文是在**插件激活那一刻**读进内存的——
**只改 SKILL.md 文件不会自动生效**，运行中的技能会继续发旧正文（内容和磁盘不一致）。

让改动生效，二选一：

1. **不重启（推荐，已实测有效）**：用 `plugin_manager` 对插件行 toggle 一次——

   ```
   action: set_plugin, target: include:dsh-api-test-bundle, enabled: false
   action: set_plugin, target: include:dsh-api-test-bundle, enabled: true
   ```

   重新启用会让插件模块重新导入、`apply()` 重新执行，正文随之刷新。
2. 重启 DSH。

只改了 `index.js` 里除正文之外的东西（比如描述、触发词）同样用上面两种方式。
**注意**：`dsh.bundle.patch` 那个文件（`cordis.patch.yml`）改了才需要重启。

改完请务必验证：调用 `skill` 工具加载 `api-test`，确认看到的是新正文——
不要以为存盘就等于生效。

## 验证

1. **看安装结果**：`plugin_manager` `action: list_bundles`，应出现
   `dsh-api-test-bundle`、`installed: true`、`enabled: true`，且 rows 里有一行
   `dsh-api-test-bundle`。
2. **看技能是否可加载**：直接调用 `skill` 工具，`name: "api-test"`。
   成功时会返回 `<skill_content name="api-test">`，且
   `Base directory for this skill:` 指向本包的 `assets/` 目录。
3. **看是否会被自动触发**：新开一个会话，说「测一下这个接口」之类的话，
   技能目录里应出现 `api-test` 并被命中。

## 交互流程与产物（v1.1.0）

说「测一下这个接口」后，技能会用 `ask_user_question` 问你（**出图选择已并入第一步**）：

1. **测试范围**：单个/多个接口、整个 Controller、**整个 Controller + 纵向关系图**（推荐）、多个 Controller —— 一次问完，不重复追问"要不要图"
2. **测试次数**：1 / 3 / 5 / 10 轮（可自己填），**每轮所有参数互不相同**，生成后会自检不重复
3. **图的形态**（若第 1 步已带图则只确认这个）：纵向拓扑 / 横向调用链
4. **导出格式**：Markdown / Markdown + PDF / 再加接口类与字段关系明细

最终产出放在**被测项目根的 `docs/`**：完整 Markdown 报告、可选 PDF、结构化 `api-test-result.json`、
**测试用例 `api-test-cases.md` + `.xlsx`**、**字段来源关系图 `api-test-field-source.md`（+ `.xlsx`）**、
调用链路图与 UML 类图 SVG、Mermaid `.mmd`。报告里每个接口都有完整 API 说明（类名、方法签名、源码行号、直连与网关地址、参数表、返回结构、示例报文、逐轮用例、异常边界）。

## 测试用例交付与字段来源图（v1.4.0）

v1.4.0 把「测试跑完给什么」写成了硬要求：

### 1. 每轮测试完成必出测试用例（不再是可选）

- 产物：`docs/api-test-cases.md` + **`docs/api-test-cases.xlsx`**（用 `cases2xlsx.mjs` 生成的真 xlsx；
  多 sheet、表头加粗冻结、自动筛选；`--csv` 还会附一份 UTF-8 BOM 的 CSV）
- 列结构取主流测试管理工具（禅道 / TestLink / Excel 用例表）的写法：
  `用例编号 | 所属模块 | 接口名称 | 接口路径 | 用例标题 | 用例类型 | 优先级 | 前置条件 | 测试步骤 | 测试数据 | 预期结果 | 实际结果 | 结论`
- 设计方法用通用那几种：等价类划分 / 边界值分析 / 判定表（pairwise）/ 场景法与状态迁移 / 业务规则正反例
- 用例编号 `TC-<Controller 简称>-<3 位序号>`；类型 `正向 / 业务规则 / 边界(合法) / 异常(未被代码校验覆盖) / 幂等 / 性能观察`；
  优先级 `P0/P1/P2`；预期结果必须能判定（HTTP + 业务码 + data 关键字段）

### 2. 参数只在正常范围内变更，不再堆非法参数

- 每一轮的参数都落在**业务合法区间**内，轮次之间整体换一套（不是把某一轮改成空值/负数）
- **代码里已经显式校验的约束不再单独造反例用例**——非空（`@NotNull`/`@NotBlank`/`StringUtils.isBlank`）、
  长度（`@Size`）、范围（`@Min`/`@Max`）、枚举、格式（`@Pattern`）、条件必填、互斥；
  改为在报告里出一张 **「契约校验已覆盖」** 表：`约束 | 代码位置 | 校验方式 | 处理`
- 仍然要测的是**代码没管**的异常：状态流转限制、跨字段业务规则、权限、重复提交/并发
- 边界只在合法区间内取（合法 min / max / 典型中间值），不固定造 `min-1` / `max+1`

### 3. 接口返回字段来源关系图

**逐字段追到最底层**——不停在"某个方法返回的"，直到能回答"这个值到底是怎么算出来的"：

| 来源类型 | 标记 | 追到什么程度 |
| --- | --- | --- |
| 数据库列 | 〔SQL〕 | 具体 `表.列名` + 完整 SQL（含 WHERE / ORDER BY）+ 每个条件的来源（请求参数 / 代码固定 / 框架追加） |
| 内存计算 | 〔MEM〕 | 完整算子链 `stream().map().filter().collect()`，逐步说明每步在做什么 |
| 框架行为 | 〔FW〕 | 哪个拦截器 / 注解产生的（分页 COUNT、`@TableLogic` 追加 `deleted=0`、自动填充） |
| 常量 | 〔CONST〕 | 代码里哪个字面量 |

必须追到底的典型场景：

- **SQL 列**：写全 `WHERE id = ? AND deleted = 0`，并说明 `deleted = 0` 是 `@TableLogic` **框架追加**、业务代码里没有这个字符串
- **方法内集合运算**：把算子链拆开写，如 `map(取列) → filter(排除 null 与 0) → toSet(去重 N 行→≤N 个) → 一次 IN 查询 → toMap → Map.get()`，并写明**为什么这样写**（如"先 Set 去重再 IN 查询，把 SQL 数压到固定 2 条，避免 N+1"）
- **求和 / 计数 / 分组 / 排序**：写明聚合函数与输入集合
- **多条 SQL 拼装**：逐条列出并标明各自**触发条件**；区分某字段来自 `JOIN` 还是**应用层二次查询**（对性能与语义影响完全不同）
- **框架生成字段**：分页 `total` 常不是业务代码算的，而是 `PaginationInnerInterceptor` 改写 SQL 后额外执行 `COUNT` 回填；`size` 可能被 `Math.min(..., 200)` 夹取（请求 500 返回 200）
- **内存建树**：树形 `children` 通常是内存 Map 挂载（**非 SQL 递归 CTE**），写出"装入 Map → 按 parentId 查找挂载 → 未命中提升为顶级"的完整过程

其他要求：

- 必须依据真实代码，**不编造字段来源**；不确定的标「待确认」
- **锚点（`文件:行号`、SQL、算子链）必须用检索工具回源码取证，不能凭位置感估算**——曾凭印象写行号整体偏约 10 行，读者按图索骥找不到代码
- DTO/VO/Entity 读字段；`List<Map>` / `Map<String,Object>` **以代码里 `put` 的 key 为准**，动态 key 标「动态 key，待确认」
- 涉及计算的字段（计数 / 夹取 / 去重 / 聚合 / 建树）另出「计算类字段速查」表
- 列结构：`层级 | 返回字段 | 含义 | 来源类型 | 来源表/对象 | 底层追溯（SQL列 或 算子链） | 锚点`
- 产物：`docs/api-test-field-source.md`（+ 字段多时 `.xlsx`，建议含「字段来源-深度」「框架层来源」「计算类字段速查」多 sheet）
- 与另两张图分工：字段来源图回答"字段从哪来"，`digraph.mjs` 回答"请求经过哪些层"，`classmap.mjs` 回答"类之间什么关系"

## v1.5.0：字段来源追到底层 + 报告数据展示

v1.5.0 解决两个实际问题：

### 1. 字段来源不再停在"某个方法返回的"

来自用户明确要求：「我要查询返回结果的关系图，需要展示到最底层的关系上面去，这包括了解析 sql，
内部方法，函数之后的真基础的关系，比如有一个字段是在一个方法里面返回的值，这个方法里面用集合
进行了 stream 流进行了过滤，或者求和，你需要把这层关系给我理出来，而不是写一个函数就完事了」。

- 新增《必须追到最底层（关键要求）》一节：四类来源标记〔SQL〕〔MEM〕〔FW〕〔CONST〕+ 六类必须追到底的典型场景
- 要求写**完整算子链**（`map → filter → toSet 去重 → IN 查询 → toMap → Map.get()`）并说明**为什么这样写**（避免 N+1）
- 要求区分 `JOIN` 与**应用层二次查询**，并标明各自触发条件（如 `parentId != 0` 才发第二条 SQL）
- 要求说明框架生成的字段（分页 `total` 由 `PaginationInnerInterceptor` 额外 `COUNT` 回填；`size` 被 `Math.min(...,200)` 夹取）
- 列结构升级为：`层级 | 返回字段 | 含义 | 来源类型 | 来源表/对象 | 底层追溯 | 锚点`
- 新增《交付前：锚点必须回源码取证》——`文件:行号` 必须检索核对，不许凭位置感估算（曾整体偏约 10 行）
- 建议 xlsx 多出「框架层来源」「计算类字段速查」两个 sheet

### 2. 报告数据展示：宽表拆窄

用例表把「长 JSON 参数」和「结果值」塞在同一行时，单行轻松超 150 字符，横向溢出且无法扫读。
现在要求**拆两张表**：

- **结果表**（窄，4~5 列纯数值）：`# | 轮次 | 期望码 | 实际码 | 耗时 | 结论`，可快速扫读
- **参数明细**（每轮一个代码块，完整可复制），并逐轮标注**差异点**
- 全局固定值（如 HTTP 一律 200）提到表外统一说明，不在每行重复

## 内置脚本（零依赖）

`assets/api-test/scripts/` 下四个脚本，技能会调用它们，你也可以单独用：

```powershell
# Markdown -> PDF：内部用 Chrome/Edge headless 打印，中文字体已适配
node assets/api-test/scripts/md2pdf.mjs 报告.md [输出.pdf]

# 用例表 / 字段来源表 -> 真正的 .xlsx（也可 --csv 出 UTF-8 BOM 的 CSV）
node assets/api-test/scripts/cases2xlsx.mjs 用例.json 用例.xlsx [--csv]

# 调用链路图 -> SVG：自算分层布局，纵向适合放进 A4
node assets/api-test/scripts/digraph.mjs 图描述.json 输出.svg

# UML 类关系图 -> SVG：类框分「类名/字段/方法」三栏，关系带箭头语义与基数
node assets/api-test/scripts/classmap.mjs 类图描述.json 输出.svg
```

`cases2xlsx.mjs` 输入是一个 JSON（`{ title, sheets: [{ name, columns, rows, widths? }] }`，单 sheet 也可）。
所有字符串都按**文本**写入（`inlineStr`）：`=1+1`、`00123`、`2026-10-11` 不会被 Excel 当公式/数字/日期改写；
数字与布尔值保持真实类型以便排序求和；超过 Excel 单元格上限（32767 字符）会截断并在 stderr 告警；
sheet 名里的 `: \ / ? * [ ]` 会被替换。**不要手写 xlsx 二进制。**

`classmap.mjs` 的记法参考 PlantUML 类图 / Mermaid `classDiagram`：

| 关系 `type` | 画法 | 语义 |
| --- | --- | --- |
| `call` | 实线 + 实心箭头 | 调用 / 委托 |
| `composition` | 实心菱形 + 箭头 | 组合（由…构建） |
| `inheritance` | 空心三角 | 继承（extends） |
| `dependency` | 虚线 + 空心箭头 | 依赖（作为参数） |

字段支持 `marker` 徽标（`PK` / `@Version` / `@TableLogic` / `必填` 等，自动配色）与 `note` 注解说明，
每条关系可标 `cardinality`（如 `1 → *`），图底部自带图例。

**能力边界（脚本会明确报错，不会假装成功）**：

| 能力 | 依赖 | 没有时 |
| --- | --- | --- |
| Markdown | 无 | — |
| PDF | 本机 Chrome 或 Edge | 脚本报错并提示安装，或设 `DSH_PDF_BROWSER=<浏览器路径>`；不会伪造 PDF |
| 调用链路图 / UML 类图 SVG | 无（两个生成器都自带布局算法） | — |
| Mermaid 源码 | 无 | 报告里会贴出 `classDiagram` 源码块，GitHub 等可直接渲染 |

## 本地自检（不依赖 DSH）

```powershell
node verify.mjs            # 技能正文 + 注册对象 + 清单校验（172 项）
node verify-cases.mjs      # cases2xlsx 自检：64 条用例 / 5 个 sheet，从产物字节回读单元格（24 项）
node check-patch.mjs       # cordis.patch.yml 的 insert 结构
node check-encoding.mjs    # 不变式：全仓库无 BOM、JSON 可解析、脚本语法通过
```

`verify-cases.mjs` 是给 `cases2xlsx.mjs` 用的：它不用玩具数据（空表、一行两列那种全绿但漏缺陷），
而是 64 条用例 × 13 列、5 个 sheet，含超长文本、缺失字段、`<&>"'`、表情、换行、前导零、
公式样式文本与超 Excel 上限的单元格；生成后**自己把 ZIP 解开**、从 XML 里读回单元格逐条核对，
并校验 CSV 的引号/逗号/换行转义。**它证明的是内容，不只是"能打开"。**

`check-encoding.mjs` 存在的理由：`package.json` 一旦带上 UTF-8 BOM，
**从 GitHub 安装会直接失败**（pnpm 报 `Unexpected token '\uFEFF'`）。
用 PowerShell 的 `Set-Content -Encoding utf8` 改文件会写入 BOM，
所以改完文件后跑一次它；加 `--fix` 可自动移除 BOM。

两个脚本都是**可移植的**：只读本包内的相对路径，不依赖任何机器专属路径。
`check-patch.mjs` 会优先借用 DSH 安装里的真实 js-yaml；找不到时退化到内置的
最小解析器（覆盖本 patch 用到的 YAML 子集），并在开头打印实际使用的解析器。

## 技能运行时会写什么

`api-test` 在**被测项目**里落一份接口解析缓存：

```
<被测项目根>/.dsh-meow/api-test/cache.json
```

- 该目录由 meow-memory 全局忽略，所以通常不用管；但如果你在**自己的项目**里
  不想看到它进入版本库，确认项目 `.gitignore` 里包含 `.dsh-meow/`。
- 删掉它没有副作用，只是下次要重新解析一遍接口。

## 调整技能内容

改 `assets/api-test/SKILL.md` 即可，`index.js` 会自动读取。
如果改动涉及触发词或描述，同步更新 `index.js` 顶部的 `SKILL_DESCRIPTION` /
`SKILL_WHEN_TO_USE`——技能目录里展示给模型的是这两个常量。
