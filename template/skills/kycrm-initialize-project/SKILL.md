---
name: kycrm-initialize-project
description: KyCRM 项目初始化指南。Use when Codex needs to create or initialize a new independent project from the KyCRM/kysion-crm template, run interactive initialization, initialize from a YAML config file, configure project identity, app directories, package names, Git remote, validate generated projects, or review template initialization output.
---

# KyCRM Initialize Project

## 概览

使用本 skill 从 KyCRM / `kysion-crm` 基础框架模板初始化新的独立项目。它约束初始化入口、参数收集、目录与包名配置、Git 处理和生成后验证。

## 基本规则

- 使用仓库脚本 `scripts/create_project_from_template.sh` 初始化项目；不要手工复制目录。
- 有可复用参数时，优先沉淀为 `project-init.yaml` 并使用 `--config` 初始化。
- 用户未明确给全参数时，优先使用 `--interactive` 交互式初始化。
- 用户已明确给出项目名、slug、输出目录和 app 配置时，使用参数化初始化。
- 输出目录必须不存在或为空；不要覆盖已有项目。
- 仅在用户明确要求时使用 `--init-git`、设置远端、提交或推送。
- 默认不修改运行时契约：`window.aicrm`、`AICRM_*`、`ky_`、`KY_`、Go module path。
- 初始化完成后必须执行生成验证和敏感信息扫描。

## 工作流程

1. 先确认当前仓库包含 `scripts/create_project_from_template.sh` 和 `template/manifest.yaml`。
2. 根据用户输入选择初始化方式：
   - 参数需要审阅或复用：读取 `references/parameter-guide.md`，生成配置文件后使用 `--config`。
   - 参数不完整或用户希望“向导/交互式”：读取 `references/initialization-workflow.md`。
   - 参数已明确且无需保留配置：读取 `references/parameter-guide.md` 后组装命令。
3. 执行初始化脚本，保留脚本输出中的目标目录和 app 包名。
4. 读取 `references/validation-checklist.md`，按清单验证生成项目。
5. 如果用户要求发布生成结果，先重新生成干净输出，再同步到用户明确指定的目标仓库工作副本、提交并推送。

## Reference 加载规则

- 初始化执行、交互式流程、Git 规则：读 `references/initialization-workflow.md`。
- 参数含义、配置文件格式、命名建议、命令样例：读 `references/parameter-guide.md`。
- 生成后检查、敏感信息扫描、skill 验证：读 `references/validation-checklist.md`。

## 和解决方案 Skill 的关系

`aicrm-solution` 负责架构边界、模块职责、API、权限、通信规范和模板抽取原则；本 skill 只负责项目初始化执行。涉及架构边界或模板抽取原则时，同时遵循 `aicrm-solution`。

## 品牌适配必读

初始化或补全项目品牌前，必须阅读并在生成项目保留 [品牌 LOGO 与 AI 图标适配规范](../../../docs/branding/品牌LOGO与AI图标适配规范.md)。品牌文字与应用名称分别配置；AI 后缀复用共享图标并遵循开关；主题缩略预览必须使用当前品牌的完整亮暗 Logo。不能仅替换产品名就宣称品牌适配完成，必须执行规范中的跨入口验收清单。

## 产品交互设计与适配必读

涉及页面、菜单、表单、详情、查询、主题或用户流程时，先读 [设计与适配规范入口](../../../docs/design/README.md)，按任务选取设计总则和验收矩阵。实现说明应包含组件复用来源、保存/发布语义及异常恢复，不以截图相似或构建成功代替用户任务验收。
