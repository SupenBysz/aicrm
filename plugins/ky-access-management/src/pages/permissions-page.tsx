import { useEffect, useMemo, useState } from "react";
import { Empty, Segmented, Space, Tag, Tree, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ListPageCard, useRequestClient } from "@ky/admin-core";
import { listPermissions, type Permission } from "../api";
import {
  ACTION_LABELS,
  CATEGORY_LABELS,
  DOMAIN_LABELS,
  DOMAIN_ORDER,
  RESOURCE_LABELS,
  WORKSPACE_LABELS,
  label,
  resourceDomain,
  type DomainKey
} from "../permission-labels";

function leafTitle(perm: Permission) {
  return (
    <Space size={6} wrap>
      <Typography.Text strong>{perm.name}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {perm.code}
      </Typography.Text>
      <Tag>{label(CATEGORY_LABELS, perm.category)}</Tag>
      <Tag color="blue">{label(ACTION_LABELS, perm.action)}</Tag>
      {(perm.workspaceTypes ?? []).map((type) => (
        <Tag key={type}>{label(WORKSPACE_LABELS, type)}</Tag>
      ))}
    </Space>
  );
}

export function PermissionsPage() {
  const client = useRequestClient();
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [expandedKeys, setExpandedKeys] = useState<string[]>(DOMAIN_ORDER.map((dom) => `dom:${dom}`));
  const [autoExpandParent, setAutoExpandParent] = useState(true);

  const { data, isFetching } = useQuery({ queryKey: ["permissions", "catalog"], queryFn: () => listPermissions(client) });
  // Stabilize identity: `data ?? []` would otherwise create a new array every render,
  // cascading into filtered/parentKeys and retriggering the expand effect → React #185.
  const permissions = useMemo(() => data ?? [], [data]);

  const categoryOptions = useMemo(() => {
    const set = new Set(permissions.map((p) => p.category));
    return [...set].map((value) => ({ value, label: label(CATEGORY_LABELS, value) }));
  }, [permissions]);

  const filtered = useMemo(
    () => (category ? permissions.filter((p) => p.category === category) : permissions),
    [permissions, category]
  );

  // 三级分组：领域(中文) → 资源(中文) → 具体权限。
  const { treeData, parentKeys } = useMemo(() => {
    const domains = new Map<DomainKey, Map<string, Permission[]>>();
    filtered.forEach((perm) => {
      const dom = resourceDomain(perm.resource);
      if (!domains.has(dom)) domains.set(dom, new Map());
      const byResource = domains.get(dom)!;
      const list = byResource.get(perm.resource) ?? [];
      list.push(perm);
      byResource.set(perm.resource, list);
    });
    const parents: string[] = [];
    const tree = DOMAIN_ORDER.filter((dom) => domains.has(dom)).map((dom) => {
      const byResource = domains.get(dom)!;
      parents.push(`dom:${dom}`);
      let domainCount = 0;
      const children = [...byResource.entries()]
        .sort((a, b) => label(RESOURCE_LABELS, a[0]).localeCompare(label(RESOURCE_LABELS, b[0]), "zh"))
        .map(([resource, perms]) => {
          domainCount += perms.length;
          parents.push(`res:${dom}:${resource}`);
          return {
            title: `${label(RESOURCE_LABELS, resource)}（${perms.length}）`,
            key: `res:${dom}:${resource}`,
            selectable: false,
            children: [...perms]
              .sort((a, b) => a.code.localeCompare(b.code))
              .map((perm) => ({ title: leafTitle(perm), key: perm.id, selectable: false, isLeaf: true }))
          };
        });
      return { title: `${DOMAIN_LABELS[dom]}（${domainCount}）`, key: `dom:${dom}`, selectable: false, children };
    });
    return { treeData: tree, parentKeys: parents };
  }, [filtered]);

  // 选了分类筛选时展开全部分组以便定位；否则只展开一级领域，保持清爽概览。
  useEffect(() => {
    setExpandedKeys(category ? parentKeys : DOMAIN_ORDER.map((dom) => `dom:${dom}`));
    setAutoExpandParent(true);
  }, [category, parentKeys]);

  return (
    <ListPageCard title="权限目录" subtitle="平台内置权限清单（只读），按 领域 → 资源 → 权限 分组。">
      <Space style={{ padding: 16 }} wrap>
        <Segmented
          options={[{ label: "全部", value: "" }, ...categoryOptions]}
          value={category ?? ""}
          onChange={(value) => setCategory(String(value) || undefined)}
        />
        <Typography.Text type="secondary">共 {filtered.length} 项</Typography.Text>
      </Space>
      <div style={{ padding: "0 16px 16px" }}>
        {filtered.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isFetching ? "加载中…" : "暂无权限"} />
        ) : (
          <Tree
            blockNode
            selectable={false}
            treeData={treeData}
            expandedKeys={expandedKeys}
            autoExpandParent={autoExpandParent}
            onExpand={(keys) => {
              setExpandedKeys(keys.map(String));
              setAutoExpandParent(false);
            }}
          />
        )}
      </div>
    </ListPageCard>
  );
}
