export interface MenuNavigationDirectoryRow {
  menuKey: string;
  name: string;
  icon: string;
  parentKey: string | null;
  sortOrder: number;
  workspaceTypes?: string[];
  nodeType?: "group" | "leaf";
  pageType?: "internal" | "webview";
  routeKey?: string | null;
  routePath?: string | null;
  status?: "active" | "disabled";
  usageScope?: "browser_and_client" | "client_only";
}

export interface MenuNavigationCandidate {
  key: string;
  menuKey: string;
  label: string;
  iconName: string;
  target: string;
  groupKey?: string | null;
  groupLabel?: string;
  groupIconName?: string;
  sortOrder: number;
  groupSortOrder: number;
}

export interface MenuNavigationItem extends MenuNavigationCandidate {
  groupLabel?: string;
  groupIconName?: string;
}

export interface MenuNavigationGroup {
  key: string;
  label: string;
  iconName: string;
  sortOrder: number;
  items: MenuNavigationItem[];
}

export interface MenuNavigationTreeNode { key: string; label: string; iconName: string; sortOrder: number; item?: MenuNavigationItem; children?: MenuNavigationTreeNode[] }

export interface MenuNavigationResult {
  tree: MenuNavigationTreeNode[];
  standalone: MenuNavigationItem[];
  groups: MenuNavigationGroup[];
}

export function normalizeMenuIconName(name: string | null | undefined, fallback = "AppstoreOutlined"): string {
  const value = name?.trim();
  if (!value) return fallback;
  const aliases: Record<string, string> = {
    team: "TeamOutlined",
    douyin: "TikTokOutlined",
    tiktok: "TikTokOutlined",
    "tiktok-outlined": "TikTokOutlined"
  };
  return aliases[value.toLowerCase()] ?? value;
}

function rowIsAvailable(row: MenuNavigationDirectoryRow, workspaceType: string, authoritative: boolean): boolean {
  const statusAllowed = row.status === "active" || (authoritative && row.status === undefined);
  const workspaceAllowed = row.workspaceTypes?.includes(workspaceType) ?? authoritative;
  return statusAllowed && workspaceAllowed;
}

export function buildMenuNavigation(input: {
  candidates: MenuNavigationCandidate[];
  directory: MenuNavigationDirectoryRow[];
  workspaceType: string;
  fallbackGroupLabel: string;
  fallbackGroupIconName: (label: string, fallback?: string) => string;
  targetForWebView: (menuKey: string) => string;
  excludedDynamicKeys?: ReadonlySet<string>;
  authoritative?: boolean;
  allowCandidate?: (candidate: MenuNavigationCandidate) => boolean;
  allowDynamicWebView: (row: MenuNavigationDirectoryRow) => boolean;
}): MenuNavigationResult {
  const rows = new Map(input.directory.map((row) => [row.menuKey, row]));
  const represented = new Set<string>();
  const candidates = [...input.candidates];
  const staticCandidateKeys = new Set(input.candidates.map((candidate) => candidate.menuKey));
  for (const candidate of input.candidates) represented.add(candidate.menuKey);

  for (const row of input.directory) {
    if (represented.has(row.menuKey) || input.excludedDynamicKeys?.has(row.menuKey)) continue;
    if (row.nodeType !== "leaf" || row.pageType !== "webview" || !rowIsAvailable(row, input.workspaceType, Boolean(input.authoritative))) continue;
    if (!input.allowDynamicWebView(row)) continue;
    candidates.push({
      key: row.menuKey,
      menuKey: row.menuKey,
      label: row.name,
      iconName: normalizeMenuIconName(row.icon),
      target: input.targetForWebView(row.menuKey),
      groupKey: row.parentKey,
      sortOrder: row.sortOrder,
      groupSortOrder: Number.MAX_SAFE_INTEGER
    });
    represented.add(row.menuKey);
  }

  const standalone: MenuNavigationItem[] = [];
  const groupsByKey = new Map<string, MenuNavigationGroup>();
  candidates.forEach((candidate, index) => {
    if (staticCandidateKeys.has(candidate.menuKey) && input.allowCandidate && !input.allowCandidate(candidate)) return;
    const row = rows.get(candidate.menuKey);
    if (input.authoritative && !row) return;
    if (row && (!rowIsAvailable(row, input.workspaceType, Boolean(input.authoritative)) || row.nodeType === "group")) return;

    const parentKey = row ? row.parentKey : candidate.groupKey ?? null;
    const parentChain: MenuNavigationDirectoryRow[] = [];
    const seenAncestors = new Set<string>();
    let nextParentKey = parentKey;
    while (nextParentKey) {
      if (seenAncestors.has(nextParentKey)) return;
      seenAncestors.add(nextParentKey);
      const ancestor = rows.get(nextParentKey);
      if (!ancestor) {
        // A row that names a saved parent cannot safely be rendered using a
        // plugin fallback group when this response omitted that parent.
        if (input.authoritative || row?.parentKey) return;
        break;
      }
      if (ancestor.nodeType !== "group" || !rowIsAvailable(ancestor, input.workspaceType, Boolean(input.authoritative))) return;
      parentChain.push(ancestor);
      nextParentKey = ancestor.parentKey;
    }
    const parent = parentChain[0];
    const parentLabel = parent?.name.trim() || candidate.groupLabel || input.fallbackGroupLabel;
    const parentIconName = normalizeMenuIconName(
      parent?.icon,
      candidate.groupIconName ?? input.fallbackGroupIconName(parentLabel)
    );
    const item: MenuNavigationItem = {
      ...candidate,
      label: row?.name.trim() || candidate.label,
      iconName: normalizeMenuIconName(row?.icon, candidate.iconName),
      groupKey: parentKey,
      groupLabel: parentKey ? (parentChain.length ? [...parentChain].reverse().map(row=>row.name).join(" / ") : parentLabel) : undefined,
      groupIconName: parentKey ? parentIconName : undefined,
      sortOrder: row?.sortOrder ?? candidate.sortOrder
    };
    if (!parentKey) {
      standalone.push(item);
      return;
    }
    const existing = groupsByKey.get(parentKey);
    if (existing) {
      existing.items.push(item);
      if (parent && Number.isFinite(parent.sortOrder)) existing.sortOrder = parent.sortOrder;
      return;
    }
    groupsByKey.set(parentKey, {
      key: parentKey,
      label: parentLabel,
      iconName: parentIconName,
      sortOrder: parent?.sortOrder ?? candidate.groupSortOrder ?? index,
      items: [item]
    });
  });

  const stableSort = <T extends { sortOrder: number; key?: string; menuKey?: string }>(items: T[]) =>
    items.sort((left, right) => left.sortOrder - right.sortOrder
      || (left.key ?? left.menuKey ?? "").localeCompare(right.key ?? right.menuKey ?? ""));
  stableSort(standalone);
  const groups = [...groupsByKey.values()].sort((left, right) => left.sortOrder - right.sortOrder || left.key.localeCompare(right.key));
  for (const group of groups) stableSort(group.items);
  const tree: MenuNavigationTreeNode[] = [];
  const groupNodes = new Map<string, MenuNavigationTreeNode>();
  const groupFor = (key: string): MenuNavigationTreeNode => {
    const existing = groupNodes.get(key); if (existing) return existing;
    const row = rows.get(key)!;
    const node: MenuNavigationTreeNode = {key, label:row.name, iconName:normalizeMenuIconName(row.icon), sortOrder:row.sortOrder, children:[]};
    groupNodes.set(key,node);
    if (row.parentKey && rows.has(row.parentKey)) groupFor(row.parentKey).children!.push(node); else tree.push(node);
    return node;
  };
  for (const item of [...standalone,...groups.flatMap(group=>group.items)]) {
    const node: MenuNavigationTreeNode = {key:item.key,label:item.label,iconName:item.iconName,sortOrder:item.sortOrder,item};
    if (item.groupKey && rows.has(item.groupKey)) groupFor(item.groupKey).children!.push(node); else tree.push(node);
  }
  const sortTree=(nodes:MenuNavigationTreeNode[])=>{stableSort(nodes);for(const node of nodes)if(node.children)sortTree(node.children);};
  sortTree(tree);
  return { standalone, groups, tree };
}
