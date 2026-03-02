# MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 验证核心流程 - 群聊中@AI执行任务，AI完成后群内汇报

**Architecture:** 客户端-服务端分离架构，MVP先做单体应用验证核心流程

**Tech Stack:** 待定（建议Tauri + Node.js/Express + OpenAI API）

---

## MVP核心范围

仅跑通主流程：

1. **项目群** - 创建群聊界面
2. **AI员工** - 预设2-3个基础AI角色（开发者、分析师、文案）
3. **任务执行** - 用户@AI下达任务，AI独立完成
4. **群内汇报** - AI完成后在群里返回结果

暂不包含：人才市场、甘特图看板、任务拆解、MCP/SKILLS、分层记忆

---

## Task 1: 项目基础架构搭建

**Step 1: 确定技术栈**

| 组件 | 推荐技术 |
|------|----------|
| Client | Tauri (Rust + Web) |
| Server | Node.js/Express |
| AI | OpenAI API (GPT-4o) |

**Step 2: 创建项目结构**

```
/aitem-os
├── client/          # Tauri前端
│   └── src/
└── server/          # 后端服务
    └── src/
```

**Step 3: Commit**

```bash
git add .
git commit -m "feat: 初始化项目结构"
```

---

## Task 2: AI员工基础模型

**Step 1: 定义AI员工**

```typescript
// server/src/models/ai-employee.ts
export interface AIEmployee {
  id: string;
  name: string;
  role: string;
  description: string;
  systemPrompt: string;
}
```

**Step 2: 创建预设AI员工**

```typescript
// server/src/data/preset-employees.ts
export const presetEmployees = [
  {
    id: 'dev-001',
    name: '小王',
    role: 'developer',
    description: '全栈开发专家',
    systemPrompt: '你是一位专业的全栈开发工程师。你收到任务后会直接执行代码，完成后简洁汇报结果。'
  },
  {
    id: 'analyst-001',
    name: '分析员',
    role: 'analyst',
    description: '数据分析师',
    systemPrompt: '你是一位专业的数据分析师。你会搜索和分析数据，完成后给出结论和建议。'
  },
  {
    id: 'writer-001',
    name: '文案员',
    role: 'writer',
    description: '内容创作专家',
    systemPrompt: '你是一位专业的内容创作者。你会撰写文案、报告等，完成后简洁汇报。'
  }
];
```

**Step 3: Commit**

```bash
git add server/src/
git commit -m "feat: 添加预设AI员工模型"
```

---

## Task 3: 群聊系统 - 后端

**Step 1: 消息模型**

```typescript
// server/src/models/message.ts
export interface Message {
  id: string;
  projectId: string;
  sender: string;      // 用户ID 或 AI员工ID
  content: string;    // 消息内容
  timestamp: Date;
}
```

**Step 2: 消息API**

```typescript
// server/src/routes/chat.ts
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { presetEmployees } from '../data/preset-employees';

const router = Router();

// 项目消息存储（内存 MVP）
const projectMessages: Map<string, Message[]> = new Map();

// 发送消息
router.post('/:projectId/messages', async (req, res) => {
  const { projectId } = req.params;
  const { sender, content } = req.body;

  const message: Message = {
    id: uuid(),
    projectId,
    sender,
    content,
    timestamp: new Date()
  };

  if (!projectMessages.has(projectId)) {
    projectMessages.set(projectId, []);
  }
  projectMessages.get(projectId)!.push(message);

  // 如果是用户@AI，触发AI处理
  if (sender === 'user' && content.startsWith('@')) {
    // TODO: 触发AI处理
  }

  res.json(message);
});

// 获取消息
router.get('/:projectId/messages', (req, res) => {
  const messages = projectMessages.get(req.params.projectId) || [];
  res.json(messages);
});

export default router;
```

**Step 3: Commit**

```bash
git add server/src/
git commit -m "feat: 添加群聊消息API"
```

---

## Task 4: AI任务处理服务

**Step 1: AI服务层**

```typescript
// server/src/services/ai-handler.ts
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleAIMessage(
  content: string,
  senderName: string
): Promise<string> {
  // 解析@的AI名称
  const atMatch = content.match(/@(\S+)/);
  if (!atMatch) return null;

  const targetName = atMatch[1];
  const task = content.replace(/@\S+\s*/, '').trim();

  // 查找对应AI
  const employee = presetEmployees.find(
    e => e.name === targetName || e.role === targetName
  );
  if (!employee) {
    return `未找到成员"${targetName}"`;
  }

  // 调用AI执行任务
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: employee.systemPrompt },
      { role: 'user', content: task }
    ]
  });

  return response.choices[0].message.content;
}
```

**Step 2: 集成到消息API**

```typescript
// 在 chat.ts 的 POST 消息接口中添加:
if (sender === 'user' && content.startsWith('@')) {
  const aiResponse = await handleAIMessage(content, 'user');
  
  // AI回复也是一条消息
  const aiMessage: Message = {
    id: uuid(),
    projectId,
    sender: targetName,
    content: aiResponse,
    timestamp: new Date()
  };
  projectMessages.get(projectId)!.push(aiMessage);
  
  return res.json({ userMessage: message, aiMessage });
}
```

**Step 3: Commit**

```bash
git add server/src/
git commit -m "feat: 添加AI任务处理服务"
```

---

## Task 5: 前端 - 群聊界面

**Step 1: 群聊页面**

```tsx
// client/src/pages/ChatRoom.tsx
import { useState, useEffect } from 'react';

interface Message {
  id: string;
  sender: string;
  content: string;
  timestamp: Date;
}

export function ChatRoom({ projectId }: { projectId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    // 轮询获取消息
    const interval = setInterval(() => {
      fetch(`/api/projects/${projectId}/messages`)
        .then(res => res.json())
        .then(setMessages);
    }, 2000);
    return () => clearInterval(interval);
  }, [projectId]);

  const handleSend = async () => {
    await fetch(`/api/projects/${projectId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'user',
        content: input
      })
    });
    setInput('');
  };

  return (
    <div className="chat-room">
      <div className="messages">
        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.sender === 'user' ? 'user' : 'ai'}`}>
            <span className="sender">{msg.sender}:</span>
            <span className="content">{msg.content}</span>
          </div>
        ))}
      </div>
      <div className="input-area">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="@AI成员 执行任务..."
        />
        <button onClick={handleSend}>发送</button>
      </div>
    </div>
  );
}
```

**Step 2: 项目首页**

```tsx
// client/src/pages/Home.tsx
import { useState } from 'react';

export function Home() {
  const [projectId, setProjectId] = useState<string | null>(null);

  const createProject = async () => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新项目' })
    });
    const project = await res.json();
    setProjectId(project.id);
  };

  if (!projectId) {
    return (
      <div className="home">
        <h1>AITeam OS</h1>
        <button onClick={createProject}>创建项目群</button>
      </div>
    );
  }

  return <ChatRoom projectId={projectId} />;
}
```

**Step 3: Commit**

```bash
git add client/src/
git commit -m "feat: 添加群聊前端界面"
```

---

## Task 6: 集成验证

**Step 1: 测试流程**

1. 启动后端 `npm run dev`
2. 启动前端 `npm run tauri dev`
3. 点击"创建项目群"
4. 在输入框输入: `@小王 帮我写一个Hello World的Python脚本`
5. 验证AI回复出现在群里

**Step 2: Commit**

```bash
git add .
git commit -m "test: MVP端到端验证"
```

---

## 执行方式

**Plan complete and saved to `docs/plans/2026-03-02-mvp-implementation.md`.**

**Two execution options:**

1. **Subagent-Driven (this session)** - 任务级执行，适合快速迭代

2. **Parallel Session (separate)** - 单独会话执行，适合长时间构建

**Which approach?**
