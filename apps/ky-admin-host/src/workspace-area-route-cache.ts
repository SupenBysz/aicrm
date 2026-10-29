export type WorkspaceArea = "workbench" | "manage";

export interface WorkspaceAreaLocation {
  pathname: string;
  search: string;
  hash: string;
  state?: unknown;
  key?: string;
}

export interface WorkspaceAreaRouteSnapshot<TNode> {
  pathKey: string;
  location: WorkspaceAreaLocation;
  navigationType: string;
  node: TNode;
}

export interface WorkspaceAreaRouteCache<TNode> {
  scopeKey: string;
  workbench: WorkspaceAreaRouteSnapshot<TNode> | null;
  manage: WorkspaceAreaRouteSnapshot<TNode> | null;
}

export interface WorkspaceAreaScrollMemory {
  scopeKey: string;
  activeArea: WorkspaceArea;
  positions: Record<WorkspaceArea, number>;
}

export function createWorkspaceAreaScrollMemory(scopeKey: string, activeArea: WorkspaceArea): WorkspaceAreaScrollMemory {
  return { scopeKey, activeArea, positions: { workbench: 0, manage: 0 } };
}

export function rememberWorkspaceAreaScroll(
  memory: WorkspaceAreaScrollMemory,
  scopeKey: string,
  area: WorkspaceArea,
  scrollTop: number
): WorkspaceAreaScrollMemory {
  const scoped = memory.scopeKey === scopeKey ? memory : createWorkspaceAreaScrollMemory(scopeKey, area);
  const position = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  if (scoped.positions[area] === position) return scoped;
  return { ...scoped, positions: { ...scoped.positions, [area]: position } };
}

export function activateWorkspaceAreaScroll(
  memory: WorkspaceAreaScrollMemory,
  scopeKey: string,
  area: WorkspaceArea
): { memory: WorkspaceAreaScrollMemory; scrollTop: number } {
  if (memory.scopeKey !== scopeKey) {
    return { memory: createWorkspaceAreaScrollMemory(scopeKey, area), scrollTop: 0 };
  }
  if (memory.activeArea === area) return { memory, scrollTop: memory.positions[area] };
  const next = { ...memory, activeArea: area };
  return { memory: next, scrollTop: memory.positions[area] };
}

export function workspaceAreaLocationKey(location: Pick<WorkspaceAreaLocation, "pathname" | "search" | "hash">): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function createWorkspaceAreaRouteCache<TNode>(scopeKey: string): WorkspaceAreaRouteCache<TNode> {
  return { scopeKey, workbench: null, manage: null };
}

export function rememberWorkspaceAreaRoute<TNode>(
  cache: WorkspaceAreaRouteCache<TNode>,
  scopeKey: string,
  area: WorkspaceArea,
  snapshot: WorkspaceAreaRouteSnapshot<TNode>
): WorkspaceAreaRouteCache<TNode> {
  const scoped = cache.scopeKey === scopeKey ? cache : createWorkspaceAreaRouteCache<TNode>(scopeKey);
  const previous = scoped[area];
  if (previous?.pathKey === snapshot.pathKey) {
    if (previous.location.key === snapshot.location.key && previous.location.state === snapshot.location.state && previous.navigationType === snapshot.navigationType) return scoped;
    return { ...scoped, [area]: { ...snapshot, node: previous.node } };
  }
  return { ...scoped, [area]: snapshot };
}

export function selectWorkspaceAreaRoute<TNode>(input: {
  cache: WorkspaceAreaRouteCache<TNode>;
  scopeKey: string;
  area: WorkspaceArea;
  activeArea: WorkspaceArea;
  activePathKey: string;
  liveSnapshot: WorkspaceAreaRouteSnapshot<TNode> | null;
  isAllowed?: (snapshot: WorkspaceAreaRouteSnapshot<TNode>) => boolean;
}): WorkspaceAreaRouteSnapshot<TNode> | null {
  const cached = input.cache.scopeKey === input.scopeKey ? input.cache[input.area] : null;
  if (input.area !== input.activeArea) return cached && (!input.isAllowed || input.isAllowed(cached)) ? cached : null;
  if (cached?.pathKey === input.activePathKey) {
    if (!input.isAllowed || input.isAllowed(cached)) return cached;
    return input.liveSnapshot;
  }
  return input.liveSnapshot;
}
