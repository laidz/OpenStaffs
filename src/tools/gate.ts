import os from "node:os";
import path from "node:path";
import {
  AGENT_CONFIG_SUFFIX,
  DEPARTMENT_CONFIG_NAME,
  PROJECT_CONFIG_SUFFIX,
  SPACE_CONFIG_NAME,
} from "../config/naming.ts";
import { parseConfigFields } from "../config/schema.ts";
import type { AccessContext } from "../domain/access-control.ts";
import { checkAttenuation } from "../permissions/attenuation.ts";
import { pathsFor } from "../permissions/effective.ts";
import { matchesPath } from "../permissions/match.ts";

/** Pi 工具名 → 权限工具名。**新文件系统工具 = 在此加一条**（D28 同一套逻辑）。 */
export const TOOL_PERMISSION_KEYS: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "write",
  bash: "bash",
};

// 配置名常量统一小写（识别大小写不敏感；R-P3-18 / R-P3-21），避免每次比对重复归一。
const SPACE_CONFIG_LOWER = SPACE_CONFIG_NAME.toLowerCase();
const DEPARTMENT_CONFIG_LOWER = DEPARTMENT_CONFIG_NAME.toLowerCase();
const AGENT_SUFFIX_LOWER = AGENT_CONFIG_SUFFIX.toLowerCase();
const PROJECT_SUFFIX_LOWER = PROJECT_CONFIG_SUFFIX.toLowerCase();

/**
 * 人定义文件 `*.agent.config.json`（大小写不敏感）——**唯一硬保护**（spec §6 / D8：
 * 人不可写任何 agent 配置，含自己的；主管写下级定义走框架的授权路径，不走人的 write 工具）。
 * 大小写不敏感的原因：目的卷（如 macOS 默认 APFS）可能不敏感，`DAVE.AGENT.CONFIG.JSON`
 * 会覆盖 `dave.agent.config.json`。
 */
export function isAgentConfigName(base: string): boolean {
  return base.toLowerCase().endsWith(AGENT_SUFFIX_LOWER);
}

/**
 * 配置文件**识别**（space / department / project / agent），大小写不敏感（R-P3-18 / R-P3-21）：
 * 决定 `edit` 引导（改用 write）与 `write` 的 JSON + attenuation 校验。
 * 自带 `toLowerCase` 归一，**不复用**大小写敏感的 `isConfigFileName`——否则大小写变体在
 * 不敏感卷上会漏到普通路径检查、绕过 attenuation（提权）。
 */
export function isConfigNameIgnoringCase(base: string): boolean {
  const name = base.toLowerCase();
  return (
    name === SPACE_CONFIG_LOWER ||
    name === DEPARTMENT_CONFIG_LOWER ||
    name.endsWith(AGENT_SUFFIX_LOWER) ||
    name.endsWith(PROJECT_SUFFIX_LOWER)
  );
}

/** 硬保护（仅 `*.agent.config.json`）的拦截文案；target 为调用方传入的原始路径。 */
export function agentConfigBlockMessage(target: string): string {
  return `访问控制：不可写 "${target}"（员工配置只能由上级主管或老板写）`;
}

/** 越界写拦截文案（引导走授权申请通道）。 */
export function writeBlockMessage(target: string): string {
  return `访问控制：不可写 "${target}"。如确需写入，可调用 request_permission 工具申请授权（异步，批准后会收到通知）。`;
}

/** 越界读拦截文案（read 专属，避免误导向"写"）。 */
export function readBlockMessage(target: string): string {
  return `访问控制：不可读 "${target}"。如确需访问，可调用 request_permission 工具申请授权（异步，批准后会收到通知）。`;
}

/** bash 命令里出现配置文件名的拦截文案（引导改用 write 工具，走 JSON + attenuation 校验）。 */
export function bashConfigBlockMessage(token: string): string {
  return `访问控制：命令里出现配置文件 "${token}"。请改用 write 工具整体写入（会做 JSON + attenuation 校验）；bash 不得写配置文件。`;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 从 bash 命令里粗取路径（绝对 / `~` / 含 `/` 的 token）；**软边界，非沙箱**。 */
export function bashPathsIn(command: string, cwd: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/[\s;&|<>()`"'=]+/u)) {
    const token = raw.trim();
    if (token === "" || token.startsWith("-")) continue;
    if (!token.startsWith("/") && !token.startsWith("~") && !token.includes("/")) continue;
    const resolved =
      token === "~" ? os.homedir() : token.startsWith("~/") ? path.join(os.homedir(), token.slice(2)) : path.resolve(cwd, token);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * 从 bash 命令里找出**任意**配置文件名的出现（大小写不敏感，含无 `/` 的裸相对文件名）。
 * 用于 fail-closed：config 自提权必须走 write 工具的 JSON + attenuation 校验，bash 一律不得碰配置。
 */
export function configNamesIn(command: string): string | undefined {
  for (const raw of command.split(/[\s;&|<>()`"'=]+/u)) {
    const token = raw.trim();
    if (token === "") continue;
    if (isConfigNameIgnoringCase(path.basename(token))) return token;
  }
  return undefined;
}

/** 单点闸门：beforeTool 调用它决定是否 block。非文件系统工具一律放行。 */
export function gateToolCall(
  access: AccessContext,
  call: { name: string; arguments?: unknown },
): { block: string } | undefined {
  const key = TOOL_PERMISSION_KEYS[call.name];
  if (key === undefined) return undefined;
  const args = asObject(call.arguments);
  // R-P3-4：配置名保护是**写专属**（`read` 只按自己的有效集判定）。
  // 写类 = 映射到 write 的工具（write / edit）+ bash（可写，但只能近似判定）。
  const writing = key === "write" || call.name === "bash";

  if (call.name === "bash") {
    const command = typeof args["command"] === "string" ? args["command"] : "";
    // 写类 fail-closed：命令里出现**任何**配置文件名（space / department / project / agent，
    // 大小写不敏感，含无 `/` 的裸相对文件名）→ 拦下。否则可从 bash 覆写 `permissions` 提权
    // （D15：任何层 `permissions` 写入都必须过 attenuation；bash 无法校验，故一律引导走 write）。
    const configToken = configNamesIn(command);
    if (configToken !== undefined) {
      return {
        block: isAgentConfigName(path.basename(configToken))
          ? agentConfigBlockMessage(configToken)
          : bashConfigBlockMessage(configToken),
      };
    }
    const targets = bashPathsIn(command, access.cwd);
    const granted = pathsFor(access.permissions, "bash", access.cwd);
    const outside = targets.filter((target) => !matchesPath(granted, target));
    if (outside.length > 0) {
      return { block: `访问控制：命令里的路径不可访问（${outside.join("、")}）。如确需操作，可调用 request_permission 申请授权。` };
    }
    return undefined;
  }

  const raw = typeof args["path"] === "string" ? args["path"] : "";
  if (raw.trim() === "") return { block: "访问控制：缺少 path 参数" };
  const target = path.resolve(access.cwd, raw);
  const base = path.basename(target);

  // 硬保护：`*.agent.config.json`（spec §6 / D8 唯一硬规则，R-P3-21）——先于其余分支。
  if (writing && isAgentConfigName(base)) {
    return { block: agentConfigBlockMessage(raw) };
  }
  // 识别为配置名（大小写不敏感）后：edit → 引导整体写；write → JSON + attenuation 校验。
  if (writing && call.name === "edit" && isConfigNameIgnoringCase(base)) {
    return { block: `访问控制：配置文件的修改请用 write 整体写入（便于校验 permissions 的 attenuation）："${raw}"` };
  }
  if (writing && call.name === "write" && isConfigNameIgnoringCase(base)) {
    const content = typeof args["content"] === "string" ? args["content"] : "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { block: `访问控制：配置文件必须是合法 JSON："${raw}"` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { block: `访问控制：配置文件顶层必须是对象："${raw}"` };
    }
    const { fields } = parseConfigFields(parsed);
    const verdict = checkAttenuation(fields.permissions, path.dirname(target), access.permissions, access.cwd);
    if (!verdict.ok) {
      const detail = verdict.violations.map((item) => `${item.tool}: ${item.paths.join("、")}`).join("；");
      return { block: `访问控制：permissions 超出你的权限（attenuation 校验失败：${detail}）。不可提权授予他人。` };
    }
  }
  const granted = pathsFor(access.permissions, key, access.cwd);
  if (matchesPath(granted, target)) return undefined;
  // R-P3-24：read 越界用读专属文案，不得误导向"写"。
  return { block: key === "read" ? readBlockMessage(raw) : writeBlockMessage(raw) };
}
