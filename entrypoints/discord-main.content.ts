export default defineContentScript({
  // 匹配的 URL 模式，支持通配符
  matches: ["https://discord.com/*", "https://*.discord.com/*"],
  // 可选：脚本运行时机（'document_start' | 'document_end' | 'document_idle'）
  runAt: 'document_start',
  world: "MAIN", // ← 关键：运行在页面主世界，与 Discord 网页共享 JS 上下文
  // 主要逻辑函数
  main() {
    // 这里是你操作网页 DOM 的代码
    console.log('内容脚本已注入2222！');
    // 例如：修改页面标题
    // document.title = '被扩展修改的标题';
    let token = "";            // 偷到的用户 Bearer token
    let clientBuildNumber = 0; // Discord 客户端 build 号
    let lastContext = "";      // 上次发出的上下文 JSON（用于去重）

    // ---- 清洗 token：去掉 "Bearer " 前缀、引号、空白 ----
    const cleanToken = (raw: string) => {
      if (typeof raw !== "string") return "";
      let v = raw.trim();
      try {
        const parsed = JSON.parse(v); // 有些地方 token 被 JSON 包了一层字符串
        if (typeof parsed === "string") v = parsed.trim();
      } catch {}
      return v.replace(/^Bearer\s+/i, "").replace(/^"+|"+$/g, "").trim();
    };

    // ---- 写入 token + build number ----
    const setCreds = (tok: string, build?: string) => {
      const t = cleanToken(tok);
      if (t) token = t;
      const b = Math.floor(Number(build || 0));
      if (Number.isFinite(b) && b > 0) clientBuildNumber = b;
    };

    // ---- 从请求头里抠 authorization ----
    const grabAuth = (headers?: HeadersInit) => {
      if (!headers) return;
      try {
        let h;
        if (headers instanceof Headers) {
          h = headers.get("authorization");
        } else if (Array.isArray(headers)) {
          h = headers.find(([k]) => k.toLowerCase() === "authorization")?.[1];
        } else {
          h = Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1]; 
        }
        setCreds(h as string);
      } catch {}
    };

    // ---- 兜底：从 localStorage 直接读 ----
    const fromStorage = () => {
      try {
        return (
          cleanToken(localStorage.getItem("best_discord_exporter_token") as string) ||
          cleanToken(localStorage.getItem("token") as string)
        );
      } catch {
        return "";
      }
    };

    // ---- 从 DOM 提取服务器名 / 频道名 ----
    const getNames = () => {
      const titleParts = (document.title || "")
        .split("|")
        .map((s) => s.trim().replace(/^#/, ""))
        .filter(Boolean);
      const channelName =
        document.querySelector(
          '[aria-label*="Channel header" i] h1, main h1, [class*="titleWrapper"] h1'
        )?.textContent?.trim() || "";
      const serverName =
        document.querySelector(
          'nav [aria-current="page"][aria-label], nav [class*="selected"] [aria-label]'
        )?.getAttribute("aria-label")?.trim() || "";
      return { channelName: channelName || titleParts[0] || "", serverName: serverName || titleParts[1] || "" };
    };
    // ---- 汇总完整上下文 ----
    const buildContext = () => {
      const m = /^\/channels\/([^/]+)\/([^/?#]+)/.exec(location.pathname);
      const guildId = m?.[1] === "@me" ? "" : (m?.[1] || ""); // @me 是私信，不是服务器
      const channelId = (guildId && m?.[2]) || "";
      const names = getNames();
      const avatar =
        (document.querySelector('nav [aria-current="page"] img, nav [class*="selected"] img') as HTMLImageElement | null)?.src || "";
      return {
        token: token || fromStorage(), // 优先用 hook 到的，其次读 localStorage
        clientBuildNumber,
        guildId,
        channelId,
        serverName: names.serverName,
        channelName: names.channelName,
        avatar,
        href: location.href,
      };
    };

    // ---- 发上下文给隔离世界的 content script（带去重）----
    const postContext = (force = false) => {
      const ctx = buildContext();
      console.log(56, ctx)
      const json = JSON.stringify(ctx);
      if (!force && json === lastContext) return; // 内容没变就不重复发
      lastContext = json;
      window.postMessage(
        { source: "discord-member-exporter-main", type: "CONTEXT", payload: ctx },
        location.origin
      );
    };

    // ============ Hook 1：window.fetch ============
    const realFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const [url, opts] = args;
        grabAuth(opts?.headers);
        if (url instanceof Request) grabAuth(url.headers);
        if (token) queueMicrotask(() => postContext());
      } catch {}
      return realFetch.apply(this, args);
    };

    // ============ Hook 2：XMLHttpRequest.setRequestHeader ============
    const realSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (name.toLowerCase() === "authorization") {
        setCreds(value);
        queueMicrotask(() => postContext());
      }
      return realSetRequestHeader.call(this, name, value);
    };

    // ============ Hook 3：WebSocket.send（拦截 IDENTIFY 登录帧）============
    // Discord 网页版连 Gateway 时发的 `{"op":2,"d":{"token":...}}` 就在这里被截获
    const realWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        if (typeof data === "string" && data.includes('"op":2')) {
          const p = JSON.parse(data);
          setCreds(p?.d?.token, p?.d?.properties?.client_build_number);
          queueMicrotask(() => postContext());
        }
      } catch {}
      return realWsSend.call(this, data);
    };

    // ============ Hook 4：history（SPA 路由变化时重发）============
    type HistoryMethod = 'pushState' | 'replaceState';
    const hookHistory = (method: HistoryMethod) => {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        queueMicrotask(() => postContext(true));
        setTimeout(() => postContext(true), 250);
        return result;
      };
    };
    hookHistory("pushState");
    hookHistory("replaceState");

    window.addEventListener("popstate", () => postContext(true));
    window.addEventListener("hashchange", () => postContext(true));
    window.addEventListener("load", () => postContext(true), { once: true });

    // 响应隔离世界 content script 的主动拉取请求
    window.addEventListener("message", (event) => {
      if (
        event.source === window &&
        event.data?.source === "discord-member-exporter-content" &&
        event.data?.type === "REQUEST_CONTEXT"
      ) {
        postContext(true);
      }
    });

    postContext(true);                       // 立即发一次
    // setInterval(() => postContext(), 1000);  // 每秒兜底发一次
  },
});