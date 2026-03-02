# MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建最小可行产品，验证"项目驱动模式"的核心业务逻辑

**Architecture:** 客户端-服务端分离架构，MVP阶段先做单体应用验证核心流程

**Tech Stack:** 待定（需根据团队技术栈选择，建议Electron/Tauri + Node.js或Go后端）

---

## MVP核心范围

基于PRD V1.2 + 头脑风暴决策，MVP聚焦验证：

1. **人才市场** - 分类浏览、获取AI员工
2. **项目群** - 创建群、邀请员工、下达目标
3. **任务协作** - AI自动拆解、任务执行
4. **甘特图看板** - 任务进度可视化

MVP暂不包含：团队整编、自建MCP/SKILLS、分层记忆、Token监控

---

## Task 1: 项目基础架构搭建

**Step 1: 确定技术栈并初始化项目**

根据PRD"云端分离"架构，选择：

| 组件 | 推荐技术 | 理由 |
|------|----------|------|
| Client | Tauri (Rust + Web) | 轻量、跨平台、性能好 |
| Server | Node.js/Express 或 Go | 快速原型、AI集成方便 |
| AI接入 | OpenAI API (GPT-4o) | 主流、易用 |

**Step 2: 创建项目结构**

```bash
# 建议目录结构
/aitem-os
├── client/          # Tauri前端
│   ├── src/
│   │   ├── components/   # UI组件
│   │   ├── pages/         # 页面
│   │   ├── stores/        # 状态管理
│   │   └── styles/
│   └── tauri.conf.json
├── server/          # 后端服务
│   ├── src/
│   │   ├── routes/        # API路由
│   │   ├── services/     # 业务逻辑
│   │   ├── models/       # 数据模型
│   │   └── ai/           # AI接入层
│   └── package.json
└── docs/
    └── plans/
```

**Step 3: Commit**

```bash
git init
git add .
git commit -m "feat: 初始化项目结构"
```

---

## Task 2: 人才市场 - 基础展示

**Goal:** 实现分类目录浏览，获取AI员工到本地

**Step 1: 设计数据结构**

在 `server/src/models/` 创建AI员工模型：

```typescript
// server/src/models/ai-employee.ts
export interface AIEmployee {
  id: string;
  name: string;
  role: 'developer' | 'designer' | 'operator' | 'analyst';
  description: string;
  skills: string[];        // SKILLS技能标签
  mcpTools: string[];      // MCP工具能力
  systemPrompt: string;    // 预制专业Prompt
  model: string;           // 底层模型
}
```

**Step 2: 创建模拟数据**

```typescript
// server/src/data/mock-employees.ts
import { AIEmployee } from '../models/ai-employee';

export const mockEmployees: AIEmployee[] = [
  {
    id: 'dev-001',
    name: '小王',
    role: 'developer',
    description: '全栈开发专家，擅长React、Node.js',
    skills: ['前端开发', '后端开发', 'API设计'],
    mcpTools: ['code-executor', 'file-access'],
    systemPrompt: '你是一位专业的全栈开发工程师...',
    model: 'gpt-4o'
  },
  {
    id: 'des-001',
    name: '小美',
    role: 'designer',
    description: 'UI/UX设计师，擅长移动端设计',
    skills: ['UI设计', 'UX优化', '品牌设计'],
    mcpTools: ['image-generator'],
    systemPrompt: '你是一位专业的UI/UX设计师...',
    model: 'gpt-4o'
  }
];
```

**Step 3: 创建API接口**

```typescript
// server/src/routes/talent.ts
import { Router } from 'express';
import { mockEmployees } from '../data/mock-employees';

const router = Router();

router.get('/employees', (req, res) => {
  const { role } = req.query;
  if (role) {
    return res.json(mockEmployees.filter(e => e.role === role));
  }
  res.json(mockEmployees);
});

router.get('/employees/:id', (req, res) => {
  const employee = mockEmployees.find(e => e.id === req.params.id);
  if (!employee) {
    return res.status(404).json({ error: '员工不存在' });
  }
  res.json(employee);
});

export default router;
```

**Step 4: 前端展示**

创建 `client/src/pages/TalentMarket.tsx`:

```tsx
import { useState, useEffect } from 'react';

interface Employee {
  id: string;
  name: string;
  role: string;
  description: string;
}

export function TalentMarket() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>('');

  useEffect(() => {
    fetch(`/api/employees${selectedRole ? `?role=${selectedRole}` : ''}`)
      .then(res => res.json())
      .then(setEmployees);
  }, [selectedRole]);

  return (
    <div className="talent-market">
      <div className="role-filter">
        {['developer', 'designer', 'operator', 'analyst'].map(role => (
          <button
            key={role}
            onClick={() => setSelectedRole(role === selectedRole ? '' : role)}
            className={selectedRole === role ? 'active' : ''}
          >
            {role}
          </button>
        ))}
      </div>
      <div className="employee-list">
        {employees.map(emp => (
          <div key={emp.id} className="employee-card">
            <h3>{emp.name}</h3>
            <p>{emp.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Step 5: 测试验证**

```bash
# 启动后端
curl http://localhost:3000/api/employees
# 预期返回员工列表

# 启动前端
# 访问人才市场页面，确认分类筛选和列表展示正常
```

**Step 6: Commit**

```bash
git add server/src/ client/src/
git commit -m "feat: 添加人才市场基础功能"
```

---

## Task 3: 项目群 - 创建与任务下达

**Goal:** 创建项目群，输入项目目标，AI自动拆解任务

**Step 1: 项目群数据模型**

```typescript
// server/src/models/project.ts
export interface Project {
  id: string;
  name: string;
  goal: string;           // 用户输入的项目目标
  members: string[];      // AI员工ID列表
  tasks: Task[];
  createdAt: Date;
}

export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  assignee: string;       // AI员工ID
  startDate?: Date;
  endDate?: Date;
}
```

**Step 2: AI任务拆解服务**

```typescript
// server/src/services/task-decomposition.ts
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function decomposeGoal(goal: string, members: string[]): Promise<Task[]> {
  const memberNames = members.join(', ');
  
  const prompt = `
用户项目目标: ${goal}
项目成员: ${memberNames}

请将项目目标拆解为具体任务列表，返回JSON数组格式:
[{"title": "任务名称", "assignee": "成员名称或角色"}]

只返回JSON，不要其他内容。
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7
  });

  const content = response.choices[0].message.content;
  try {
    return JSON.parse(content);
  } catch {
    return [];
  }
}
```

**Step 3: 创建项目群API**

```typescript
// server/src/routes/project.ts
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { projects } from '../data/projects';
import { decomposeGoal } from '../services/task-decomposition';

const router = Router();

router.post('/', async (req, res) => {
  const { name, goal, members } = req.body;
  
  const tasks = await decomposeGoal(goal, members);
  
  const project: Project = {
    id: uuid(),
    name,
    goal,
    members,
    tasks: tasks.map((t, i) => ({
      ...t,
      id: uuid(),
      status: 'pending'
    })),
    createdAt: new Date()
  };
  
  projects.push(project);
  res.json(project);
});

router.get('/:id', (req, res) => {
  const project = projects.find(p => p.id === req.params.id);
  if (!project) {
    return res.status(404).json({ error: '项目不存在' });
  }
  res.json(project);
});

export default router;
```

**Step 4: 前端项目群页面**

```tsx
// client/src/pages/ProjectGroup.tsx
import { useState } from 'react';

export function ProjectGroup() {
  const [projectName, setProjectName] = useState('');
  const [projectGoal, setProjectGoal] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  const handleCreate = async () => {
    const project = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: projectName,
        goal: projectGoal,
        members: selectedMembers
      })
    }).then(res => res.json());
    
    // 跳转到项目详情页
  };

  return (
    <div className="create-project">
      <input
        placeholder="项目名称"
        value={projectName}
        onChange={e => setProjectName(e.target.value)}
      />
      <textarea
        placeholder="输入项目目标，如：帮我调研折叠屏手机市场，生成报告"
        value={projectGoal}
        onChange={e => setProjectGoal(e.target.value)}
      />
      <button onClick={handleCreate}>创建项目</button>
    </div>
  );
}
```

**Step 5: 测试**

```bash
# 创建项目
curl -X POST http://localhost:3000/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "市场调研", "goal": "调研折叠屏手机市场", "members": ["小王", "小美"]}'
# 预期返回包含tasks数组的项目
```

**Step 6: Commit**

```bash
git add server/src/ client/src/
git commit -m "feat: 添加项目群创建和AI任务拆解功能"
```

---

## Task 4: 甘特图看板

**Goal:** 展示项目任务进度，按时间线呈现

**Step 1: 安装甘特图库**

```bash
cd client
npm install gantt-task-react
```

**Step 2: 创建甘特图组件**

```tsx
// client/src/components/GanttChart.tsx
import { gantt } from 'gantt-task-react';
import "gantt-task-react/dist/index.css";

interface Task {
  id: string;
  name: string;
  start: Date;
  end: Date;
  progress: number;
}

export function GanttChart({ tasks }: { tasks: Task[] }) {
  const ganttTasks = tasks.map(t => ({
    ...t,
    type: 'task',
    styles: { progressColor: '#4CAF50', progressSelectedColor: '#45a049' }
  }));

  return (
    <div className="gantt-container">
      <gantt tasks={ganttTasks} />
    </div>
  );
}
```

**Step 3: 集成到项目详情页**

```tsx
// client/src/pages/ProjectDetail.tsx
import { useState, useEffect } from 'react';
import { GanttChart } from '../components/GanttChart';

export function ProjectDetail({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then(res => res.json())
      .then(setProject);
  }, [projectId]);

  if (!project) return <div>加载中...</div>;

  // 转换任务为甘特图格式
  const ganttTasks = project.tasks.map((task: any) => ({
    id: task.id,
    name: task.title,
    start: new Date(),  // MVP简化：使用当前时间
    end: new Date(Date.now() + 86400000), // 假设1天
    progress: task.status === 'completed' ? 100 : 0
  }));

  return (
    <div className="project-detail">
      <h2>{project.name}</h2>
      <p>目标: {project.goal}</p>
      <GanttChart tasks={ganttTasks} />
    </div>
  );
}
```

**Step 4: Commit**

```bash
git add client/src/
git commit -m "feat: 添加甘特图看板功能"
```

---

## Task 5: 集成测试与MVP验证

**Step 1: 端到端测试**

1. 打开前端，创建项目群
2. 输入项目目标："帮我调研折叠屏手机市场"
3. 验证AI返回了任务拆解
4. 打开甘特图看板，验证任务显示

**Step 2: Commit**

```bash
git add .
git commit -m "test: MVP端到端验证"
```

---

## 执行方式

**Plan complete and saved to `docs/plans/2026-03-02-mvp-implementation.md`.**

**Two execution options:**

1. **Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

2. **Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?**
