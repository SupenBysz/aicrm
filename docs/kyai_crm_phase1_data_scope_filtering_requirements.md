# KyaiCRM Phase 1.13 行级数据范围过滤实现需求

> 文档状态：已锁定 / Phase 1.13 基线  
> 项目名称：KyaiCRM  
> 当前阶段：Phase 1.13 / 行级数据范围过滤（完成 Phase 1.7 延后核心）  
> 编写日期：2026-06-16  
> 前置基线：Phase 1.1–1.12 全部已实现并锁定  

---

## 1. 背景与目标

Phase 1.7 建模并暴露了数据范围（dataScopes），但服务端未据此裁剪列表数据（已在文档明确“前端不得误判已裁剪”）。本阶段让数据范围真正作用于**成员列表/详情**，使部门负责人/团队负责人只能看到其范围内成员。

本阶段决策：

- 决策 B（B‑1）：`department`/`team`（非 specified）相对**调用者本人**的部门/团队归属取值。
- 决策 C（C‑1）：无可见范围时，列表返回空、详情返回 404，绝不返回越权数据。
- 决策 D（D‑1）：本阶段仅裁剪成员列表/详情；audit/departments/teams/invitations 的行级裁剪延后 1.13b。

---

## 2. 范围

### 2.1 改动接口（ky-membership-service）

```text
GET /api/v1/workspace/members        列表按数据范围裁剪
GET /api/v1/workspace/members/:id    详情按数据范围裁剪（越界 404）
```

### 2.2 不改 / 延后

```text
其余 list 接口的行级裁剪（audit-logs/departments/teams/invitations）—— 1.13b
权限（page/action）校验 —— 已在 Phase 1.7 生效，不变
平台成员列表 —— 平台范围类型不细分平台成员，实际不受行级裁剪影响（见 5.4）
```

---

## 3. 数据范围语义

一个 membership 的有效范围 = 其所有角色 `ky_role_data_scope` 的**并集（最宽松）**。

| scope_type | 含义（成员面） |
|---|---|
| all / current_agency / current_enterprise | 当前工作区全部成员（不额外裁剪） |
| self | 仅调用者本人 membership |
| department | 调用者本人所属部门内成员 |
| department_tree | 调用者本人所属部门及其子树内成员 |
| specified_department | 指定部门（scope.department_ids）内成员 |
| team | 调用者本人所属团队内成员 |
| specified_team | 指定团队（scope.team_ids）内成员 |
| custom | scope 内 department_ids ∪ team_ids 对应成员 |
| specified_agency / specified_enterprise | 平台场景，对平台成员列表不细分（见 5.4） |

并集规则：只要任一角色为 `all`/`current_<wsType>` → 不裁剪；否则将各受限范围对应的成员集合做 OR 合并。

---

## 4. 范围解析 ResolveMemberScope

`ResolveMemberScope(ctx, callerMembershipID, wsType, wsID) -> ScopeFilter`：

```text
ScopeFilter {
  Unrestricted bool        // all / current_<wsType> 命中
  SelfMembershipID string  // self 命中时填调用者 membershipId
  DepartmentIDs []string   // 需匹配的部门集合（含递归子树展开后的结果）
  TeamIDs []string         // 需匹配的团队集合
}
```

解析步骤：

1. 读 `DataScopesForMembership(caller)`（已存在）。
2. 命中 `all` 或 `current_agency`（wsType=agency）或 `current_enterprise`（wsType=enterprise）→ `Unrestricted=true`，直接返回。
3. 逐个范围累加：
   - `self` → 记录 `SelfMembershipID = caller`。
   - `department` → 取调用者本人部门 IDs（`ky_membership_department` where membership=caller）加入 DepartmentIDs。
   - `department_tree` → 调用者本人部门 IDs 经 `WITH RECURSIVE`（`ky_department.parent_id`）展开为子树集合，加入 DepartmentIDs。
   - `specified_department` → scope.department_ids 加入 DepartmentIDs。
   - `team` → 调用者本人团队 IDs（`ky_membership_team`）加入 TeamIDs。
   - `specified_team` → scope.team_ids 加入 TeamIDs。
   - `custom` → scope.department_ids 加入 DepartmentIDs，scope.team_ids 加入 TeamIDs。
   - `specified_agency`/`specified_enterprise` → 成员面忽略（5.4）。
4. 去重。

递归子树查询（去重避免环路无限）：

```sql
WITH RECURSIVE subtree AS (
  SELECT id FROM ky_department WHERE id = ANY($1) AND deleted_at IS NULL
  UNION
  SELECT d.id FROM ky_department d JOIN subtree s ON d.parent_id = s.id WHERE d.deleted_at IS NULL
)
SELECT id FROM subtree
```

---

## 5. SQL 裁剪应用

### 5.1 列表

`ListMembers` 接收 `ScopeFilter`：

- `Unrestricted` → 不加裁剪谓词（行为不变）。
- 否则在既有 WHERE 后追加：

```sql
AND (
  ($selfId <> '' AND m.id = $selfId)
  OR (cardinality($deptIds) > 0 AND EXISTS (SELECT 1 FROM ky_membership_department md WHERE md.membership_id=m.id AND md.department_id = ANY($deptIds)))
  OR (cardinality($teamIds) > 0 AND EXISTS (SELECT 1 FROM ky_membership_team mt WHERE mt.membership_id=m.id AND mt.team_id = ANY($teamIds)))
)
```

- 三者集合全空且无 self → 追加恒假谓词（`AND false`），返回空列表（决策 C）。

### 5.2 详情

`GetMember`：先按既有逻辑取成员（工作区隔离），再判定该成员是否落在 ScopeFilter 内：

- `Unrestricted` → 直接返回。
- 否则成员须满足：`m.id == self` 或属于 DepartmentIDs 之一 或属于 TeamIDs 之一；不满足返回 404（决策 C，防探测）。

### 5.3 计数一致

列表分页 total 与 items 必须应用同一裁剪谓词。

### 5.4 平台工作区

平台成员列表的范围类型仅 all/specified_agency/specified_enterprise；后两者不细分“平台成员”。平台 owner/admin 持 `all` → Unrestricted。故平台成员列表本阶段不受行级裁剪影响（记录说明，非缺陷）。

---

## 6. 验收标准

```text
持 all/current_* -> 看到当前工作区全部成员（不变）
department_tree 负责人 -> 仅本部门及子树成员；越界成员详情 404
team 负责人 -> 仅本团队成员
self -> 仅自己
多角色范围取并集（更宽松者生效）
无可见范围 -> 空列表 / 详情 404，不泄漏越权数据
列表 total 与 items 裁剪一致
go build / vet / test 四服务通过；复审 NO BLOCKERS
```

---

## 7. 文档与口径更新

- 更新 Phase 1.7 实现锁定文档/本阶段说明：将“已据数据范围裁剪的面”从“无”更新为“成员列表/详情”，其余面仍延后。

---

## 8. 风险与约束

1. 仅成员面裁剪；其余 list 面仍未裁剪，前端不得对未裁剪面误判（口径维持）。
2. 相对范围依赖调用者自身部门/团队归属；若调用者无部门/团队归属且仅持 department/team 范围，则集合为空 → 空结果（符合决策 C）。
3. 递归子树查询去重防环；`ky_department` 软删除节点排除。
4. 性能：EXISTS + 既有 `ky_membership_department(department_id)`/`ky_membership_team(team_id)` 索引可接受。
5. specified_agency/enterprise 对成员面无效，待后续平台跨主体数据面再处理。
