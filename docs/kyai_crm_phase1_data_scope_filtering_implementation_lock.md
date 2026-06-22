# KyaiCRM Phase 1.13 行级数据范围过滤实现锁定记录

> 文档状态：已锁定 / Phase 1.13 实现基线  
> 项目名称：KyaiCRM  
> 锁定日期：2026-06-16  

---

## 1. 锁定范围

```text
services/ky-membership-service
  internal/store/scope_store.go      ResolveMemberScope + 递归子树 + IN 占位
  internal/store/member_store.go     ListMembers/GetMember 应用 ScopeFilter + memberVisible
  internal/server/member_handlers.go 列表/详情解析 caller 范围并传入
```

完成 Phase 1.7 延后的核心：让数据范围真正作用于成员列表/详情。

---

## 2. 行为

- 有效范围 = caller 各角色 `ky_role_data_scope` 的并集（最宽松）。
- `all` / `current_<wsType>` 命中 → 不裁剪。
- 否则按并集构造：
  - `self` → 仅 caller 本人
  - `department` → caller 本人部门；`department_tree` → 经 `WITH RECURSIVE` 展开子树
  - `specified_department` → scope.department_ids
  - `team` → caller 本人团队；`specified_team` → scope.team_ids
  - `custom` → scope 内 department_ids ∪ team_ids
  - `specified_agency/enterprise` → 成员面忽略
- 列表：追加 OR 谓词（self / 部门 EXISTS / 团队 EXISTS）；全空 → `false`（空列表）。
- 详情：越界成员返回 404（防探测），使用已加载的成员部门/团队 ID 判定，无额外查询。
- 列表 total 与 items 应用同一裁剪谓词（scope 参数在 total 查询前已入 args）。

---

## 3. 复审与验证

独立复审重点核验最高风险项——占位符编号顺序（base → 过滤 → scope OR → limit/offset 全部连续正确）与 total 反映 scope（scope 参数在 total 查询前追加），并集语义、递归 CTE 去重/软删除排除、memberVisible 逻辑、相对范围取 caller 自身归属。结论：

```text
NO BLOCKERS
```

验证：

```text
go build / vet / test 四服务通过（含 -race）
新增单测：memberVisible 各 scope 分支 / intersects / inPlaceholders 编号 / 并集 self 优先
```

---

## 4. 口径更新

- 完成报告标注：行级数据范围过滤已在「成员列表/详情」生效。
- 其余 list 面（audit/departments/teams/invitations）行级裁剪仍延后（1.13b），前端不得对未裁剪面误判。

---

## 5. 后续（1.13b 及以后）

```text
audit-logs / departments / teams / invitations 的行级裁剪（复用 ResolveMemberScope 思路）
specified_agency/enterprise 的平台跨主体数据面
self/department/team 与具体业务数据（CRM）的范围联动（后续业务阶段）
```

---

## 6. 结论

成员面行级数据范围裁剪已实现并锁定，Phase 1.7 数据范围模型的核心执行能力落地。`department_leader`/`team_leader` 现仅能看到其范围内成员。
