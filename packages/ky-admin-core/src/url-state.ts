import type { ListQueryState } from "./index";

export const defaultListQueryState: ListQueryState = {
  page: 1,
  pageSize: 10,
  sortBy: "updatedAt",
  sortOrder: "desc"
};

export function resetListQueryState(currentState?: Pick<ListQueryState, "pageSize">): ListQueryState {
  return {
    ...defaultListQueryState,
    pageSize: currentState?.pageSize ?? defaultListQueryState.pageSize
  };
}

export function hasListQueryFilters(state: ListQueryState): boolean {
  return Boolean(state.keyword || state.status || state.type);
}

export function readListQueryState(searchParams: URLSearchParams): ListQueryState {
  return {
    page: readPositiveNumber(searchParams.get("page"), defaultListQueryState.page),
    pageSize: readPositiveNumber(searchParams.get("pageSize"), defaultListQueryState.pageSize),
    sortBy: searchParams.get("sortBy") ?? defaultListQueryState.sortBy,
    sortOrder: searchParams.get("sortOrder") === "asc" ? "asc" : defaultListQueryState.sortOrder,
    keyword: searchParams.get("keyword") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    type: searchParams.get("type") ?? undefined
  };
}

export function listQueryStateToSearchParams(state: ListQueryState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("page", String(state.page));
  params.set("pageSize", String(state.pageSize));
  if (state.sortBy) params.set("sortBy", state.sortBy);
  if (state.sortOrder) params.set("sortOrder", state.sortOrder);
  if (state.keyword) params.set("keyword", state.keyword);
  if (state.status) params.set("status", state.status);
  if (state.type) params.set("type", state.type);
  return params;
}

export function writeListQueryState(state: ListQueryState): string {
  return listQueryStateToSearchParams(state).toString();
}

export function writeListApiQueryState(state: ListQueryState): string {
  return listQueryStateToSearchParams(state).toString();
}

function readPositiveNumber(rawValue: string | null, fallback: number): number {
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}
