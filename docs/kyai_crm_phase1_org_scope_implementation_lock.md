# KyaiCRM Phase 1.13c 组织结构与邀请数据范围过滤实现锁定记录

> 文档状态：已锁定 / Phase 1.13c 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
ky-membership-service:
  internal/store/invitation_store.go   ListInvitations 增加 inviterMembershipIDs 过滤
  internal/server/invitation_handlers.go  解析 caller 范围并传可见成员集
ky-org-service:
  internal/store/scope_store.go        ResolveOrgScope + dataScopesForMembership + departmentSubtree
  internal/store/scope_helpers.go      jsonToStrings / scopeAddAll / scopeKeys / scopeInPlaceholders
  internal/store/department_store.go   ListDepartments + 可见部门集过滤
  internal/store/team_store.go         ListTeams + 可见团队/部门集过滤
  internal/server/structure_handlers.go  解析并传入
```

至此数据范围（Phase 1.7 建模）作用于**全部 Phase 1 list 面**：成员、审计、邀请、部门、团队。

---

## 2. 行为

### 2.1 邀请（membership-service）
- caller 范围按 `ResolveMemberScope` 解析；Unrestricted → 不裁剪。
- 受限 → `VisibleMembershipIDs`，`invited_by_membership_id IN (集合)`；空集 → 空列表。
- 仅 WHERE 引用已有列，未改投影/模型。

### 2.2 部门 / 团队（org-service）
- 新增聚焦解析器 `ResolveOrgScope`（读 `ky_role_data_scope` via `ky_membership_role`），并集最宽松；`all`/`current_*` → Unrestricted；`department_tree` 经 `WITH RECURSIVE` 展开（软删除排除、UNION 去重）；`department/team/self` 相对 caller 自身归属；`specified_*`/`custom` 取显式 ID。
- 部门列表：`id IN (可见部门集)`；空集 → 空。
- 团队列表：`(id IN 可见团队集) OR (department_id IN 可见部门集)`；两集皆空 → 空。

---

## 3. 复审与验证

独立复审重点核验：ListInvitations 占位符编号与 total 含过滤；ResolveOrgScope 并集/递归/jsonb 解析；ListDepartments/ListTeams 占位符（团队两段 IN 顺序编号）；跨服务包符号无冲突（`jsonToStrings`/`itoa` 各属不同包）。结论：

```text
NO BLOCKERS
```

验证：

```text
go build / vet / test 四服务通过（-count=1）
新增单测：scopeInPlaceholders 编号 / 集合去重 / jsonToStrings
```

---

## 4. 口径更新（数据范围全闭合）

```text
已据数据范围裁剪的面：
  成员列表/详情（1.13）
  审计日志（1.13b）
  邀请列表 / 部门列表 / 团队列表（1.13c）
平台 owner/admin（all）不受影响；无可见集 -> 空列表，不泄漏。
```

技术债（已登记）：membership 与 org 两份聚焦解析器存在重复，后续可抽取共享模块。

---

## 5. 后续 backlog（已登记）

```text
两服务数据范围解析器共享模块抽取（技术债）
specified_agency/enterprise 平台跨主体数据面
session-active 级 token 校验
事件级通知自动生成
provider 停用级联、AI 密钥轮换、机构/企业级默认模型
前端页面接入、真实云部署/HTTPS/监控
CRM 业务数据与数据范围联动（后续业务阶段）
```

---

## 6. 结论

数据范围（Phase 1.7 模型）现已端到端作用于第一阶段全部 list 面。部门/团队负责人在成员、审计、邀请、部门、团队各面均只见其范围内数据。Phase 1.7 数据范围能力闭环完成。
