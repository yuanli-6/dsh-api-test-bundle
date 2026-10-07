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
│       └── SKILL.md                 # 技能正文（唯一可编辑的内容源）
├── verify.mjs                       # 本地自检
├── check-patch.mjs                  # patch 结构校验
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

说「测一下这个接口」后，技能会用 `ask_user_question` 依次问你四件事：

1. **测试范围**：某个 Controller 下的单个/多个接口、整个 Controller、或多个 Controller
2. **测试次数**：1 / 3 / 5 / 10 轮（可自己填），**每轮所有参数互不相同**，生成后会自检不重复
3. **是否导出关联关系图**：`Controller → Service → Mapper → Entity → DTO`，可选纵向拓扑或横向调用链
4. **导出格式**：Markdown / Markdown + PDF / 再加接口类与字段关系明细

最终产出放在**被测项目根的 `docs/`**：完整 Markdown 报告、可选 PDF、结构化 `api-test-result.json`、以及关系图 SVG。报告里每个接口都有完整 API 说明（类名、方法签名、源码行号、直连与网关地址、参数表、返回结构、示例报文、逐轮用例、异常边界）。

## 内置脚本（零依赖）

`assets/api-test/scripts/` 下三个脚本，技能会调用它们，你也可以单独用：

```powershell
# Markdown -> PDF：内部用 Chrome/Edge headless 打印，中文字体已适配
node assets/api-test/scripts/md2pdf.mjs 报告.md [输出.pdf]

# 调用链路图 -> SVG：自算分层布局，纵向适合放进 A4
node assets/api-test/scripts/digraph.mjs 图描述.json 输出.svg

# UML 类关系图 -> SVG：类框分「类名/字段/方法」三栏，关系带箭头语义与基数
node assets/api-test/scripts/classmap.mjs 类图描述.json 输出.svg
```

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
node verify.mjs          # 校验清单 + 注册对象 + 技能正文必备内容（118 项）
node check-patch.mjs     # 校验 cordis.patch.yml 的 insert 结构
```

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
