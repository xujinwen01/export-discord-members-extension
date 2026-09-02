/*
// entrypoints/example.content.ts
// import { defineContentScript } from 'wxt/sandbox';

export default defineContentScript({
  // 匹配的 URL 模式，支持通配符
  matches: ['https://*.example.com/*'],
  
  // 可选：排除某些 URL
  excludeMatches: ['https://admin.example.com/*'],
  
  // 可选：脚本运行时机（'document_start' | 'document_end' | 'document_idle'）
  runAt: 'document_end',
  
  // 可选：是否在所有框架中运行（默认只运行在顶层框架）
  allFrames: false,
  
  // 可选：是否在 about:blank 等空白页面运行
  matchAboutBlank: false,
  
  // 主要逻辑函数
  main() {
    // 这里是你操作网页 DOM 的代码
    console.log('内容脚本已注入！');
    
    // 例如：修改页面标题
    document.title = '被扩展修改的标题';
  },
});
*/

// const defineContentScript = (cfg) => cfg;

// ---- 缓存的当前上下文（最近一次从 MAIN world 收到的）----
interface CurrentContext {
  token: string,
  clientBuildNumber: number | undefined,
  guildId: string,
  channelId: string,
  serverName: string,
  channelName: string,
  avatar: string
}
let currentContext: CurrentContext | null;

// 请求 MAIN world 的脚本（discord-main.js）上报最新上下文
function requestContextFromMainWorld() {
  window.postMessage(
    { source: "discord-member-exporter-content", type: "REQUEST_CONTEXT" },
    location.origin,
  );
}

// const discordContent = defineContentScript({
//   matches: ["https://discord.com/*", "https://*.discord.com/*"],
//   // runAt: "document_start",

//   // main() {
//   // }
// })

export default defineContentScript({
  // 匹配的 URL 模式，支持通配符
  matches: ["https://discord.com/*", "https://*.discord.com/*"],
  runAt: 'document_start',
  
  // 主要逻辑函数
  main() {
    // 1) 接收 MAIN world 发来的 CONTEXT，字段转字符串后缓存，再转发给 background
    window.addEventListener("message", (event) => {
      console.log('discord.content.js 71==', event)
      if (
        event.source !== window ||
        event.data?.source !== "discord-member-exporter-main" ||
        event.data?.type !== "CONTEXT"
      ) {
        return;
      }

      const payload = event.data.payload || {};
      currentContext = {
        token: String(payload.token || ""),
        clientBuildNumber:
          Math.floor(Number(payload.clientBuildNumber || 0)) || undefined,
        guildId: String(payload.guildId || ""),
        channelId: String(payload.channelId || ""),
        serverName: String(payload.serverName || ""),
        channelName: String(payload.channelName || ""),
        avatar: String(payload.avatar || ""),
      };

      // 转发给 background service worker
      browser.runtime
        .sendMessage({ type: "DME_SYNC_CONTEXT", context: currentContext })
        .catch(() => void 0);
    });

    // 2) 响应 background 的主动拉取：先触发 MAIN world 上报，再回传缓存的上下文
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log('discord.content.js == 100', message, sendResponse)
      if (message?.type === "DME_PULL_CONTEXT") {
        requestContextFromMainWorld();
        setTimeout(
          () =>
            sendResponse({
              ok: !!currentContext?.token,
              context: currentContext,
            }),
          300,
        );
        return true; // 保持消息通道打开，等待异步 sendResponse
      }
    });

    requestContextFromMainWorld(); // 启动时先主动要一次
  },
});

// // 启动
// (async () => {
//   try {
//     const { main, ...options } = discordContent;
//     console.log('main !!')
//     // await main(new ContentScriptContext("discord", options));
//   } catch (err) {
//     throw err;
//   }
// })();
