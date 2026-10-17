import type { AccessContext } from "../domain/access-control.ts";
import type { Relation } from "../domain/types.ts";

export type ModelRef = { provider: string; modelId: string };

export type ConversationSpec = {
  cwd: string;
  instructions: string;
  model: ModelRef;
  thinkingLevel?: string;
  access: AccessContext;
  /** 该会话额外选择的 MCP 扩展名（随会话快照固化；缺省 = 不挂 MCP）。 */
  mcpExtensions?: readonly string[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Pi entry kind（如 pi.user / pi.assistant / chat.message）。 */
  kind?: string;
  /** entry data（如 { author: "boss", roomMessageId }）。 */
  data?: unknown;
};

export type InputMeta = {
  /** entry kind；缺省 pi.user。编排传 "chat.message"。 */
  kind?: string;
  /** entry data（如 { author: "boss", roomMessageId }）。 */
  data?: unknown;
  /** Pi 会话内去重键（重试不产生重复输入）。 */
  requestId?: string;
};

/** 己方发言条目：以 assistant 形态落一条消息（不触发模型回答）。 */
export type PostEntry = {
  /** entry kind（如 chat.message）。 */
  kind: string;
  /** 消息文本。 */
  text: string;
  /** entry data（如 { author: selfId }）。 */
  data?: unknown;
};

/**
 * 一条输入的受理状态（Pi submission 生命周期）：
 * queued（已受理、还没进 transcript，即「排队中」）→ placed（进了 transcript）→ done（已答复）/ unanswered（撤回、中断等终止）。
 */
export type SubmissionStatus = "queued" | "placed" | "done" | "unanswered";

/** submit 的受理回执：submission id + 受理时的状态。 */
export type SubmissionReceipt = { id: string; status: SubmissionStatus };

/** 一条会话的实际运行信息（展示层用；模型 / 思考强度均为会话快照值）。 */
export type SessionUsage = {
  model: ModelRef;
  /** 会话快照中请求的思考档位（未配置时为 Pi 默认档；provider 发送前可能按能力表 clamp）。 */
  thinkingLevel: string;
  /** 该模型支持的思考档位（pi-ai 模型目录）；模型目录缺失 → undefined（无法判定）。 */
  supportedThinkingLevels?: string[];
  /** 已用上下文 tokens（估算值）。 */
  contextUsed: number;
  /** 模型上下文窗口；模型目录缺失 → undefined。 */
  contextWindow?: number;
};

export type HarnessEvent =
  | { type: "delta"; convId: string; channel: "text" | "thinking"; delta: string }
  | { type: "message"; convId: string; message: ChatMessage }
  | { type: "run"; convId: string; phase: "start" | "end" }
  | { type: "tool"; convId: string; name: string; phase: "start" | "end" }
  | { type: "failed"; convId: string; message: string; kind: string }
  /** 输入受理状态变化（排队 → 落盘 → 结束）；待发队列据此展示与撤下。 */
  | { type: "submission"; convId: string; id: string; status: SubmissionStatus };

export interface HarnessPort {
  open(): Promise<void>;
  close(): Promise<void>;
  /** 新建会话：spec 在创建事务内原子固化（快照）。返回 convId。 */
  startSession(spec: ConversationSpec): Promise<string>;
  /** 读回既有会话并注册 access（绝不重配置）；不存在返回 false。 */
  attach(convId: string, access: AccessContext): Promise<boolean>;
  /** 会话所属（员工 + 关系）；未注册返回 undefined。工具据此判断"我在哪、我是谁"。 */
  sessionInfo(convId: string): { selfId: string; relation: Relation } | undefined;
  /** 会话实际在用的模型 / 思考强度 / 上下文用量 / 模型窗口（展示层数据）。 */
  sessionUsage(convId: string): Promise<SessionUsage>;
  /** 阻塞发送（测试与非流式场景）；编排走 submit + watch（Task 5）。 */
  send(convId: string, text: string): Promise<ChatMessage>;
  /** 提交输入，不等待回答（admission 完成即返回，带上受理回执：id + 状态）。 */
  submit(convId: string, text: string, meta?: InputMeta): Promise<SubmissionReceipt>;
  /**
   * 撤回一条**尚未开始**的输入（status=queued）：从待办里撤掉、不投递给员工。
   * 已经开始（placed）/ 已结束的返回 false —— 那属于「中断」语义（harness.abort）。
   */
  withdrawSubmission(convId: string, submissionId: string): Promise<boolean>;
  /**
   * 追加一条己方发言：以 assistant 形态落盘（模型视角 =「我说过的话」，不会像 user 那样引发自我回显），
   * 可见（进入房间视图）但不触发模型回答。用于员工主动发言（send_message）。
   */
  append(convId: string, entry: PostEntry): Promise<void>;
  /** 中止该会话在跑的任务并撤回排队未开始的输入；无在跑任务时为空操作。 */
  abort(convId: string): Promise<void>;
  /** 订阅该会话的归一化事件；返回退订函数。 */
  watch(convId: string, listener: (event: HarnessEvent) => void): Promise<() => Promise<void>>;
  transcript(convId: string): Promise<ChatMessage[]>;
}
