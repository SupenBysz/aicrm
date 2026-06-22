# KyaiCRM Phase 1.13c 组织结构与邀请数据范围过滤实现需求

> 文档状态：已锁定 / Phase 1.13c 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.13c / 邀请·部门·团队 行级数据范围（闭合数据范围口径）  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.13b 全部已实现并锁定  

---

## 1. 目标

把行级数据范围裁剪扩展到剩余 list 面：**邀请列表、部门列表、团队列表**，使数据范围（Phase 1.7 建模）作用于所有 Phase 1 list 面，闭合口径（成员/审计已生效）。

本阶段决策：

- 决策 A（A‑1）：邀请按**创建者**裁剪（`invited_by_membership_id` ∈ caller 可见成员集），与审计同模式、复用 `VisibleMembershipIDs`。
- 决策 B（B‑1）：部门/团队按 §4 的可见集 crisp 规则裁剪。
- 决策 C（C‑1）：`ky-org-service` 移植聚焦版数据范围解析器 `ResolveOrgScope`（读共享表），登记“后续抽取共享模块”技术债。
- 决策 D（D‑1）：无可见集 → 空列表（与 1.13/1.13b 一致）。

---

## 2. 范围

```text
ky-membership-service:
  GET /api/v1/invitations            按 invited_by ∈ 可见成员集裁剪
ky-org-service:
  GET /api/v1/departments            按可见部门集裁剪
  GET /api/v1/teams                  按可见团队集裁剪
```

### 2.1 不改 / 延后

```text
specified_agency/enterprise 的平台跨主体数据面
与 CRM 业务数据的范围联动（后续业务阶段）
两服务解析器共享模块抽取（技术债，后续重构）
page/action 权限校验、平台全局行为（不变）
```

---

## 3. 邀请裁剪（membership-service）

- caller 范围按既有 `ResolveMemberScope` 解析。
- `Unrestricted`（all/current_<wsType>）→ 不裁剪。
- 否则取 `VisibleMembershipIDs`，`ListInvitations` 追加 `invited_by_membership_id IN (集合)`；空集 → `false`（空列表）。
- 仅需在 WHERE 引用 `invited_by_membership_id`（该列已存在于 `ky_invitation`）；无需改动 SELECT 投影或 `Invitation` 模型/响应。
- total 与 items 同过滤。
- 平台工作区：平台 owner/admin 持 all → Unrestricted，不受影响。

---

## 4. 部门 / 团队裁剪（org-service）

### 4.1 ResolveOrgScope

新增 `ky-org-service/internal/store/scope_store.go`（聚焦部门/团队维度）：

```text
ResolveOrgScope(ctx, callerMembershipID, wsType, wsID) -> OrgScope {
  Unrestricted bool
  DepartmentIDs []string   // 可见部门集（含递归子树展开）
  TeamIDs []string         // 可见团队集
}
```

解析（并集最宽松）：

1. 读 caller 的 `ky_role_data_scope`（经 `ky_membership_role`，仅 normal 角色未删除）。
2. 命中 `all` / `current_<wsType>` → `Unrestricted=true`，直接返回。
3. 逐范围累加：
   - `self` → caller 本人部门 IDs（`ky_membership_department`）加入 DepartmentIDs；caller 本人团队 IDs（`ky_membership_team`）加入 TeamIDs。
   - `department` → caller 本人部门 IDs 加入 DepartmentIDs。
   - `department_tree` → caller 本人部门 IDs 经 `WITH RECURSIVE`（`ky_department.parent_id`，软删除排除，UNION 去重）展开子树，加入 DepartmentIDs。
   - `specified_department` → scope.department_ids 加入 DepartmentIDs。
   - `team` → caller 本人团队 IDs 加入 TeamIDs。
   - `specified_team` → scope.team_ids 加入 TeamIDs。
   - `custom` → scope.department_ids 加入 DepartmentIDs，scope.team_ids 加入 TeamIDs。
   - `specified_agency`/`specified_enterprise` → 部门/团队面忽略。
4. 去重。

### 4.2 部门列表裁剪

- Unrestricted → 不裁剪。
- 否则 `ky_department.id IN (OrgScope.DepartmentIDs)`；空集 → 空列表。

### 4.3 团队列表裁剪

- Unrestricted → 不裁剪。
- 否则 `(ky_team.id IN (OrgScope.TeamIDs)) OR (ky_team.department_id IN (OrgScope.DepartmentIDs))`；两集皆空 → 空列表。

### 4.4 一致性

- 部门/团队列表当前为非分页（直接返回数组），裁剪谓词加入既有 WHERE 即可；若后续加分页，total 与 items 须同谓词。

---

## 5. 验收标准

```text
owner/admin（Unrestricted）三类 list 行为不变
部门负责人：邀请仅见其可见成员所发；部门仅见本部门及子树；团队仅见本部门下/本人团队
团队负责人：团队仅见本团队；邀请仅见可见成员所发
self：部门/团队仅见本人所属；邀请仅见本人所发
无可见集 -> 空列表，不泄漏
go build / vet / test 四服务通过；复审 NO BLOCKERS
```

---

## 6. 风险与约束

1. `ResolveOrgScope` 为 membership 版解析器的聚焦移植，产生重复代码 → 登记技术债，本阶段不做共享抽取（避免牵动两服务）。
2. 递归子树 UNION 去重防环、软删除排除（与 membership 版一致）。
3. 部门/团队 list 非分页，本阶段不引入分页改动。
4. 性能：`ky_team.department_id` 已有索引；IN 集合有界（部门子树/团队）。
5. self 对部门/团队取 caller 本人所属（与“仅本人可见数据”在组织结构面的合理映射）。
