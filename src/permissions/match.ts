import path from "node:path";

/** targetAbs 命中任一 pattern（相等或在其下）即 true。pattern 必须是绝对路径。 */
export function matchesPath(patterns: readonly string[], targetAbs: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === "") return false; // 空模式 fail-closed：不得匹配一切
    const root = path.parse(pattern).root;
    return targetAbs === pattern || targetAbs.startsWith(pattern === root ? root : pattern + path.sep);
  });
}

/** 请求集 ⊆ 授予集（每个请求路径都落在某个授予路径之内）。 */
export function isSubsetOf(requested: readonly string[], granted: readonly string[]): boolean {
  return requested.every((target) => matchesPath(granted, target));
}
