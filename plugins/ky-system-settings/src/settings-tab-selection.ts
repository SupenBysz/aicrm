/** Resolve only among authorized sections; caller uses replace for canonical URLs. */
export function resolveSettingsTab(requested: string | null, allowed: readonly string[]) {
  if(!allowed.length)return null;
  const mapped=requested==="parameters"||requested==="settings"?"settings":requested;
  const key=mapped&&allowed.includes(mapped)?mapped:allowed[0];
  return {key,urlValue:key==="settings"?"parameters":key};
}
