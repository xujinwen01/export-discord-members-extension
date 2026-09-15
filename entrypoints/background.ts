// ============================================================
// background.ts —— Discord Member Exporter 的 service worker
//
// 从 dme-deobfuscated/background.js 反混淆 + 补全 + 加类型。
// 结构：
//   1. Token / 上下文处理   —— cleanToken / buildContext / stripAuth
//   2. 前缀枚举 + 成员解析    —— PrefixPlanner（BFS 前缀）/ parseMember
//   3. Gateway 客户端        —— Fast（Opcode 14）/ Deep（Opcode 8）两种拉成员方式
//   4. 配额 + 导出 + 主调度    —— REST 拉资料 / IndexedDB 存结果 / 消息路由
// ============================================================

import { PaymentClient } from "../core/payment-client";
import * as pakoModule from 'pako';

const pako = pakoModule;

// zlib-stream 是贯穿整个连接的一条连续 zlib 流，解压器必须在连接期间一直存活。
// pako 的 `result` 只在流结束（Z_FINISH）时填充，Z_SYNC_FLUSH 的输出走 onData，
// 所以这里用 onData 把每条消息吐出的字节收集到 pendingChunks，再逐条消费。
let inflater = new pako.Inflate();
let pendingChunks: Uint8Array[] = [];
inflater.onData = (chunk) => { pendingChunks.push(chunk); };

/** 每个新连接开始时重置解压器与待处理缓冲区 */
// function resetInflater(): void {
//   inflater = new pako.Inflate();
//   pendingChunks = [];
//   inflater.onData = (chunk) => { pendingChunks.push(chunk); };
// }

// /** 处理一条 gateway 消息：解压（zlib-stream）→ JSON 解析 → 回调 */
// async function receiveGatewayMessage(
//   event: { data: unknown },
//   onMessage: (msg: GatewayMessage) => void,
// ): Promise<void> {
//   let buf: ArrayBuffer;
//   const data = event.data;
//   if (data instanceof ArrayBuffer) {
//     buf = data;
//   } else if (data instanceof Blob) {
//     buf = await data.arrayBuffer();
//   } else {
//     onMessage(JSON.parse(String(data)));
//     return;
//   }

//   inflater.push(new Uint8Array(buf), pako.Z_SYNC_FLUSH);
//   if (inflater.err) {
//     console.error('解压失败:', inflater.msg);
//     return;
//   }

//   // 拼接本次 flush 的输出得到这条消息的明文，然后清空待处理缓冲区
//   let total = 0;
//   for (const c of pendingChunks) total += c.length;
//   const merged = new Uint8Array(total);
//   let off = 0;
//   for (const c of pendingChunks) { merged.set(c, off); off += c.length; }
//   pendingChunks = [];

//   try {
//     onMessage(JSON.parse(new TextDecoder('utf-8').decode(merged)));
//   } catch (e) {
//     console.warn('JSON 解析失败:', e);
//   }
// }
// ============================================================
// 类型定义
// ============================================================

/** 完整上下文（token + 服务器/频道 + 成员数），buildContext 的产物 */
interface MemberContext {
  tabId?: number;
  token: string;
  clientBuildNumber?: number;
  guildId: string;
  channelId: string;
  serverName: string;
  channelName: string;
  avatar: string;
  memberCount?: number;
  updatedAt: number;
}

/** 去掉敏感字段（token / clientBuildNumber）后、可广播/持久化的上下文 */
type PublicContext = Omit<MemberContext, "token" | "clientBuildNumber">;

/** 持久化的 Discord 凭据 */
interface StoredAuth {
  token: string;
  clientBuildNumber?: number;
  updatedAt: number;
}

/** content script 上报的原始上下文（字段可能不全） */
interface RawContext {
  token?: string;
  clientBuildNumber?: number | string;
  memberCount?: number | string;
  guildId?: string;
  channelId?: string;
  serverName?: string;
  channelName?: string;
  avatar?: string;
  tabId?: number;
  [key: string]: unknown;
}

/** Gateway 返回的成员原始结构 */
interface GatewayUser {
  id?: string | number;
  username?: string;
  discriminator?: string;
  avatar?: string | null;
}

interface GatewayMember {
  user?: GatewayUser;
  nick?: string | null;
  roles?: Array<string | number>;
  joined_at?: string | null;
  presence?: GatewayPresence;
}

interface GatewayPresence {
  user?: GatewayUser;
  activities?: Array<{ state?: string; name?: string }>;
  status?: string;
}

/** parseMember 的统一导出结构 */
interface Member {
  id: string;
  username: string;
  discriminator: string;
  nickname: string;
  avatarUrl: string;
  roles: string[];
  joinedAt: string;
  activity: string;
  status: string;
  /** REST 拉取的详细资料（enrichProfiles 后才有） */
  profile?: Profile;
}

/** 用户详细资料（profile popout 响应），结构较松散 */
type Profile = Record<string, any>;

interface GatewayOptions {
  token: string;
  guildId: string;
  channelId: string;
  clientBuildNumber?: number;
  mode?: string;
  maxMembers: number;
  signal?: AbortSignal;
  shouldPause?: () => boolean;
  shouldStop?: () => boolean;
  onStatus?: (status: string) => void;
  onProgress?: (count: number) => void;
  /** 任务 id：成员流式落盘到 member_stream 时使用 */
  taskId: string;
  /** 续跑：deep 模式前缀枚举器的断点（用于接续枚举，而不是重新开始） */
  seedCheckpoint?: PlannerCheckpoint | null;
}

/** 前缀枚举器的断点快照（超时/重连耗尽后用于续跑） */
interface PlannerCheckpoint {
  queue: string[];
  queued: string[];
  inFlight: string[];
  done: string[];
}

/** 一条 Gateway 消息（op = opcode，t = 事件名，d = 数据） */
interface GatewayMessage {
  op: number;
  s?: number;
  t?: string;
  d?: any;
}

interface Settings {
  language: string;
  theme: string;
  mode: string;
  memberLimit: number;
  fetchDetailedInfo: boolean;
  tierFilter: number;
  format: string;
  downloadAvatars: boolean;
  downloadFolder: string;
  enabledBasicColumns: string[];
  enabledDetailedColumns: string[];
  filenameTemplate: string;
}

/** pickExportSettings 的产物（导出时实际用到的设置子集） */
interface ExportSettings {
  mode: string;
  memberLimit: number;
  fetchDetailedInfo: boolean;
  tierFilter: number;
  format: string;
  downloadAvatars: boolean;
}

interface Entitlement {
  isPaidProduct: boolean;
  subscriber: boolean;
  freeLimit: number;
}

interface Stats {
  successfulExports: number;
  exportedMembers: number;
  lastExportAt: string | null;
}

type TaskPhase =
  | "collecting"
  | "details"
  | "paused"
  | "partial"
  | "complete"
  | "stopped"
  | "error";

interface Task {
  id: string;
  tabId: number;
  phase: TaskPhase | string;
  options: ExportSettings;
  requestedLimit: number;
  effectiveLimit: number;
  totalMembers: number;
  progressTarget: number;
  collected: number;
  detailCurrent: number;
  detailTotal: number;
  paused: boolean;
  limitReached: boolean;
  resultCount: number;
  error: string;
  startedAt: string;
  finishedAt: string | null;
  /** 从 runExport 开始到当前的耗时，00h 00m 00s */
  costTimes: string;
  context: PublicContext;
  source?: string;
  scheduleId?: string;
  status: string;
  completeReason: string;
  downloaded: boolean;
  filename: string;
  downloadError: string;
  stopRequested: boolean;
}

/** 去掉内部字段（stopRequested）后的任务，用于持久化与广播 */
type PublicTask = Omit<Task, "stopRequested">;

interface Schedule {
  id: string;
  enabled: boolean;
  time: string;
  target: PublicContext;
  settings: Settings;
  createdAt: string;
  updatedAt: string;
  lastExecuted?: string;
  lastResultCount?: number;
  lastError?: string;
  lastLimitReached?: boolean;
}

interface StartExportParams {
  tabId?: number | string;
  target?: PublicContext | null;
  settings: Settings;
  entitlement?: Record<string, any>;
  source?: string;
  scheduleId?: string;
  trackStart?: boolean;
  /** 续跑参数：复用上次任务 id + 已收集数量 + 前缀枚举断点 + 配额 */
  resume?: {
    taskId: string;
    collected: number;
    planner: PlannerCheckpoint | null;
    requestedLimit: number;
    effectiveLimit: number;
    limitReached: boolean;
  };
}

interface MessageSender {
  tab?: { id?: number };
}

type RuntimeMessage = {
  type?: string;
  [key: string]: any;
};

// ============================================================
// 1. Token / 上下文处理
// ============================================================

/** 清洗 token：去掉 "Bearer " 前缀、引号、空白 */
function cleanToken(raw: unknown): string {
  if (typeof raw != "string") return "";
  let v = raw.trim();
  try {
    const parsed = JSON.parse(v); // 有些地方 token 被 JSON 包了一层字符串
    if (typeof parsed == "string") v = parsed.trim();
  } catch { }
  return v.replace(/^Bearer\s+/i, "").replace(/^"+|"+$/g, "").trim();
}

/** 汇总完整上下文（token + 服务器/频道 + 成员数），带缓存/兜底 */
function buildContext(
  tabId: number,
  context: RawContext,
  cached: MemberContext | null,
  storedAuth: StoredAuth | null,
): MemberContext {
  const token = cleanToken(context.token);
  const buildNumber = Math.floor(Number(context.clientBuildNumber || 0));
  const memberCount = Math.max(0, Math.floor(Number(context.memberCount || 0)));
  return {
    tabId,
    token: token || cached?.token || storedAuth?.token || "",
    clientBuildNumber:
      (Number.isFinite(buildNumber) && buildNumber > 0 ? buildNumber : undefined) ||
      cached?.clientBuildNumber ||
      storedAuth?.clientBuildNumber,
    guildId: String(context.guildId || cached?.guildId || ""),
    channelId: String(context.channelId || cached?.channelId || ""),
    serverName: String(context.serverName || cached?.serverName || ""),
    channelName: String(context.channelName || cached?.channelName || ""),
    avatar: String(context.avatar || cached?.avatar || ""),
    memberCount: memberCount || cached?.memberCount || undefined,
    updatedAt: Date.now(),
  };
}

/** 是否有明确的导出目标（服务器 + 频道） */
function hasTarget(context?: Pick<MemberContext, "guildId" | "channelId"> | null): boolean {
  return !!(context?.guildId && context?.channelId);
}

/** 去掉敏感字段（token / clientBuildNumber），用于广播给 UI */
function stripAuth(context: MemberContext): PublicContext {
  const { token, clientBuildNumber, ...rest } = context;
  return rest;
}

// ============================================================
// 2. 前缀枚举 + 成员解析
// ============================================================

/** 前缀枚举字符集 + 最大长度 */
const PREFIX_CHARSET = [..."aeiourstnlcmpdbhgywvfjzxq0123456789._-"];
const MAX_PREFIX_LENGTH = 32;

/** 前缀调度器：BFS 枚举所有可能的前缀，追踪排队/进行中/完成状态 */
class PrefixPlanner {
  limit: number;                 // 单个前缀最多返回的成员数（>=limit 说明需要扩展前缀）
  queue: string[] = [];          // 待查询的前缀队列
  queued = new Set<string>();    // 已在队列中的前缀
  inFlight = new Set<string>();  // 已发出请求、等待 GUILD_MEMBERS_CHUNK 的前缀
  done = new Set<string>();      // 已完成（查完/丢弃）的前缀

  constructor(limit = 100) {
    this.limit = limit;
  }

  seed(): void {
    for (const c of PREFIX_CHARSET) this.enqueue(c);
  }

  enqueue(prefix: string): void {
    if (this.queued.has(prefix) || this.inFlight.has(prefix) || this.done.has(prefix)) return;
    this.queue.push(prefix);
    this.queued.add(prefix);
  }

  next(): string | null {
    const prefix = this.queue.shift();
    if (prefix == null) return null;
    this.queued.delete(prefix);
    this.inFlight.add(prefix);
    return prefix;
  }

  /** 某个前缀查完：若返回数达上限且前缀还短，就扩展一位继续枚举 */
  complete(prefix: string, count: number): void {
    this.inFlight.delete(prefix);
    this.done.add(prefix);
    if (count >= this.limit && prefix.length < MAX_PREFIX_LENGTH)
      for (const c of PREFIX_CHARSET) this.enqueue(prefix + c);
  }

  retry(prefix: string): void {
    this.inFlight.delete(prefix);
    this.enqueue(prefix);
  }

  abandon(prefix: string): void {
    this.inFlight.delete(prefix);
    this.done.add(prefix);
  }

  hasPendingWork(): boolean {
    return this.queue.length > 0 || this.inFlight.size > 0;
  }

  /** 导出当前枚举进度为断点快照 */
  snapshot(): PlannerCheckpoint {
    return {
      queue: [...this.queue],
      queued: [...this.queued],
      inFlight: [...this.inFlight],
      done: [...this.done],
    };
  }

  /** 从断点恢复：已 in-flight 的前缀尚未收到最终 chunk，回退到队列重查 */
  restore(cp: PlannerCheckpoint): void {
    this.done = new Set(cp.done || []);
    this.inFlight = new Set();
    this.queue = [];
    this.queued = new Set();
    const seen = new Set(this.done);
    for (const p of [...(cp.queue || []), ...(cp.inFlight || [])]) {
      if (seen.has(p)) continue;
      this.queue.push(p);
      this.queued.add(p);
      seen.add(p);
    }
  }
}

const NO_LIMIT = 2 ** 53 - 1;
const MAX_HEARTBEAT_INTERVAL = 25e3;
const HANDSHAKE_TIMEOUT = 25e3;

function resolveMaxMembers(v: number): number {
  return v > 0 ? v : NO_LIMIT;
}

/** 解析成员：把 Gateway 返回的 member + presence 统一成导出结构 */
function parseMember(member: GatewayMember, presence?: GatewayPresence): Member {
  const user = member.user || presence?.user || {};
  let embedIndex = 0;
  try {
    // Discord 默认头像按 user id 的 snowflake 取模
    embedIndex = Number(BigInt(String(user.id || "0")) >> 22n) % 6;
  } catch { }
  return {
    id: String(user.id || ""),
    username: String(user.username || ""),
    discriminator: String(user.discriminator || "0"),
    nickname: String(member.nick || ""),
    avatarUrl: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${embedIndex}.png`,
    roles: Array.isArray(member.roles) ? member.roles.map(String) : [],
    joinedAt: String(member.joined_at || ""),
    activity: String(presence?.activities?.[0]?.state || presence?.activities?.[0]?.name || ""),
    status: String(presence?.status || ""),
  };
}

// ============================================================
// 3. Gateway 客户端
// ============================================================

/** Gateway 客户端基类 */
class GatewayClient {
  options: GatewayOptions;
  ws: WebSocket | null = null;
  members = new Set<string>(); // 已收集成员 id（成员本体流式落盘到 member_stream，内存只留 id）
  writer: MemberWriter;
  done = false;
  heartbeat: ReturnType<typeof setInterval> | null = null;
  overallTimer: ReturnType<typeof setTimeout> | null = null;   // 整体超时（整个导出）
  handshakeTimer: ReturnType<typeof setTimeout> | null = null; // 握手超时
  idleTimer: ReturnType<typeof setTimeout> | null = null;      // 空闲超时
  resolve: (count: number) => void = () => { };
  reject: (err: Error) => void = () => { };
  max: number;
  completeReason = "max_reached";

  constructor(options: GatewayOptions) {
    this.options = options;
    this.max = resolveMaxMembers(options.maxMembers);
    this.writer = new MemberWriter(options.taskId);
  }

  status(s: string): void {
    this.options.onStatus?.(s);
  }

  stopped(): boolean {
    return this.done || !!this.options.signal?.aborted || !!this.options.shouldStop?.();
  }

  bindAbort(): void {
    this.options.signal?.addEventListener("abort", () => this.complete("stopped"), { once: true });
  }

  startHandshakeTimeout(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => this.fail("GATEWAY_CONNECT_TIMEOUT"), HANDSHAKE_TIMEOUT);
  }

  handshakeComplete(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  startOverallTimeout(ms: number): void {
    if (this.overallTimer) clearTimeout(this.overallTimer);
    this.overallTimer = setTimeout(() => {
      if (this.options.shouldPause?.()) {
        this.startOverallTimeout(ms); // 暂停中则顺延
        return;
      }
      this.members.size ? this.complete("overall_timeout") : this.fail("GATEWAY_EXPORT_TIMEOUT");
    }, ms);
  }

  resetIdleTimeout(ms: number, reason = "GATEWAY_NO_MEMBER_DATA"): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.options.shouldPause?.()) {
        this.resetIdleTimeout(ms, reason);
        return;
      }
      this.members.size ? this.complete("idle_timeout") : this.fail(reason);
    }, ms);
  }

  send(op: number, data: any): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.done) return;
    try {
      console.log('给服务器发请求，', JSON.stringify({ op, d: data }))
      this.ws.send(JSON.stringify({ op, d: data }));
    } catch {
      this.fail("GATEWAY_SEND_FAILED");
    }
  }

  /** 构造 IDENTIFY 的 properties（模拟 Chrome 浏览器的客户端指纹） */
  identifyProperties(): Record<string, any> {
    const ua = globalThis.navigator?.userAgent || "Mozilla/5.0 Chrome/120";
    const chromeVer = ua.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] || "120";
    return {
      os: "Windows",
      browser: "Chrome",
      device: "",
      system_locale: globalThis.navigator?.language || "en-US",
      browser_user_agent: ua,
      browser_version: `${chromeVer}.0.0.0`,
      os_version: "10",
      referrer: `https://discord.com/channels/${this.options.guildId}/${this.options.channelId}`,
      referring_domain: "discord.com",
      referrer_current: "",
      referring_domain_current: "",
      release_channel: "stable",
      ...(this.options.clientBuildNumber ? { client_build_number: this.options.clientBuildNumber } : {}),
      client_event_source: null,
    };
  }

  startHeartbeat(interval: number, seqFn: () => number | null): void {
    this.stopHeartbeat();
    const beat = () => this.send(1, seqFn());
    beat();
    this.heartbeat = setInterval(beat, Math.min(Math.max(1e3, interval), MAX_HEARTBEAT_INTERVAL));
  }

  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** 去重后流式写入成员；达到上限则立即结束 */
  add(member: Member): boolean {
    if (!member.id || this.members.has(member.id) || this.members.size >= this.max) return false;
    this.members.add(member.id);
    this.writer.write(member);
    this.options.onProgress?.(this.members.size);
    if (this.members.size >= this.max) this.complete("max_reached");
    return true;
  }

  /** 续跑：把上一次已流式落盘的成员 id 读回内存去重，避免从头重新枚举 */
  async loadExistingIds(): Promise<void> {
    const ids = await readMemberIds(this.options.taskId);
    for (const id of ids) {
      if (id && this.members.size < this.max) this.members.add(id);
    }
    if (this.members.size >= this.max) this.complete("max_reached");
  }

  socketClosed(code: number): void {
    if (this.done) return;
    if (this.stopped()) return this.complete("stopped");
    if (code === 4004) return this.fail("TOKEN_INVALID"); // Discord 关闭码 4004 = token 无效
    if (this.members.size) return this.complete("socket_closed");        // 已拿到部分成员就收工
    this.fail(`GATEWAY_CLOSED_${code || 1006}`);
  }

  cleanup(): void {
    this.stopHeartbeat();
    if (this.overallTimer) clearTimeout(this.overallTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.overallTimer = null;
    this.handshakeTimer = null;
    this.idleTimer = null;
  }

  closeSocket(reason: string): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try {
        this.ws.close(1000, reason.slice(0, 120));
      } catch { }
    }
  }

  complete(reason = "max_reached"): void {
    if (this.done) return;
    this.completeReason = reason;
    this.done = true;
    this.cleanup();
    this.closeSocket("complete");
    void this.writer.flush().then(() => this.resolve(this.members.size)).catch((err) => this.reject(err));
  }

  fail(reason: string): void {
    if (this.done) return;
    if (this.members.size) return this.complete("partial_error");
    this.done = true;
    this.cleanup();
    this.closeSocket(reason);
    this.reject(Error(reason));
  }
}

/** Fast 模式：Opcode 14 (GUILD_SUBSCRIBE) 订阅频道成员列表 */
class FastGatewayClient extends GatewayClient {
  offset = 100;
  empty = 0;                                  // 连续空响应计数
  sequence: number | null = null;             // 最近一条消息的 s（用于心跳）
  requestTimer: ReturnType<typeof setTimeout> | null = null;

  async fetch(): Promise<number> {
    await this.loadExistingIds();
    if (this.done) return this.members.size;
    if (this.stopped()) {
      this.complete("stopped");
      return this.members.size;
    }
    return new Promise<number>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (this.stopped()) return this.complete("stopped");

      this.bindAbort();
      this.status("gateway_connecting");
      this.startHandshakeTimeout();
      this.startOverallTimeout(75e3);

      // resetInflater();
      // const ws = new WebSocket("wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream");
      // ws.binaryType = 'arraybuffer';
      // this.ws = ws;
      // ws.onmessage = (event) => {
      //   if (this.ws !== ws || this.done) return;
      //   void receiveGatewayMessage(event, (msg) => this.message(msg)).catch(() => {});
      // };

      let ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
      this.ws = ws
      ws.onmessage = (event) => {
        console.log('服务器给我消息了 - 收到！！！：', event)
        if (!(this.ws !== ws || this.done))
          try {
            this.message(JSON.parse(String(event.data)));
          } catch { }
      }


      ws.onclose = (event) => {
        if (this.ws === ws) this.socketClosed(event.code);
      };
      ws.onerror = () => {
        if (!this.members.size) this.fail("GATEWAY_CONNECTION_FAILED");
      };
    });
  }

  message(msg: GatewayMessage): void {
    console.log(624, msg)
    if (this.stopped()) return this.complete("stopped");
    if (typeof msg.s == "number") this.sequence = msg.s;

    if (msg.op === 10) {
      this.status("gateway_authenticating");
      this.startHeartbeat(msg.d.heartbeat_interval, () => this.sequence);
      this.identify();
    } else if (msg.op === 1) {
      this.send(1, this.sequence);
    } else if (msg.op === 7) {
      this.fail("GATEWAY_RECONNECT_REQUIRED");
    } else if (msg.op === 9) {
      this.fail("GATEWAY_SESSION_INVALID");
    } else if (msg.op === 0 && msg.t === "READY") {
      this.handshakeComplete();
      this.status("gateway_requesting_members");
      this.request([[0, 99]]);
      this.resetIdleTimeout(2e4);
    } else if (msg.op === 0 && msg.t === "GUILD_MEMBER_LIST_UPDATE") {
      this.update(msg.d);
    }
  }

  identify(): void {
    this.send(2, {
      token: this.options.token,
      large_threshold: 250,
      properties: this.identifyProperties(),
      presence: { status: "online", since: 0, activities: [], afk: false },
      compress: false,
      client_state: {
        guild_hashes: {},
        highest_last_message_id: "0",
        read_state_version: 0,
        user_guild_settings_version: -1,
      },
    });
  }

  /** 订阅指定频道的一段成员列表（按 offset 分段） */
  request(ranges: number[][]): void {
    if (this.stopped()) return this.complete("stopped");
    if (this.options.shouldPause?.()) {
      if (this.requestTimer) clearTimeout(this.requestTimer);
      this.requestTimer = setTimeout(() => {
        this.requestTimer = null;
        this.request(ranges);
      }, 400);
      return;
    }
    console.log('send')
    this.send(14, {
      guild_id: this.options.guildId,
      typing: true,
      threads: true,
      activities: true,
      members: [],
      channels: { [this.options.channelId]: ranges },
    });
  }

  /** 处理 GUILD_MEMBER_LIST_UPDATE：解析 SYNC 段，然后订阅下一批 */
  update(data: any): void {
    let added = 0;
    let synced = false;
    for (const op of data?.ops || []) {
      if (op.op !== "SYNC") continue;
      synced = true;
      for (const item of op.items || []) {
        if (!item.member) continue;
        if (this.add(parseMember(item.member, item.member.presence))) added += 1;
        if (this.done) return;
      }
    }
    if (!synced) return;

    this.resetIdleTimeout(15e3);
    this.empty = added === 0 ? this.empty + 1 : 0;
    if (this.empty >= 3) return this.complete("empty_chunks");

    const next = [this.offset, this.offset + 99];
    this.offset += 100;
    this.request([[0, 99], next]);
  }

  override cleanup(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = null;
    super.cleanup();
  }
}

/** Deep 模式：Opcode 8 (REQUEST_GUILD_MEMBERS) + 前缀枚举 */
class DeepGatewayClient extends GatewayClient {
  planner = new PrefixPlanner(100);
  pending = new Map<string, { prefix: string; count: number; timer: ReturnType<typeof setTimeout> }>();
  retries = new Map<string, number>(); // prefix → 已重试次数
  pumpTimer: ReturnType<typeof setTimeout> | null = null;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  ready = false;
  sequence: number | null = null;
  cooldown = 0;              // 限流冷却的到期时间戳
  reconnectAttempts = 0;
  consecutiveTimeouts = 0;

  async fetch(): Promise<number> {
    await this.loadExistingIds();
    if (this.done) return this.members.size;
    if (this.stopped()) {
      this.complete("stopped");
      return this.members.size;
    }
    return new Promise<number>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      if (this.stopped()) return this.complete("stopped");

      this.bindAbort();
      if (this.options.seedCheckpoint) this.planner.restore(this.options.seedCheckpoint);
      else this.planner.seed();
      this.startOverallTimeout(48e4);
      this.connect();
    });
  }

  connect(): void {
    if (this.stopped()) return this.complete("stopped");
    this.ready = false;
    this.status(this.reconnectAttempts ? "gateway_reconnecting" : "gateway_connecting");
    this.startHandshakeTimeout();

    // resetInflater();
    // const ws = new WebSocket("wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream");
    // ws.binaryType = 'arraybuffer';
    // this.ws = ws;
    // ws.onmessage = (event) => {
    //   if (this.ws !== ws || this.done) return;
    //   void receiveGatewayMessage(event, (msg) => this.message(msg)).catch(() => {});
    // };

    let ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    this.ws = ws
    ws.onmessage = (event) => {
      if (!(this.ws !== ws || this.done))
        try {
          this.message(JSON.parse(String(event.data)));
        } catch { }
    }

    ws.onclose = (event) => {
      if (this.ws !== ws || this.done) return;
      this.handshakeComplete();
      this.stopHeartbeat();
      this.ready = false;
      this.requeuePending();
      if (event.code === 4004) return this.fail("TOKEN_INVALID");
      if (this.stopped()) return this.complete("stopped");
      if (this.reconnectAttempts >= 3) {
        if (this.members.size) this.complete("reconnect_exhausted");
        else this.fail(`GATEWAY_CLOSED_${event.code || 1006}`);
        return;
      }
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.done) this.connect();
      }, Math.min(6e3, this.reconnectAttempts * 1500));
    };
    ws.onerror = () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };
  }

  message(msg: GatewayMessage): void {
    if (this.stopped()) return this.complete("stopped");
    if (typeof msg.s == "number") this.sequence = msg.s;

    if (msg.op === 10) {
      this.status("gateway_authenticating");
      this.startHeartbeat(msg.d.heartbeat_interval, () => this.sequence);
      this.send(2, {
        token: this.options.token,
        properties: this.identifyProperties(),
        compress: false,
        large_threshold: 250,
      });
    } else if (msg.op === 1) {
      this.send(1, this.sequence);
    } else if (msg.op === 7 || msg.op === 9) {
      this.ws?.close(msg.op === 9 ? 4000 : 4001, "gateway restart");
    } else if (msg.op === 0 && msg.t === "READY") {
      this.handshakeComplete();
      this.ready = true;
      this.reconnectAttempts = 0;
      this.status("gateway_deep_search");
      this.schedule();
    } else if (msg.op === 0 && msg.t === "GUILD_MEMBERS_CHUNK") {
      this.chunk(msg.d);
    } else if (msg.op === 0 && msg.t === "RATE_LIMITED") {
      this.status("gateway_rate_limited");
      this.cooldown = Date.now() + (Number(msg.d?.retry_after) || 5) * 1e3;
      this.schedule(1e3);
    }
  }

  /** 处理 GUILD_MEMBERS_CHUNK：累加成员，最后一个 chunk 到达后收尾该前缀 */
  chunk(data: any): void {
    const pending = this.pending.get(data?.nonce);
    if (!pending) return;
    const presenceById: Map<any, GatewayPresence> = new Map(
      (data.presences || []).map((p: any) => [p?.user?.id, p]),
    );
    pending.count += (data.members || []).length;
    for (const m of data.members || []) {
      this.add(parseMember(m, presenceById.get(m.user?.id)));
      if (this.done) return;
    }
    if ((data.chunk_index || 0) >= (data.chunk_count || 1) - 1) {
      clearTimeout(pending.timer);
      this.pending.delete(data.nonce);
      this.retries.delete(pending.prefix);
      this.consecutiveTimeouts = 0;
      this.planner.complete(pending.prefix, pending.count);
      this.schedule();
    }
  }

  schedule(delay = 0): void {
    if (this.pumpTimer || this.done) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, delay);
  }

  pump(): void {
    if (this.stopped()) return this.complete("stopped");
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.options.shouldPause?.()) {
      this.schedule(400);
      return;
    }
    if (Date.now() < this.cooldown) {
      this.schedule(Math.min(1e3, this.cooldown - Date.now()));
      return;
    }
    if (this.pending.size >= 4) {
      this.schedule(100);
      return;
    }
    const prefix = this.planner.next();
    if (!prefix) {
      if (this.pending.size === 0 && !this.planner.hasPendingWork()) {
        if (this.members.size) this.complete("max_reached");
        else this.fail("GATEWAY_NO_MEMBER_DATA");
      } else {
        this.schedule(100);
      }
      return;
    }
    const nonce = `dme_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => this.queryTimeout(nonce), 12e3);
    this.pending.set(nonce, { prefix, count: 0, timer });
    this.send(8, {
      guild_id: this.options.guildId,
      query: prefix,
      limit: 100,
      presences: true,
      nonce,
    });
    this.schedule(240);
  }

  queryTimeout(nonce: string): void {
    const pending = this.pending.get(nonce);
    if (!pending || this.done) return;
    this.pending.delete(nonce);
    const retries = (this.retries.get(pending.prefix) || 0) + 1;
    this.retries.set(pending.prefix, retries);
    this.consecutiveTimeouts += 1;
    if (retries <= 2) this.planner.retry(pending.prefix);
    else this.planner.abandon(pending.prefix);

    if (this.consecutiveTimeouts >= 2 && this.ws?.readyState === WebSocket.OPEN) {
      this.consecutiveTimeouts = 0;
      this.ws.close(4000, "query timeout");
      return;
    }
    this.cooldown = Date.now() + 3e3;
    this.schedule(500);
  }

  requeuePending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.planner.retry(pending.prefix);
    }
    this.pending.clear();
  }

  override cleanup(): void {
    this.requeuePending();
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pumpTimer = null;
    this.reconnectTimer = null;
    super.cleanup();
  }
}

/** 拉成员总入口：deep 直接走 Deep；否则先 Fast，失败/无数据回退 Deep */
async function fetchMembers(options: GatewayOptions): Promise<{ count: number; reason: string; checkpoint?: PlannerCheckpoint }> {
  console.log('fetchMembers start !!!===', options.mode, options)
  if (options.mode === "deep") {
    const client = new DeepGatewayClient(options);
    const count = await client.fetch();
    return { count, reason: client.completeReason, checkpoint: client.planner.snapshot() };
  }
  console.log(1024, options.mode)
  try {
    const client = new FastGatewayClient(options);
    const count = await client.fetch();
    console.log('fetch members ====', count)
    if (count || options.signal?.aborted || options.shouldStop?.()) {
      return { count, reason: client.completeReason };
    }
  } catch (err) {
    console.log('Error 950')
    if (options.signal?.aborted || options.shouldStop?.()) throw err;
  }
  options.onStatus?.("gateway_fast_fallback");
  const client = new DeepGatewayClient({ ...options, mode: "deep" });
  const count = await client.fetch();
  return { count, reason: client.completeReason, checkpoint: client.planner.snapshot() };
}

// ============================================================
// 4. 配额 + 导出辅助
// ============================================================

function toPositiveInt(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 取两个数里较小的正数（有效导出上限） */
function minPositive(count: unknown, limit: unknown): number {
  const a = toPositiveInt(count);
  const b = toPositiveInt(limit);
  return b && a ? Math.min(b, a) : b || a;
}

/** Nitro 充值档位（按 SKU 映射到展示名 + 等级） */
const NITRO_TIER_SKUS: Record<string, { name: string; level: number }> = {
  premium_tenure_1_month_v2: { name: "Bronze · 1 month", level: 1 },
  premium_tenure_3_month_v2: { name: "Silver · 3 months", level: 2 },
  premium_tenure_6_month_v2: { name: "Gold · 6 months", level: 3 },
  premium_tenure_1_year_v2: { name: "Platinum · 1 year", level: 4 },
  premium_tenure_2_year_v2: { name: "Diamond · 2 years", level: 5 },
  premium_tenure_3_year_v2: { name: "Emerald · 3 years", level: 6 },
  premium_tenure_5_year_v2: { name: "Ruby · 5 years", level: 7 },
  premium_tenure_6_year_v2: { name: "Fire Opal · 6 years", level: 8 },
};

function findNitroTier(badges?: Array<{ id?: string }>): { name: string; level: number } | null {
  for (const b of badges || []) {
    const id = b?.id;
    if (!id) continue;
    const tier = NITRO_TIER_SKUS[id];
    if (tier) return tier;
  }
  return null;
}

function meetsTierFilter(badges: Array<{ id?: string }> | undefined, tierFilter: number): boolean {
  return tierFilter <= 0 || (findNitroTier(badges)?.level || 0) >= tierFilter;
}

/** 可中断的 sleep */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

/** REST 拉取单个用户的详细资料（profile popout），带 429 重试 */
async function fetchUserProfile(
  token: string,
  guildId: string,
  userId: string,
  signal?: AbortSignal,
  retry = 0,
): Promise<Profile> {
  const resp = await fetch(
    `https://discord.com/api/v9/users/${userId}/profile?type=popout&with_mutual_guilds=true&with_mutual_friends=true&with_mutual_friends_count=true&guild_id=${guildId}`,
    {
      headers: {
        accept: "*/*",
        authorization: token,
        "cache-control": "no-cache",
      },
      credentials: "include",
      signal,
    },
  );
  const json = (await resp.json().catch(() => ({}))) as Profile;
  if ((resp.status === 429 || typeof json.retry_after == "number") && retry < 3) {
    await sleep(((Number(json.retry_after) || 3) + 1) * 1e3, signal);
    return fetchUserProfile(token, guildId, userId, signal, retry + 1);
  }
  if (!resp.ok && !json.user) throw Error(json.message || `HTTP ${resp.status}`);
  return json;
}

interface EnrichOptions {
  token: string;
  guildId: string;
  tierFilter: number;
  signal?: AbortSignal;
  shouldPause?: () => boolean;
  shouldStop?: () => boolean;
  onProgress?: (done: number, total: number, kept: number) => void;
}

/** 批量给成员拉详细资料（可选 tierFilter 过滤），成员流式从 member_stream 读写，返回过滤后保留的成员数 */
async function enrichProfiles(taskId: string, options: EnrichOptions): Promise<number> {
  const ids = await readMemberIds(taskId);
  const total = ids.length;
  let done = 0;
  let kept = 0;
  let consecutiveErrors = 0;

  console.log('options.tierFilter', options.tierFilter)

  for (let i = 0; i < total; i += ROW_BATCH) {
    const members = await readMembersByIds(taskId, ids.slice(i, i + ROW_BATCH));
    for (let k = 0; k < members.length; k++) {
      const member = members[k]!;
      const globalIdx = i + k;
      while (options.shouldPause?.() && !options.shouldStop?.()) await sleep(300, options.signal).catch(() => { });
      if (options.shouldStop?.() || options.signal?.aborted) {
        // 停止/中止：删除尚未处理的成员，只保留已成功获取详细资料的成员
        const rest = ids.slice(globalIdx);
        for (let j = 0; j < rest.length; j += ROW_BATCH) {
          await deleteMembers(taskId, rest.slice(j, j + ROW_BATCH));
        }
        options.onProgress?.(done, total, kept);
        return kept;
      }
      try {
        const profile = await fetchUserProfile(options.token, options.guildId, member.id, options.signal);
        consecutiveErrors = 0;
        if (meetsTierFilter(profile.badges, options.tierFilter)) {
          await putMember(taskId, { ...member, profile });
          kept++;
        } else {
          await deleteMember(taskId, member.id);
        }
      } catch {
        if (options.signal?.aborted) {
          // 请求被中止：删除当前及之后未处理的成员，只保留已成功获取详细资料的成员
          const rest = ids.slice(globalIdx);
          for (let j = 0; j < rest.length; j += ROW_BATCH) {
            await deleteMembers(taskId, rest.slice(j, j + ROW_BATCH));
          }
          options.onProgress?.(done, total, kept);
          return kept;
        }
        consecutiveErrors++;
        if (options.tierFilter === 0) {
          await putMember(taskId, member);
          kept++;
        } else {
          await deleteMember(taskId, member.id);
        }
        if (consecutiveErrors >= 3) {
          // 连续 3 次失败就放弃剩余（不筛等级时保留剩余全部）
          if (options.tierFilter === 0) {
            kept += ids.slice(globalIdx + 1).length;
          } else {
            const rest = ids.slice(globalIdx + 1);
            for (let j = 0; j < rest.length; j += ROW_BATCH) {
              await deleteMembers(taskId, rest.slice(j, j + ROW_BATCH));
            }
          }
          options.onProgress?.(total, total, kept);
          return kept;
        }
      }
      done++;
      options.onProgress?.(done, total, kept);
      await sleep(1500 + Math.random() * 1e3, options.signal).catch(() => { });
    }
  }
  options.onProgress?.(total, total, kept);
  return kept;
}

/** Discord snowflake → ISO 时间 */
function snowflakeToIso(id: string): string {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
  } catch {
    return "";
  }
}

function intToHexColor(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `#${n.toString(16).padStart(6, "0")}` : "";
}

const NITRO_TYPE_MAP: Record<number, string> = { 0: "None", 1: "Classic", 2: "Nitro", 3: "Basic" };

/** 成员 → 导出表格的一行 */
function toExportRow(member: Member): Record<string, any> {
  const profile = member.profile || {};
  const nitro = findNitroTier(profile.badges || []);
  return {
    avatarUrl: member.avatarUrl,
    id: member.id,
    username: member.username,
    nickname: member.nickname,
    accountCreated: snowflakeToIso(member.id),
    joinedAt: member.joinedAt,
    roles: member.roles.join(", "),
    status: member.status,
    activity: member.activity,
    discriminator: member.discriminator,
    globalName: profile.user?.global_name || "",
    nitroTier: nitro?.name || "",
    nitroType: NITRO_TYPE_MAP[profile.premium_type] || "",
    nitroSince: profile.premium_since || "",
    bio: profile.user?.bio || profile.user_profile?.bio || "",
    pronouns: profile.user_profile?.pronouns || "",
    serverBio: profile.guild_member_profile?.bio || "",
    serverPronouns: profile.guild_member_profile?.pronouns || "",
    serverBoostSince: profile.guild_member?.premium_since || "",
    accentColor: intToHexColor(profile.user?.accent_color),
    publicFlags: profile.user?.public_flags ?? 0,
    primaryGuildTag: profile.user?.primary_guild?.tag || "",
    clanTag: profile.user?.clan?.tag || "",
    avatarDecoration: profile.user?.avatar_decoration_data?.asset || "",
    connectedAccounts: (profile.connected_accounts || []).map((a: any) => `${a.type}: ${a.name}`).join(", "),
    badges: (profile.badges || []).map((b: any) => b.description).join(", "),
    mutualGuildsCount: (profile.mutual_guilds || []).length,
    mutualFriendsCount: profile.mutual_friends_count || 0,
    communicationDisabledUntil: profile.guild_member?.communication_disabled_until || "",
    pendingVerification: !!profile.guild_member?.pending,
    legacyUsername: profile.legacy_username || "",
  };
}

/** 计算有效导出上限（免费用户卡在 freeLimit） */
function computeEffectiveLimit(requested: number, isPaidProduct: boolean, subscriber: boolean, freeLimit: number): number {
  const req = Math.max(0, Math.floor(requested || 0));
  const free = Math.max(1, Math.floor(freeLimit || 100));
  return !isPaidProduct || subscriber ? req : Math.min(req || free, free);
}

function isLimitReached(requested: number, isPaidProduct: boolean, subscriber: boolean, freeLimit: number): boolean {
  const req = Math.max(0, Math.floor(requested || 0));
  return isPaidProduct && !subscriber && (req === 0 || req > Math.max(1, Math.floor(freeLimit || 100)));
}

// ---- IndexedDB：导出结果（results + result_rows）、断点（checkpoints）、成员流（member_stream）----
const DB_NAME = "discord-member-exporter";
const DB_STORE = "results";
const CHECKPOINT_STORE = "checkpoints";
const MEMBER_STORE = "member_stream";
const ROWS_STORE = "result_rows";
/** 成员流式落盘：内存缓冲多少条就异步写一批 */
const STREAM_BATCH = 500;
/** 收尾/详情阶段每批读写的成员/行数量 */
const ROW_BATCH = 1000;
/** 行 key 的固定宽度（补零保证字典序 = 数值序，读回时按序拼接） */
const ROW_INDEX_DIGITS = 8;

/** 断点记录：仅前缀枚举进度 + 设置 + 已收集数量（成员本体已流式存于 member_stream） */
interface CheckpointRecord {
  taskId: string;
  planner: PlannerCheckpoint | null;
  settings: Settings;
  count: number;
  savedAt: string;
}

/** 成员流记录（member_stream 表） */
interface MemberRecord {
  key: string; // `${taskId}:${memberId}`
  member: Member;
}

/** 导出行记录（result_rows 表） */
interface RowRecord {
  key: string; // `${taskId}:${补零 index}`
  row: Record<string, any>;
}

function memberKey(taskId: string, id: string): string {
  return `${taskId}:${id}`;
}

function memberRange(taskId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${taskId}:`, `${taskId}:￿`);
}

function rowKey(taskId: string, index: number): string {
  return `${taskId}:${String(index).padStart(ROW_INDEX_DIGITS, "0")}`;
}

function rowRange(taskId: string): IDBKeyRange {
  return IDBKeyRange.bound(rowKey(taskId, 0), rowKey(taskId, 10 ** ROW_INDEX_DIGITS - 1));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "taskId" });
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) db.createObjectStore(CHECKPOINT_STORE, { keyPath: "taskId" });
      if (!db.objectStoreNames.contains(MEMBER_STORE)) db.createObjectStore(MEMBER_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(ROWS_STORE)) db.createObjectStore(ROWS_STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(fn: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("RESULT_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 写入导出结果元信息（不含 rows，rows 已按块写入 result_rows） */
async function putResultMeta(meta: {
  taskId: string;
  avatars: Array<{ id: string; username: string; url: string }>;
  context: PublicContext;
  limitReached: boolean;
  rowCount: number;
}): Promise<void> {
  await withStore((store) => {
    store.put(meta);
  });
}

/** 追加一批导出行到 result_rows */
async function appendRows(taskId: string, startIndex: number, rows: Record<string, any>[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROWS_STORE, "readwrite");
      const store = tx.objectStore(ROWS_STORE);
      for (let i = 0; i < rows.length; i++) {
        store.put({ key: rowKey(taskId, startIndex + i), row: rows[i] });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("ROWS_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 删除某个任务的结果（meta + rows） */
async function deleteResult(taskId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DB_STORE, ROWS_STORE], "readwrite");
      tx.objectStore(DB_STORE).delete(taskId);
      tx.objectStore(ROWS_STORE).delete(rowRange(taskId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("RESULT_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 清空所有结果（meta + rows） */
async function clearResults(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DB_STORE, ROWS_STORE], "readwrite");
      tx.objectStore(DB_STORE).clear();
      tx.objectStore(ROWS_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("RESULT_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 成员流式写入器：内存只缓冲一小批，满批即异步落盘 */
class MemberWriter {
  private buffer: Member[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private taskId: string) {}

  write(member: Member): void {
    this.buffer.push(member);
    if (this.buffer.length >= STREAM_BATCH) {
      const batch = this.buffer;
      this.buffer = [];
      this.chain = this.chain.then(() => this.flushBatch(batch));
    }
  }

  /** 等待所有缓冲与在途写入完成 */
  flush(): Promise<void> {
    if (this.buffer.length) {
      const batch = this.buffer;
      this.buffer = [];
      this.chain = this.chain.then(() => this.flushBatch(batch));
    }
    return this.chain;
  }

  private async flushBatch(batch: Member[]): Promise<void> {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(MEMBER_STORE, "readwrite");
        const store = tx.objectStore(MEMBER_STORE);
        for (const m of batch) store.put({ key: memberKey(this.taskId, m.id), member: m });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || Error("MEMBER_STORE_TRANSACTION_ABORTED"));
      });
    } finally {
      db.close();
    }
  }
}

/** 读回本任务已流式落盘的全部成员 id（仅 key，不读成员本体，避免重新占用内存） */
async function readMemberIds(taskId: string): Promise<string[]> {
  const db = await openDb();
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction(MEMBER_STORE, "readonly");
      const req = tx.objectStore(MEMBER_STORE).getAllKeys(memberRange(taskId));
      req.onsuccess = () => resolve(req.result as IDBValidKey[]);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${taskId}:`;
    return keys.map((k) => String(k).slice(prefix.length));
  } finally {
    db.close();
  }
}

/** 按 id 批量读回成员（保持 id 顺序） */
async function readMembersByIds(taskId: string, ids: string[]): Promise<Member[]> {
  const db = await openDb();
  try {
    const records = await new Promise<MemberRecord[]>((resolve, reject) => {
      const tx = db.transaction(MEMBER_STORE, "readonly");
      const store = tx.objectStore(MEMBER_STORE);
      const out: MemberRecord[] = new Array(ids.length);
      let pending = ids.length;
      if (!pending) return resolve([]);
      ids.forEach((id, idx) => {
        const req = store.get(memberKey(taskId, id));
        req.onsuccess = () => {
          if (req.result) out[idx] = req.result as MemberRecord;
          if (--pending === 0) resolve(out.filter(Boolean));
        };
        req.onerror = () => reject(req.error);
      });
    });
    return records.map((r) => r.member);
  } finally {
    db.close();
  }
}

/** 更新/写入单个成员（详情阶段把 profile 写回） */
async function putMember(taskId: string, member: Member): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MEMBER_STORE, "readwrite");
      tx.objectStore(MEMBER_STORE).put({ key: memberKey(taskId, member.id), member });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("MEMBER_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 删除单个成员（详情阶段过滤掉不合条件的） */
async function deleteMember(taskId: string, id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MEMBER_STORE, "readwrite");
      tx.objectStore(MEMBER_STORE).delete(memberKey(taskId, id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("MEMBER_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 批量删除成员 */
async function deleteMembers(taskId: string, ids: string[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MEMBER_STORE, "readwrite");
      const store = tx.objectStore(MEMBER_STORE);
      for (const id of ids) store.delete(memberKey(taskId, id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("MEMBER_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 清空本任务的成员流（收尾/清除时释放磁盘） */
async function clearMemberStream(taskId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MEMBER_STORE, "readwrite");
      tx.objectStore(MEMBER_STORE).delete(memberRange(taskId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("MEMBER_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 落盘断点：前缀枚举进度 + 设置 + 已收集数量（成员本体已流式存于 member_stream） */
async function putCheckpoint(record: CheckpointRecord): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHECKPOINT_STORE, "readwrite");
      tx.objectStore(CHECKPOINT_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("CHECKPOINT_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

/** 读回断点 */
async function loadCheckpoint(taskId: string): Promise<CheckpointRecord | null> {
  const db = await openDb();
  try {
    const record = await new Promise<CheckpointRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(CHECKPOINT_STORE, "readonly");
      const req = tx.objectStore(CHECKPOINT_STORE).get(taskId);
      req.onsuccess = () => resolve(req.result as CheckpointRecord | undefined);
      req.onerror = () => reject(req.error);
    });
    return record || null;
  } finally {
    db.close();
  }
}

/** 删除断点 */
async function deleteCheckpoint(taskId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHECKPOINT_STORE, "readwrite");
      tx.objectStore(CHECKPOINT_STORE).delete(taskId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("CHECKPOINT_STORE_TRANSACTION_ABORTED"));
    });
  } finally {
    db.close();
  }
}

// ---- 定时任务（chrome.alarms）----
const ALARM_PREFIX = "discord_export_";

function parseScheduleTime(time: string, now = new Date()): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw Error("INVALID_SCHEDULE_TIME");
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  return idx < 0 ? [...list, item] : list.map((x, i) => (i === idx ? item : x));
}

// ============================================================
// 主逻辑：状态 / 存储 / 消息路由 / 导出流程
// ============================================================

const PRODUCT_ID = "discord-member-exporter";
const API_ENDPOINT = "https://api.reforgeextensions.com";

const DEFAULT_SETTINGS: Settings = {
  language: "en",
  theme: "system",
  mode: "fast",
  memberLimit: 0,
  fetchDetailedInfo: false,
  tierFilter: 0,
  format: "xlsx",
  downloadAvatars: false,
  downloadFolder: "Discord Member Exports",
  enabledBasicColumns: [
    "avatarUrl", "id", "username", "nickname", "accountCreated", "joinedAt",
    "roles", "status", "activity",
  ],
  enabledDetailedColumns: [
    "globalName", "nitroTier", "nitroType", "nitroSince", "bio",
    "serverBoostSince", "connectedAccounts", "badges",
  ],
  filenameTemplate: "{serverName}_{channelName}_{datetime}_{memberCount}",
};

const DEFAULT_STATS: Stats = { successfulExports: 0, exportedMembers: 0, lastExportAt: null };

const KEY_SETTINGS = "dme:settings:v1";
const KEY_LAST_MODE = "dme:last-mode:v1";
const KEY_STATS = "dme:stats:v1";
const KEY_TASK = "dme:task:v1";
const KEY_DISCORD_AUTH = "dme:discord-auth:v1";
const KEY_DISCORD_TARGET = "dme:discord-target:v1";
const KEY_SCHEDULES = "dme:schedules:v1";

let statsPromise: Promise<Stats> = Promise.resolve(DEFAULT_STATS);

function hasChromeStorage(): boolean {
  return !!browser.storage?.local;
}

function isValidMode(mode: unknown): mode is "fast" | "deep" {
  return mode === "fast" || mode === "deep";
}

async function loadSettings(): Promise<Settings> {
  if (!hasChromeStorage()) {
    const raw = localStorage.getItem(KEY_SETTINGS);
    const settings: Settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
    const lastMode = localStorage.getItem(KEY_LAST_MODE);
    return { ...settings, mode: isValidMode(lastMode) ? lastMode : settings.mode };
  }
  const stored = await browser.storage.local.get([KEY_SETTINGS, KEY_LAST_MODE]);
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(stored[KEY_SETTINGS] || {}) };
  return { ...settings, mode: isValidMode(stored[KEY_LAST_MODE]) ? stored[KEY_LAST_MODE] : settings.mode };
}

async function loadStats(): Promise<Stats> {
  if (!hasChromeStorage()) {
    const raw = localStorage.getItem(KEY_STATS);
    return raw ? { ...DEFAULT_STATS, ...JSON.parse(raw) } : DEFAULT_STATS;
  }
  const stored = await browser.storage.local.get(KEY_STATS);
  return { ...DEFAULT_STATS, ...(stored[KEY_STATS] || {}) };
}

function recordExport(count: number): Promise<Stats> {
  statsPromise = statsPromise
    .catch(() => DEFAULT_STATS)
    .then(async (): Promise<Stats> => {
      const current = await loadStats();
      const next: Stats = {
        successfulExports: current.successfulExports + 1,
        exportedMembers: current.exportedMembers + count,
        lastExportAt: new Date().toISOString(),
      };
      if (hasChromeStorage()) await browser.storage.local.set({ [KEY_STATS]: next });
      else localStorage.setItem(KEY_STATS, JSON.stringify(next));
      return next;
    });
  return statsPromise;
}

async function loadTask(): Promise<PublicTask | null> {
  if (!hasChromeStorage()) return null;
  const stored = await browser.storage.local.get(KEY_TASK);
  return (stored[KEY_TASK] as PublicTask | undefined) || null;
}

async function saveTask(task: PublicTask | null): Promise<void> {
  console.log(1306, 'saveTask')
  if (!hasChromeStorage()) return;
  console.log(1308, task)
  if (task) await browser.storage.local.set({ [KEY_TASK]: task });
  else await browser.storage.local.remove(KEY_TASK);
}

async function loadStoredAuth(): Promise<StoredAuth | null> {
  if (!hasChromeStorage()) return null;
  const stored = await browser.storage.local.get(KEY_DISCORD_AUTH);
  return (stored[KEY_DISCORD_AUTH] as StoredAuth | undefined) || null;
}

async function saveStoredAuth(auth: StoredAuth): Promise<void> {
  if (hasChromeStorage()) await browser.storage.local.set({ [KEY_DISCORD_AUTH]: auth });
}

async function loadStoredTarget(): Promise<PublicContext | null> {
  if (!hasChromeStorage()) return null;
  const stored = await browser.storage.local.get(KEY_DISCORD_TARGET);
  return (stored[KEY_DISCORD_TARGET] as PublicContext | undefined) || null;
}

async function saveStoredTarget(target: PublicContext): Promise<void> {
  if (hasChromeStorage()) await browser.storage.local.set({ [KEY_DISCORD_TARGET]: target });
}

async function clearDiscordAccess(): Promise<void> {
  if (hasChromeStorage()) await browser.storage.local.remove([KEY_DISCORD_AUTH, KEY_DISCORD_TARGET]);
}

async function loadSchedules(): Promise<Schedule[]> {
  if (!hasChromeStorage()) return [];
  const stored = await browser.storage.local.get(KEY_SCHEDULES);
  return Array.isArray(stored[KEY_SCHEDULES]) ? stored[KEY_SCHEDULES] : [];
}

async function saveSchedules(schedules: Schedule[]): Promise<void> {
  if (hasChromeStorage()) await browser.storage.local.set({ [KEY_SCHEDULES]: schedules });
}

// ---- 全局运行时状态 ----
const paymentClient = new PaymentClient({ productId: PRODUCT_ID, apiEndpoint: API_ENDPOINT, enableAliLog: true });
const tabContextCache = new Map<number, MemberContext>();     // tabId → 上下文
const SESSION_KEY_PREFIX = "dme:context:";                    // chrome.storage.session 键前缀
const ACTIVE_PHASES = new Set<string>(["collecting", "details", "paused", "zipping"]);
const targetCache = new Map<string, PublicContext>();         // "guildId:channelId" → 目标（带缓存时间）
const guildCache = new Map<string, { serverName: string; avatar: string; memberCount: number; updatedAt: number }>();
let currentTask: Task | null = null;
let currentAbortController: AbortController | null = null;
let currentRunPromise: Promise<unknown> | null = null;
let isRunning = false;
let lastTaskSaveAt = 0;
let runStartAt = 0; // runExport 开始时刻（毫秒时间戳），用于计算耗时 costTimes
let initPromise: Promise<void> = Promise.resolve();
let offscreenPromise: Promise<void> | null = null;
let offscreenCloseTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/** 去掉任务的内部字段（stopRequested），用于持久化与广播 */
function stripTaskInternal(task: Task): PublicTask {
  const { stopRequested, ...rest } = task;
  return rest;
}

/** 毫秒 → 00h 00m 00s */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}h ${p(m)}m ${p(s)}s`;
}

/** 节流保存任务状态并广播（180ms 内不重复写） */
async function saveTaskState(force = false): Promise<void> {
  if (!currentTask) return;
  const now = Date.now();
  if (!force && now - lastTaskSaveAt < 180) return;
  lastTaskSaveAt = now;
  if (runStartAt) currentTask.costTimes = formatDuration(now - runStartAt);
  const snapshot = stripTaskInternal(currentTask);
  console.log(1374, snapshot)
  await saveTask(snapshot);
  browser.runtime.sendMessage({ type: "DME_TASK_UPDATED", task: snapshot }).catch(() => void 0);
}

/** 上报阿里云日志 */
async function trackEvent(operate: string, data: Record<string, unknown> = {}): Promise<void> {
  try {
    await paymentClient.sendAli("core", operate, { result: "success", ...data });
  } catch { }
}

function withAuth(target: PublicContext, token: string, clientBuildNumber?: number): MemberContext {
  return { ...target, token, clientBuildNumber };
}

/** 带超时的 REST JSON 请求 */
async function fetchJson(url: string, headers: Record<string, string>, timeout = 12e3): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readMemberCount(guild: any): number {
  return Math.max(0, Math.floor(Number(guild?.approximate_member_count || guild?.member_count || 0)));
}

/** 补全服务器/频道信息（名字、头像、成员数），带 1 小时内存缓存 */
async function enrichContext(context: MemberContext, force = false): Promise<MemberContext> {
  if (!context.token || !hasTarget(context)) return context;
  const targetKey = `${context.guildId}:${context.channelId}`;
  const cachedTarget = targetCache.get(targetKey);
  if (!force && cachedTarget && Date.now() - cachedTarget.updatedAt < 36e5)
    return { ...context, ...cachedTarget, tabId: context.tabId, token: context.token };

  let serverName = context.serverName;
  let channelName = context.channelName;
  let avatar = context.avatar;
  let memberCount = Math.max(0, Math.floor(Number(context.memberCount || 0)));
  const headers = { authorization: context.token, accept: "application/json" };

  // 频道名（若缺失）
  if (!channelName) {
    const channel = await fetchJson(`https://discord.com/api/v9/channels/${context.channelId}`, headers);
    if (channel) channelName = String(channel.name || channelName);
  }

  // 服务器信息（优先缓存，其次 guild 接口，再退 @me/guilds 列表）
  const cachedGuild = guildCache.get(context.guildId);
  if (!force && cachedGuild && Date.now() - cachedGuild.updatedAt < 36e5) {
    serverName = cachedGuild.serverName || serverName;
    avatar = cachedGuild.avatar || avatar;
    memberCount = cachedGuild.memberCount || memberCount;
  } else {
    let guild = await fetchJson(
      `https://discord.com/api/v9/guilds/${context.guildId}?with_counts=true`,
      headers,
    );
    if (!readMemberCount(guild)) {
      const guilds = await fetchJson("https://discord.com/api/v9/users/@me/guilds?with_counts=true", headers);
      const found = (Array.isArray(guilds) && guilds.find((g: any) => String(g.id) === context.guildId)) || null;
      if (found) guild = found;
    }
    if (guild) {
      serverName = String(guild.name || serverName);
      memberCount = readMemberCount(guild) || memberCount;
      if (guild.icon) avatar = `https://cdn.discordapp.com/icons/${context.guildId}/${guild.icon}.png?size=128`;
      guildCache.set(context.guildId, { serverName, avatar, memberCount, updatedAt: Date.now() });
    }
  }

  const enriched: MemberContext = {
    ...context,
    serverName,
    channelName,
    avatar,
    memberCount: memberCount || undefined,
    updatedAt: Date.now(),
  };
  const snapshot = stripAuth(enriched);
  targetCache.set(targetKey, snapshot);
  return enriched;
}

/** 同步某个 tab 的上下文：合并存储的 auth/target，补全信息，写 session 缓存 */
async function syncContext(tabId: number, context: RawContext): Promise<MemberContext> {
  const [storedAuth, storedTarget] = await Promise.all([loadStoredAuth(), loadStoredTarget()]);
  let merged = buildContext(tabId, context, tabContextCache.get(tabId) || null, storedAuth);
  if (
    storedTarget &&
    merged.guildId === storedTarget.guildId &&
    merged.channelId === storedTarget.channelId
  ) {
    merged = {
      ...merged,
      serverName: merged.serverName || storedTarget.serverName,
      channelName: merged.channelName || storedTarget.channelName,
      avatar: merged.avatar || storedTarget.avatar,
      memberCount: merged.memberCount || storedTarget.memberCount,
    };
  }
  if (
    merged.token &&
    (merged.token !== storedAuth?.token || merged.clientBuildNumber !== storedAuth?.clientBuildNumber)
  ) {
    await saveStoredAuth({ token: merged.token, clientBuildNumber: merged.clientBuildNumber, updatedAt: Date.now() });
  }
  if (hasTarget(merged)) {
    merged = await enrichContext(merged);
    await saveStoredTarget(stripAuth(merged));
  }
  tabContextCache.set(tabId, merged);
  await browser.storage.session.set({ [SESSION_KEY_PREFIX + tabId]: merged });
  return merged;
}

/** 取某 tab 的上下文（内存 → session → 主动向 content script 拉取） */
async function getTabContext(tabId: number): Promise<MemberContext | null> {
  if (!Number.isFinite(tabId) || tabId <= 0) return null;
  if (tabContextCache.has(tabId)) return tabContextCache.get(tabId)!;
  const key = SESSION_KEY_PREFIX + tabId;
  const stored = await browser.storage.session.get(key);
  if (stored[key]) {
    const context = stored[key] as MemberContext;
    tabContextCache.set(tabId, context);
    return context;
  }
  try {
    const resp = await browser.tabs.sendMessage(tabId, { type: "DME_PULL_CONTEXT" });
    if (resp?.context) return syncContext(tabId, resp.context);
  } catch { }
  return null;
}

/** 解析导出目标：优先当前 tab，其次存储的 target */
async function resolveTarget(tabId = 0, fallbackTarget?: PublicContext | null): Promise<MemberContext | null> {
  const fromTab = await getTabContext(tabId);
  if (fromTab?.token && hasTarget(fromTab)) return fromTab;
  const [storedAuth, storedTarget] = await Promise.all([loadStoredAuth(), loadStoredTarget()]);
  const target = hasTarget(fallbackTarget) ? fallbackTarget : storedTarget;
  if (!storedAuth?.token || !target || !hasTarget(target)) return null;
  return enrichContext(withAuth(target, storedAuth.token, storedAuth.clientBuildNumber));
}

function toLimit(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** 解析付费状态：是否付费产品、是否订阅、免费额度 */
async function resolveEntitlement(entitlement: Record<string, any> = {}): Promise<Entitlement> {
  let isPaidProduct = !!entitlement.isPaidProduct;
  let subscriber = !isPaidProduct || !!entitlement.subscriber;
  let freeLimit = toLimit(entitlement.freeLimit);
  try {
    const config = await paymentClient.getConfig();
    isPaidProduct = !!config.isPaid;
    freeLimit = toLimit(config.features?.freeMemberLimit);
    const userInfo = (await paymentClient.isLoggedIn().catch(() => false))
      ? await paymentClient.fetchUserInfo().catch(() => null)
      : null;
    subscriber =
      !isPaidProduct ||
      userInfo?.isPaid === true ||
      (await paymentClient.isPaid().catch(() => false));
  } catch { }
  return { isPaidProduct, subscriber, freeLimit };
}

function pickExportSettings(settings: Settings): ExportSettings {
  return {
    mode: settings.mode,
    memberLimit: settings.memberLimit,
    fetchDetailedInfo: settings.fetchDetailedInfo,
    tierFilter: settings.tierFilter,
    format: settings.format,
    downloadAvatars: settings.downloadAvatars,
  };
}

/** 确保 offscreen document 存在（用于下载导出文件） */
async function ensureOffscreen(): Promise<void> {
  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }
  if (typeof browser.offscreen.hasDocument == "function") {
    if (await browser.offscreen.hasDocument()) return;
  } else if (
    (
      await browser.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [browser.runtime.getURL("/offscreen.html")],
      })
    ).length
  ) {
    return;
  }
  offscreenPromise ??= browser.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [browser.offscreen.Reason.BLOBS],
      justification: "Create and download the member export file after background collection.",
    })
    .finally(() => {
      offscreenPromise = null;
    });
  await offscreenPromise;
}

/** 通过 offscreen 触发下载，然后记录统计 */
async function downloadViaOffscreen(taskId: string, settings: Settings, language: string): Promise<any> {
  const prevPhase = currentTask?.id === taskId ? currentTask.phase : undefined;
  // 头像 ZIP 生成/下载耗时较长：进入 zipping 阶段并广播，让 UI 展示「头像ZIP生成中」并禁止再次导出，
  // 否则任务已进入 complete/stopped 终态、UI 又允许点「导出成员」，会触发 ANOTHER_TASK_RUNNING。
  if (prevPhase && settings.downloadAvatars) {
    currentTask!.phase = "zipping";
    currentTask!.status = "zipping_avatars";
    await saveTaskState(true);
  }
  // offscreen 里 getAll + 生成大 CSV/XLSX 也要几十秒，期间同样保活，避免 SW 被误杀
  startKeepAlive();
  try {
    await ensureOffscreen();
    const resp = await browser.runtime.sendMessage({
      type: "DME_OFFSCREEN_DOWNLOAD",
      taskId,
      settings,
      language,
    });
    if (!resp?.ok) throw Error(resp?.error || "DOWNLOAD_FAILED");
    const output = resp.output;
    const stats = await recordExport(output.count);
    browser.runtime.sendMessage({ type: "DME_STATS_UPDATED", stats }).catch(() => void 0);
    return output;
  } finally {
    stopKeepAlive();
    if (currentTask?.id === taskId && settings.downloadAvatars && prevPhase) {
      currentTask.phase = prevPhase;
      currentTask.status = "";
    }
    await deleteResult(taskId).catch(() => void 0);
    offscreenCloseTimer = setTimeout(() => {
      browser.offscreen.closeDocument().catch(() => void 0);
    }, 2e3);
  }
}

/** 启动导出 */
async function startExport(params: StartExportParams): Promise<{ ok: true; task: PublicTask }> {
  if (isRunning || currentRunPromise || (currentTask && ACTIVE_PHASES.has(currentTask.phase)))
    throw Error("ANOTHER_TASK_RUNNING");
  isRunning = true;
  try {
    await clearResults().catch(() => void 0);
    let target = await resolveTarget(Number(params.tabId || 0), params.target);
    if (!target?.token) throw Error("TOKEN_MISSING");
    if (!hasTarget(target)) throw Error("DISCORD_CHANNEL_REQUIRED");
    target = await enrichContext(target, true);
    const snapshot = stripAuth(target);
    await saveStoredTarget(snapshot);
    browser.runtime.sendMessage({ type: "DME_CONTEXT_UPDATED", context: snapshot, tokenReady: true }).catch(() => void 0);

    const settings = pickExportSettings(params.settings);
    const entitlement = await resolveEntitlement(params.entitlement || {});
    const resume = params.resume;
    const requestedLimit = resume?.requestedLimit ?? Math.max(0, Number(settings.memberLimit || 0));
    const effectiveLimit = resume?.effectiveLimit ?? computeEffectiveLimit(requestedLimit, entitlement.isPaidProduct, entitlement.subscriber, entitlement.freeLimit);
    const totalMembers = Math.max(0, Math.floor(Number(target.memberCount || 0)));
    const progressTarget = minPositive(totalMembers, effectiveLimit);
    const startedAt = new Date().toISOString();
    const abortController = new AbortController();
    const limitReached = resume?.limitReached ?? isLimitReached(requestedLimit, entitlement.isPaidProduct, entitlement.subscriber, entitlement.freeLimit);
    const collected = resume?.collected ?? 0;

    const task: Task = {
      id: resume?.taskId ?? crypto.randomUUID(),
      tabId: target.tabId ?? 0,
      phase: "collecting",
      options: { ...settings, memberLimit: requestedLimit },
      requestedLimit,
      effectiveLimit,
      totalMembers,
      progressTarget,
      collected,
      detailCurrent: 0,
      detailTotal: 0,
      paused: false,
      limitReached,
      resultCount: 0,
      error: "",
      startedAt,
      finishedAt: null,
      costTimes: "00h 00m 00s",
      context: stripAuth(target),
      source: params.source,
      scheduleId: params.scheduleId,
      status: "gateway_connecting",
      completeReason: "",
      downloaded: false,
      filename: "",
      downloadError: "",
      stopRequested: false,
    };
    currentTask = task;
    currentAbortController = abortController;
    await saveTaskState(true);
    if (params.trackStart)
      trackEvent("export_started", {
        mode: settings.mode,
        format: settings.format,
        detailed: settings.fetchDetailedInfo,
        requestedLimit: requestedLimit || "all",
      });

    const taskId = task.id;
    const run = runExport(taskId, target, abortController, params.settings, resume?.planner ?? null).then(async () => {
      if (!currentTask || currentTask.id !== taskId) return;
      // 可续跑：等待用户「继续导出」或「结束并导出」，保留断点与 partial 状态
      if (currentTask.phase === "partial") return;
      if (
        !["complete", "stopped"].includes(currentTask.phase) ||
        currentTask.resultCount <= 0
      ) {
        await deleteResult(taskId).catch(() => void 0);
        if (["complete", "stopped"].includes(currentTask.phase))
          await saveTask(null);
        return;
      }
      try {
        const output = await downloadViaOffscreen(taskId, params.settings, params.settings.language);
        if (!currentTask || currentTask.id !== taskId) return;
        currentTask.downloaded = true;
        currentTask.filename = output.filename;
        currentTask.downloadError = output.avatarFailures ? `AVATAR_DOWNLOAD_INCOMPLETE:${output.avatarFailures}` : "";
      } catch (err) {
        if (!currentTask || currentTask.id !== taskId) return;
        currentTask.downloadError = err instanceof Error ? err.message : String(err);
      }
      await saveTaskState(true);
      await saveTask(null);
    });

    currentRunPromise = run;
    run
      .finally(() => {
        if (currentAbortController === abortController) currentAbortController = null;
        if (currentRunPromise === run) currentRunPromise = null;
      })
      .catch(() => void 0);

    return { ok: true, task: stripTaskInternal(task) };
  } catch (err) {
    if (!currentRunPromise && currentTask && ACTIVE_PHASES.has(currentTask.phase)) {
      currentAbortController?.abort();
      currentAbortController = null;
      currentTask = null;
      await saveTask(null).catch(() => void 0);
    }
    throw err;
  } finally {
    isRunning = false;
  }
}

/** 收集提前结束但可续跑的原因（超时 / 重连耗尽），命中时保存断点而非直接收尾 */
const RESUMABLE_REASONS = new Set(["overall_timeout", "reconnect_exhausted"]);

/** 执行导出：collect（Gateway）→ detail（REST 拉资料）→ finalize */
async function runExport(
  taskId: string,
  target: MemberContext,
  signal: AbortController,
  settings: Settings,
  seedCheckpoint: PlannerCheckpoint | null = null,
): Promise<void> {
  const task = currentTask;
  if (!task || task.id !== taskId) return;
  runStartAt = Date.now();
  task.costTimes = "00h 00m 00s";
  try {
    let count = task.collected;
    let reason = "";
    let checkpoint: PlannerCheckpoint | undefined = seedCheckpoint ?? undefined;

    // 自动续跑：可续跑原因（整体超时 / 重连耗尽）下反复接续枚举，直到收齐或进入终态。
    // 每次迭代把已流式落盘的成员 id + 前缀断点作为种子去重并入，BFS 从断点继续而非从头再来。
    while (true) {
      const res = await fetchMembers({
        taskId,
        token: target.token,
        guildId: target.guildId,
        channelId: target.channelId,
        clientBuildNumber: target.clientBuildNumber,
        mode: task.options.mode,
        maxMembers: task.progressTarget || task.effectiveLimit,
        signal: signal.signal,
        shouldPause: () => !!currentTask?.paused,
        shouldStop: () => !!currentTask?.stopRequested,
        onStatus: (status) => {
          if (!currentTask || currentTask.id !== taskId) return;
          currentTask.status = status;
          saveTaskState(true);
        },
        onProgress: (c) => {
          if (!currentTask || currentTask.id !== taskId) return;
          currentTask.collected = c;
          saveTaskState();
        },
        seedCheckpoint: checkpoint ?? null,
      });

      if (!currentTask || currentTask.id !== taskId) return;
      const grew = res.count > count;
      count = res.count;
      reason = res.reason;
      checkpoint = res.checkpoint;
      currentTask.collected = count;
      currentTask.completeReason = reason;

      // 用户停止 / 进入终态（收齐或出错）/ 非 deep 模式的可续跑原因 → 退出续跑
      // 仅 deep 模式（全量前缀枚举）自动续跑；fast 是快速收一批，超时即停，避免 fast 也一路分页跑成全量。
      if (task.stopRequested || !RESUMABLE_REASONS.has(reason) || task.options.mode !== "deep") break;

      // deep 模式可续跑原因（整体超时 / 重连耗尽）：落盘断点后短暂退避，自动续跑。
      // 无新增时退避更久，避免紧追限流；有新增则快速接续。
      await putCheckpoint({
        taskId,
        planner: checkpoint ?? null,
        settings,
        count,
        savedAt: new Date().toISOString(),
      }).catch(() => void 0);
      await sleep(grew ? 500 : 5000, signal.signal).catch(() => { });
    }
    console.log('count::', count)
    console.log('===currentTask:', currentTask)

    // fast 模式 overall_timeout 直接收尾下载，不再进入 partial（保留 deep 的自动续跑，见上方 while 循环）
    if (!count && !task.stopRequested) throw Error("NO_MEMBERS_FOUND");
    console.log(1761)
    // 收集阶段是否是被用户中断的（终止/结束并导出）。用于在详情阶段结束后仍以「停止」状态收尾。
    let stoppedDuringCollect = false;
    if (task.options.fetchDetailedInfo && count) {
      currentTask.phase = "details";
      currentTask.status = "fetching_profiles";
      currentTask.detailTotal = count;
      await saveTaskState(true);

      // 收集阶段被用户中断时，之前会因 !task.stopRequested 直接跳过详情，导致只导出基础数据。
      // 这里改为：只要开启“获取详细资料”且已收集到成员，就继续对已收集成员拉详情。
      // 中断后原 signal 已被 abort 且 stopRequested 已置位，需清掉该标记并换一个全新的
      // AbortController 接管，让详情阶段仍可被暂停/停止/结束并导出正常控制。
      stoppedDuringCollect = task.stopRequested;
      const enrichAbort = new AbortController();
      if (stoppedDuringCollect) {
        currentTask.stopRequested = false;
        currentAbortController = enrichAbort;
      }
      const kept = await enrichProfiles(taskId, {
        token: target.token,
        guildId: target.guildId,
        tierFilter: task.options.tierFilter,
        signal: stoppedDuringCollect ? enrichAbort.signal : signal.signal,
        shouldPause: () => !!currentTask?.paused,
        shouldStop: () => !!currentTask?.stopRequested,
        onProgress: (done, total, kept) => {
          if (!currentTask || currentTask.id !== taskId) return;
          currentTask.detailCurrent = done;
          currentTask.detailTotal = total;
          currentTask.collected = kept;
          saveTaskState();
        },
      });
      if (stoppedDuringCollect) currentAbortController = null;
      if (!currentTask || currentTask.id !== taskId) return;
      currentTask.collected = kept;
      currentTask.detailTotal = kept;
    }
    console.log(1784)
    if (!currentTask || currentTask.id !== taskId) return;
    console.log(1785)
    await finalizeTask(task.stopRequested || stoppedDuringCollect ? "stopped" : "complete");
  } catch (err) {
    console.log(17888, err)
    if (!currentTask || currentTask.id !== taskId) return;
    if (task.stopRequested || signal.signal.aborted) {
      await finalizeTask("stopped");
    } else {
      currentTask.phase = "error";
      currentTask.error = err instanceof Error ? err.message : String(err);
      currentTask.status = "";
      currentTask.finishedAt = new Date().toISOString();
      await deleteCheckpoint(taskId).catch(() => void 0);
      await clearMemberStream(taskId).catch(() => void 0);
      await saveTaskState(true);
    }
  }
}

/** MV3 的 service worker 有约 30s 的空闲超时，且只有「扩展 API 调用/事件」才算活动，
 *  IndexedDB、fetch、纯 JS 计算都不计入。收尾 10w+ 条数据要跑几十秒到几分钟，
 *  期间若不调用扩展 API 会被浏览器直接杀掉 → 重启后触发 markRestartedTask 报 BACKGROUND_RESTARTED。
 *  这里用轻量 API 定期“打卡”重置空闲计时器，保证收尾/下载不被中途终止。 */
function startKeepAlive(intervalMs = 20e3): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    browser.runtime.getPlatformInfo().catch(() => void 0);
  }, intervalMs);
}

function stopKeepAlive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/** 收尾：从 member_stream 分批读成员 → 转行 → 写入 result_rows，标记完成 */
async function finalizeTask(phase: string): Promise<void> {
  console.log('finalizeTask::', phase, currentTask)
  if (!currentTask) return;
  const taskId = currentTask.id;

  startKeepAlive();
  try {
  // 流式收尾：分批读成员 → 转行 → 写入 result_rows，避免全量成员驻留内存
  const ids = await readMemberIds(taskId);
  const avatars: Array<{ id: string; username: string; url: string }> = [];
  let rowCount = 0;
  for (let i = 0; i < ids.length; i += ROW_BATCH) {
    const members = await readMembersByIds(taskId, ids.slice(i, i + ROW_BATCH));
    const rows = members.map(toExportRow);
    await appendRows(taskId, rowCount, rows);
    rowCount += rows.length;
    for (const m of members) {
      if (m.avatarUrl) avatars.push({ id: m.id, username: m.username, url: m.avatarUrl });
    }
    // 每批更新进度并顺带重置空闲计时器（storage.local.set + sendMessage 都是扩展 API）
    if (currentTask && currentTask.id === taskId) {
      currentTask.detailCurrent = rowCount;
      currentTask.detailTotal = ids.length;
      currentTask.status = "finalizing";
      await saveTaskState(true);
    }
  }

  currentTask.limitReached = currentTask.limitReached && currentTask.effectiveLimit > 0 && rowCount >= currentTask.effectiveLimit;

  if (rowCount) {
    await putResultMeta({
      taskId,
      avatars,
      context: currentTask.context,
      limitReached: currentTask.limitReached,
      rowCount,
    });
  } else {
    await deleteResult(taskId).catch(() => void 0);
  }

  await clearMemberStream(taskId).catch(() => void 0);
  await deleteCheckpoint(taskId).catch(() => void 0);

  currentTask.phase = phase;
  currentTask.status = "";
  currentTask.paused = false;
  currentTask.resultCount = rowCount;
  currentTask.finishedAt = new Date().toISOString();
  console.log(1827)
  await saveTaskState(true);
  } finally {
    stopKeepAlive();
  }
}

/** service worker 重启后，把遗留的"进行中"任务标记为错误 */
async function markRestartedTask(): Promise<void> {
  const task = await loadTask();
  if (!task || !ACTIVE_PHASES.has(task.phase)) return;
  await clearMemberStream(task.id).catch(() => void 0);
  await deleteCheckpoint(task.id).catch(() => void 0);
  const next: PublicTask = {
    ...task,
    phase: "error",
    paused: false,
    status: "",
    error: "BACKGROUND_RESTARTED",
    finishedAt: new Date().toISOString(),
  };
  await saveTask(next);
  browser.runtime.sendMessage({ type: "DME_TASK_UPDATED", task: next }).catch(() => void 0);
}

/** 恢复 session 里所有 tab 的上下文到内存 */
async function restoreContexts(): Promise<void> {
  const all = await browser.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SESSION_KEY_PREFIX) || !value) continue;
    const tabId = Number(key.slice(SESSION_KEY_PREFIX.length));
    if (Number.isFinite(tabId)) await syncContext(tabId, value as RawContext);
  }
}

async function clearContexts(): Promise<void> {
  const all = await browser.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(SESSION_KEY_PREFIX));
  if (keys.length) await browser.storage.session.remove(keys);
}

// ---- 定时任务（chrome.alarms）管理 ----
async function syncAlarm(schedule: Schedule): Promise<void> {
  const name = `${ALARM_PREFIX}${schedule.id}`;
  await browser.alarms.clear(name);
  if (schedule.enabled) await browser.alarms.create(name, { when: parseScheduleTime(schedule.time) });
}

async function reconcileAlarms(): Promise<void> {
  const schedules = await loadSchedules();
  const wantedIds = new Set(schedules.map((s) => s.id));
  const alarms = await browser.alarms.getAll();
  const byName = new Map(alarms.map((a) => [a.name, a]));
  await Promise.all(
    alarms
      .filter((a) => a.name.startsWith(ALARM_PREFIX) && !wantedIds.has(a.name.slice(ALARM_PREFIX.length)))
      .map((a) => browser.alarms.clear(a.name)),
  );
  await Promise.all(
    schedules.map(async (schedule) => {
      const name = `${ALARM_PREFIX}${schedule.id}`;
      const existing = byName.get(name);
      if (!schedule.enabled) {
        if (existing) await browser.alarms.clear(name);
        return;
      }
      if (!existing || existing.periodInMinutes) await syncAlarm(schedule);
    }),
  );
}

async function saveSchedule(input: Partial<Schedule> & Record<string, any>): Promise<Schedule> {
  const target = input.target || (await loadStoredTarget());
  if (!target || !hasTarget(target)) throw Error("DISCORD_CHANNEL_REQUIRED");
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(input.settings || (await loadSettings())) };
  const now = new Date().toISOString();
  const schedule: Schedule = {
    id: input.id || crypto.randomUUID(),
    enabled: input.enabled !== false,
    time: String(input.time || "09:00"),
    target,
    settings,
    createdAt: input.createdAt || now,
    updatedAt: now,
    lastExecuted: input.lastExecuted,
    lastResultCount: input.lastResultCount,
    lastError: input.lastError,
    lastLimitReached: input.lastLimitReached,
  };
  parseScheduleTime(schedule.time);
  await saveSchedules(upsertById(await loadSchedules(), schedule));
  await syncAlarm(schedule);
  return schedule;
}

async function deleteSchedule(id: string): Promise<void> {
  await saveSchedules((await loadSchedules()).filter((s) => s.id !== id));
  await browser.alarms.clear(`${ALARM_PREFIX}${id}`);
}

async function updateScheduleResult(id: string, task: PublicTask | null, error: string | null, executedAt: string): Promise<void> {
  const schedules = await loadSchedules();
  const existing = schedules.find((s) => s.id === id);
  if (!existing) return;
  await saveSchedules(
    upsertById(schedules, {
      ...existing,
      lastExecuted: executedAt,
      lastResultCount: task?.resultCount || 0,
      lastLimitReached: !!task?.limitReached,
      lastError: error ?? undefined,
      updatedAt: new Date().toISOString(),
    }),
  );
  browser.runtime.sendMessage({ type: "DME_SCHEDULES_UPDATED" }).catch(() => void 0);
}

/** 触发某个定时任务 */
async function runSchedule(id: string): Promise<PublicTask> {
  const schedule = (await loadSchedules()).find((s) => s.id === id);
  if (!schedule) throw Error("SCHEDULE_NOT_FOUND");
  if (!schedule.enabled) throw Error("SCHEDULE_DISABLED");
  const executedAt = new Date().toISOString();
  await syncAlarm(schedule);
  let start: { ok: true; task: PublicTask };
  try {
    start = await startExport({
      target: schedule.target,
      settings: schedule.settings,
      source: "scheduled",
      scheduleId: schedule.id,
      trackStart: false,
    });
  } catch (err) {
    await updateScheduleResult(id, null, err instanceof Error ? err.message : String(err), executedAt);
    throw err;
  }
  const taskId = start.task.id;
  const run = currentRunPromise;
  if (!run) {
    const reason = "SCHEDULE_START_FAILED";
    await updateScheduleResult(id, null, reason, executedAt);
    throw Error(reason);
  }
  run
    .then(async () => {
      const task = currentTask?.id === taskId ? stripTaskInternal(currentTask) : null;
      await updateScheduleResult(id, task, task?.phase === "error" ? task.error : task?.downloadError || "", executedAt);
    })
    .catch(async (err) => {
      await updateScheduleResult(id, null, err instanceof Error ? err.message : String(err), executedAt);
    })
    .catch(() => void 0);
  return start.task;
}

// ---- 消息路由 ----
async function handleMessage(message: RuntimeMessage, sender: MessageSender): Promise<any> {
  await initPromise;
  switch (message?.type) {
    case "DME_SYNC_CONTEXT": {
      if (!sender.tab?.id) return { ok: false };
      const context = await syncContext(sender.tab.id, message.context || {});
      if (hasTarget(context)) {
        const snapshot = stripAuth(context);
        browser.runtime.sendMessage({ type: "DME_CONTEXT_UPDATED", context: snapshot, tokenReady: !!context.token }).catch(() => void 0);
        return { ok: true, context: snapshot };
      }
      return { ok: true };
    }
    case "DME_GET_BOOTSTRAP": {
      const stored = await loadTask();
      const task =
        currentTask && ACTIVE_PHASES.has(currentTask.phase)
          ? stripTaskInternal(currentTask)
          : stored && !["complete", "stopped"].includes(stored.phase)
            ? stored
            : null;
      if (stored && ["complete", "stopped"].includes(stored.phase)) saveTask(null);
      const target = await resolveTarget(Number(message.tabId || 0));
      return {
        ok: true,
        task,
        context: target ? stripAuth(target) : null,
        tokenReady: !!target?.token,
        schedules: await loadSchedules(),
      };
    }
    case "DME_GET_CONTEXT": {
      const target = await resolveTarget(Number(message.tabId || 0));
      return {
        ok: !!(target?.token && hasTarget(target)),
        context: target ? stripAuth(target) : null,
        tokenReady: !!target?.token,
      };
    }
    case "DME_START_EXPORT": {
      const settings: Settings = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
      console.log('settings===', settings)
      return startExport({
        tabId: Number(message.tabId || 0),
        target: message.target,
        settings,
        entitlement: message.entitlement,
        source: "manual",
        trackStart: true,
      });
    }
    case "DME_PAUSE":
      if (currentTask && ["collecting", "details"].includes(currentTask.phase)) {
        currentTask.paused = true;
        currentTask.phase = "paused";
        currentTask.status = "";
        trackEvent("export_paused", { count: currentTask.collected });
        await saveTaskState(true);
      }
      return { ok: true };
    case "DME_RESUME":
      if (currentTask?.phase === "paused") {
        currentTask.paused = false;
        currentTask.phase = currentTask.detailTotal > 0 ? "details" : "collecting";
        currentTask.status =
          currentTask.detailTotal > 0
            ? "fetching_profiles"
            : currentTask.options.mode === "deep"
              ? "gateway_deep_search"
              : "gateway_requesting_members";
        trackEvent("export_resumed", { count: currentTask.collected });
        await saveTaskState(true);
      }
      return { ok: true };
    case "DME_STOP":
      if (currentTask && ACTIVE_PHASES.has(currentTask.phase)) {
        currentTask.stopRequested = true;
        currentTask.paused = false;
        currentAbortController?.abort();
        trackEvent(message.finishNow ? "partial_export_clicked" : "export_stopped", { count: currentTask.collected });
        await saveTaskState(true);
      }
      return { ok: true };
    case "DME_GET_SCHEDULES":
      return { ok: true, schedules: await loadSchedules() };
    case "DME_SAVE_SCHEDULE": {
      const schedule = await saveSchedule(message.task || {});
      trackEvent("schedule_saved", { time: schedule.time, enabled: schedule.enabled });
      browser.runtime.sendMessage({ type: "DME_SCHEDULES_UPDATED" }).catch(() => void 0);
      return { ok: true, task: schedule };
    }
    case "DME_DELETE_SCHEDULE":
      await deleteSchedule(String(message.id || ""));
      trackEvent("schedule_deleted");
      browser.runtime.sendMessage({ type: "DME_SCHEDULES_UPDATED" }).catch(() => void 0);
      return { ok: true };
    case "DME_TOGGLE_SCHEDULE": {
      const schedule = (await loadSchedules()).find((s) => s.id === String(message.id || ""));
      if (!schedule) throw Error("SCHEDULE_NOT_FOUND");
      const updated = await saveSchedule({ ...schedule, enabled: !!message.enabled });
      trackEvent("schedule_toggled", { enabled: updated.enabled });
      browser.runtime.sendMessage({ type: "DME_SCHEDULES_UPDATED" }).catch(() => void 0);
      return { ok: true, task: updated };
    }
    case "DME_RUN_SCHEDULE_NOW":
      trackEvent("schedule_run_now_clicked");
      return { ok: true, task: await runSchedule(String(message.id || "")) };
    case "DME_CLEAR_DISCORD_ACCESS":
      tabContextCache.clear();
      targetCache.clear();
      guildCache.clear();
      await clearDiscordAccess();
      await clearContexts();
      trackEvent("discord_access_cleared");
      return { ok: true };
    case "DME_TRACK":
      await trackEvent(String(message.operate || "unknown"), message.extras || {});
      return { ok: true };
    case "DME_CLEAR_TASK": {
      const taskId = String(message.taskId || currentTask?.id || "");
      if (currentTask) currentTask.stopRequested = true;
      currentAbortController?.abort();
      currentAbortController = null;
      currentTask = null;
      await saveTask(null);
      await clearResults().catch(() => void 0);
      if (taskId) {
        await deleteCheckpoint(taskId).catch(() => void 0);
        await clearMemberStream(taskId).catch(() => void 0);
      }
      return { ok: true };
    }
    case "DME_CONTINUE_EXPORT": {
      const taskId = String(message.taskId || currentTask?.id || "");
      const partial =
        (currentTask && currentTask.id === taskId && currentTask.phase === "partial" ? currentTask : null) ||
        (await loadTask());
      const task = partial && partial.id === taskId && partial.phase === "partial" ? partial : null;
      if (!task) return { ok: false, error: "NO_RESUMABLE_TASK" };
      const ck = await loadCheckpoint(taskId);
      if (!ck || !ck.count) return { ok: false, error: "NO_CHECKPOINT" };
      return startExport({
        tabId: task.tabId,
        target: task.context,
        settings: ck.settings,
        source: "manual",
        trackStart: false,
        resume: {
          taskId,
          collected: ck.count,
          planner: ck.planner ?? null,
          requestedLimit: task.requestedLimit,
          effectiveLimit: task.effectiveLimit,
          limitReached: task.limitReached,
        },
      });
    }
    case "DME_FINALIZE": {
      const taskId = String(message.taskId || currentTask?.id || "");
      const partial =
        (currentTask && currentTask.id === taskId && currentTask.phase === "partial" ? currentTask : null) ||
        (await loadTask());
      const task = partial && partial.id === taskId && partial.phase === "partial" ? partial : null;
      if (!task) return { ok: false, error: "NO_RESUMABLE_TASK" };
      const ck = await loadCheckpoint(taskId);
      if (!ck || !ck.count) return { ok: false, error: "NO_CHECKPOINT" };

      // 若 SW 重启后 currentTask 不在内存，用持久化的 partial 任务重建（成员本体在 member_stream，收尾时流式读取）
      if (!currentTask || currentTask.id !== taskId || currentTask.phase !== "partial") {
        currentTask = { ...task, stopRequested: false } as Task;
      }
      currentTask.collected = ck.count;
      await finalizeTask("complete");
      try {
        const output = await downloadViaOffscreen(taskId, ck.settings, ck.settings.language);
        if (!currentTask || currentTask.id !== taskId) return { ok: true, task: null };
        currentTask.downloaded = true;
        currentTask.filename = output.filename;
        currentTask.downloadError = output.avatarFailures ? `AVATAR_DOWNLOAD_INCOMPLETE:${output.avatarFailures}` : "";
      } catch (err) {
        if (!currentTask || currentTask.id !== taskId) return { ok: false, error: err instanceof Error ? err.message : String(err) };
        currentTask.downloadError = err instanceof Error ? err.message : String(err);
      }
      await saveTaskState(true);
      await saveTask(null);
      return { ok: true, task: stripTaskInternal(currentTask) };
    }
    default:
      return { ok: false, error: "UNKNOWN_MESSAGE" };
  }
}

// ============================================================
// 注册所有监听器
// ============================================================
export default defineBackground(() => {
  paymentClient.startBackground();

  initPromise = (async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => void 0);
    await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => void 0);
    await clearResults().catch(() => void 0);
    await restoreContexts().catch(() => void 0);
    await markRestartedTask().catch(() => void 0);
    await reconcileAlarms().catch(() => void 0);
  })();

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // 保持消息通道打开，等待异步响应
  });

  browser.action.onClicked.addListener(() => {
    trackEvent("sidepanel_toggled");
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith(ALARM_PREFIX))
      runSchedule(alarm.name.slice(ALARM_PREFIX.length)).catch(() => void 0);
  });

  browser.runtime.onStartup.addListener(() => {
    reconcileAlarms();
  });

  browser.runtime.onInstalled.addListener(() => {
    reconcileAlarms().catch(() => void 0);
    clearResults().catch(() => void 0);
    saveTask(null).catch(() => void 0);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    tabContextCache.delete(tabId);
    browser.storage.session.remove(SESSION_KEY_PREFIX + tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && !tab.url?.includes("discord.com/")) {
      tabContextCache.delete(tabId);
      browser.storage.session.remove(SESSION_KEY_PREFIX + tabId);
    }
  });
});
