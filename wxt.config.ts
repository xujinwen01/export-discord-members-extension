import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: "dist",
  manifest: {
    action: {
      // 保留工具栏图标，但点击后由 background 打开侧边栏，而不是弹窗
      default_title: 'Open Side Panel',
    },
    permissions: ['storage', 'alarms', 'offscreen', 'sidePanel', 'tabs', 'downloads'],
    host_permissions: [
      'https://discord.com/*',
      'https://*.discord.com/*',
      'https://cdn.discordapp.com/*',
    ],
  },
});
