import type { MenuDirectoryEntry, Permission } from "./api";
import { DOMAIN_LABELS, DOMAIN_ORDER, RESOURCE_LABELS, resourceDomain } from "./permission-labels";
import type { MenuTreeNode } from "./menu-permission-tree";
export function buildAuthorizationTree(permissions: readonly Permission[], directories: readonly {
    directory: string;
    entries: readonly MenuDirectoryEntry[];
    ancestors: readonly MenuDirectoryEntry[];
}[], category?: string) {
    const keyToId = new Map<string, string>();
    const assigned = new Set<string>();
    const byCode = new Map(permissions.map(p => [p.code, p]));
    const selected = permissions.filter(p => !category || p.category === category);
    const leaf = (p: Permission, prefix: string): MenuTreeNode => {
        const key = `permission:${prefix}:${p.id}`;
        keyToId.set(key, p.id);
        assigned.add(p.id);
        return { key, title: p.name, isLeaf: true };
    };
    const roots: MenuTreeNode[] = [];
    for (const catalog of directories) {
        const all = new Map([...catalog.ancestors, ...catalog.entries].map(e => [e.menuKey, e]));
        const nodes = new Map<string, MenuTreeNode>();
        const localRoots: MenuTreeNode[] = [];
        const nodeFor = (entry: MenuDirectoryEntry, seen = new Set<string>()): MenuTreeNode | null => {
            if (seen.has(entry.menuKey))
                return null;
            if (nodes.has(entry.menuKey))
                return nodes.get(entry.menuKey)!;
            seen.add(entry.menuKey);
            const parent = entry.parentKey ? all.get(entry.parentKey) : undefined;
            if (entry.parentKey && !parent)
                return null;
            const parentNode = parent ? nodeFor(parent, seen) : null;
            if (parent && !parentNode)
                return null;
            const node: MenuTreeNode = { key: `module:${catalog.directory}:${entry.menuKey}`, title: entry.name, selectable: false, children: [] };
            nodes.set(entry.menuKey, node);
            (parentNode?.children ?? localRoots).push(node);
            return node;
        };
        for (const entry of [...catalog.entries].sort((a, b) => a.sortOrder - b.sortOrder || a.menuKey.localeCompare(b.menuKey))) {
            if (entry.nodeType !== "leaf")
                continue;
            const codes = new Set([entry.permissionCode, ...Object.values(entry.permissionBindings ?? {}).flat()].filter(Boolean));
            // Resource ownership is taken from the permission catalog of explicitly
            // registered entry permissions; it is not inferred from menu titles.
            const resources = new Set([...codes].map(code => byCode.get(code)?.resource).filter(Boolean));
            const owned = selected.filter(p => codes.has(p.code) || resources.has(p.resource));
            if (!owned.length)
                continue;
            const node = nodeFor(entry);
            if (!node)
                continue;
            node.children = owned.map(p => leaf(p, `${catalog.directory}:${entry.menuKey}`));
        }
        if (localRoots.length)
            roots.push({ key: `directory:${catalog.directory}`, title: catalog.directory === "management" ? "管理中心" : "工作台", selectable: false, children: localRoots });
    }
    const publicPermissions = selected.filter(p => !assigned.has(p.id));
    const domains = DOMAIN_ORDER.flatMap(domain => {
        const perms = publicPermissions.filter(p => resourceDomain(p.resource) === domain);
        const resources = [...new Set(perms.map(p => p.resource))];
        const children = resources.map(resource => ({ key: `public:${domain}:${resource}`, title: RESOURCE_LABELS[resource] ?? "其他功能", selectable: false, children: perms.filter(p => p.resource === resource).map(p => leaf(p, `public:${resource}`)) }));
        return children.length ? [{ key: `domain:${domain}`, title: DOMAIN_LABELS[domain], selectable: false, children }] : [];
    });
    if (domains.length)
        roots.push({ key: "public", title: "公共权限", selectable: false, children: domains });
    return { nodes: roots, keyToId, renderedIds: new Set(keyToId.values()) };
}
export function authorizationNodePermissionIds(nodes: readonly MenuTreeNode[], keyToId: ReadonlyMap<string, string>, key: string): Set<string> {
    const find = (items: readonly MenuTreeNode[]): MenuTreeNode | undefined => { for (const node of items) {
        if (node.key === key)
            return node;
        const found = node.children && find(node.children);
        if (found)
            return found;
    } return undefined; };
    const result = new Set<string>();
    const collect = (node: MenuTreeNode) => { const id = keyToId.get(node.key); if (id)
        result.add(id); node.children?.forEach(collect); };
    const node = find(nodes);
    if (node)
        collect(node);
    return result;
}
