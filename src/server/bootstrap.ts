import type { Workspace } from "../domain/paths.ts";
import { ensureSpaceConfig } from "../domain/space.ts";
import { ensureStaff0 } from "../domain/staff0.ts";

export type EnsureStatus = "created" | "exists" | "failed";

export type BootstrapResult = {
  /** 本次是否新建了空间（以 space.config.json 的物化为准，D32）。 */
  newSpace: boolean;
  spaceConfig: EnsureStatus;
  staff0: EnsureStatus;
};

/** 逐项兜错：单项失败（只读目录等）记 failed，不打断启动。 */
function attempt(run: () => "created" | "exists"): EnsureStatus {
  try {
    return run();
  } catch {
    return "failed";
  }
}

/**
 * 启动探测（P4）：新建空间物化 `space.config.json`（D32）+ 首次启动自动建 Staff0（§8）。
 * 幂等、不覆盖、不抛（失败项记 `"failed"`）。
 */
export function ensureSpace(ws: Workspace): BootstrapResult {
  const spaceConfig = attempt(() => ensureSpaceConfig(ws));
  const staff0 = attempt(() => ensureStaff0(ws));
  return { newSpace: spaceConfig === "created", spaceConfig, staff0 };
}
