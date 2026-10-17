import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 系统内置技能目录（本文件在 src/domain → src/skills）。 */
export const FRAMEWORK_SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

export type Skill = {
  name: string;
  description: string;
  dir: string;
};

/** 读 SKILL.md 头部 YAML frontmatter 的 name / description（极简解析，不引依赖）。 */
function readFrontmatter(file: string): { name?: string; description?: string } {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const lines = raw.replace(/\r\n?/gu, "\n").split("\n");
  if ((lines[0] ?? "").trim() !== "---") return {};
  const fields: Record<string, string> = {};
  let closed = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") {
      closed = true;
      break;
    }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line);
    if (match === null) continue;
    fields[match[1]!] = match[2]!.trim().replace(/^["']|["']$/gu, "");
  }
  if (!closed) return {};
  return {
    ...(fields.name === undefined || fields.name === "" ? {} : { name: fields.name }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
  };
}

/** 一个技能目录下的技能子目录名（跳过隐藏项与 node_modules），按名字排序。 */
function skillDirNames(dir: string): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
    .map((entry) => entry.name)
    .sort();
}

/**
 * 扫描若干「技能根目录」下的 `<技能>/SKILL.md`。
 * 返回顺序 = dirs 顺序（群技能在前）→ 目录内按名字排序；同名去重（先出现者胜）。
 */
export function listSkills(dirs: string[]): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const entry of skillDirNames(dir)) {
      const skillDir = path.join(dir, entry);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const meta = readFrontmatter(skillFile);
      const name = meta.name ?? entry;
      if (seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, description: meta.description ?? "", dir: skillDir });
    }
  }
  return skills;
}

/**
 * 渲染为注入 instructions 的技能目录；无技能时返回空串。
 * 遵循 Agent Skills 标准：目录给出 name / description / location，正文由 agent 按需用 read 激活。
 */
export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "## 可用技能",
    "当任务匹配某技能的描述时，用 read 工具读取其「位置」给出的 SKILL.md 全文，再按其指引执行；技能内的相对路径相对 SKILL.md 所在目录解析。",
    "",
  ];
  for (const skill of skills) {
    const location = path.join(skill.dir, "SKILL.md");
    const label = skill.description === "" ? skill.name : `${skill.name}：${skill.description}`;
    lines.push(`- ${label}　位置：${location}`);
  }
  return lines.join("\n");
}
