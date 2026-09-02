import { useEffect, useState, type ChangeEvent } from 'react';
import {
  ReloadOutlined,
  DownloadOutlined,
  SettingOutlined,
  CheckCircleFilled,
  LoadingOutlined,
  PauseOutlined,
  CaretRightOutlined,
  StopOutlined,
  DownOutlined,
  RightOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { Button, Radio, type RadioChangeEvent, Switch, Select } from 'antd';
import './App.css';
import icon48 from '@/assets/icon48.png';

const DISCORD_URLS = ['https://discord.com/*', 'https://*.discord.com/*'];

// 进行中的导出阶段（显示进度条、且视为「运行中」）
const ACTIVE_PHASES = new Set(['collecting', 'details', 'paused']);

interface ContextInfo {
  tabId?: number;
  guildId: string;
  channelId: string;
  serverName: string;
  channelName: string;
  avatar: string;
  memberCount?: number;
  updatedAt: number;
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

interface Stats {
  successfulExports: number;
  exportedMembers: number;
  lastExportAt: string | null;
}

interface Schedule {
  id: string;
  enabled: boolean;
  time: string;
  target?: { guildId?: string; channelId?: string };
  [key: string]: unknown;
}

interface Task {
  id: string;
  phase: string;
  collected: number;
  totalMembers: number;
  paused: boolean;
  status: string;
  completeReason?: string;
  progressTarget: number;
  detailCurrent: number;
  detailTotal: number;
  resultCount: number;
  limitReached: boolean;
  error: string;
  downloaded: boolean;
  filename: string;
  context?: { serverName?: string; channelName?: string; memberCount?: number };
  options?: { tierFilter?: number; fetchDetailedInfo?: boolean; mode?: string; memberLimit?: number };
  [key: string]: unknown;
}

const KEY_SETTINGS = 'dme:settings:v1';
const KEY_STATS = 'dme:stats:v1';

const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  theme: 'system',
  mode: 'fast',
  memberLimit: 0,
  fetchDetailedInfo: false,
  tierFilter: 0,
  format: 'xlsx',
  downloadAvatars: false,
  downloadFolder: 'Discord Member Exports',
  enabledBasicColumns: [
    'avatarUrl', 'id', 'username', 'nickname', 'accountCreated', 'joinedAt',
    'roles', 'status', 'activity',
  ],
  enabledDetailedColumns: [
    'globalName', 'nitroTier', 'nitroType', 'nitroSince', 'bio',
    'serverBoostSince', 'connectedAccounts', 'badges',
  ],
  filenameTemplate: '{serverName}_{channelName}_{datetime}_{memberCount}',
};

const DEFAULT_STATS: Stats = { successfulExports: 0, exportedMembers: 0, lastExportAt: null };

interface ColumnDef {
  key: string;
  label: string;
}

const BASIC_COLUMNS: ColumnDef[] = [
  { key: 'avatarUrl', label: '头像 URL' },
  { key: 'id', label: '用户 ID' },
  { key: 'username', label: '用户名' },
  { key: 'nickname', label: '昵称' },
  { key: 'accountCreated', label: '账号创建时间' },
  { key: 'joinedAt', label: '加入服务器时间' },
  { key: 'roles', label: '角色 ID' },
  { key: 'status', label: '状态' },
  { key: 'activity', label: '活动' },
];

const DETAILED_COLUMNS: ColumnDef[] = [
  { key: 'globalName', label: '全局昵称' },
  { key: 'nitroTier', label: 'Nitro 等级' },
  { key: 'nitroType', label: 'Nitro 类型' },
  { key: 'nitroSince', label: 'Nitro 开通时间' },
  { key: 'bio', label: '个人简介' },
  { key: 'serverBoostSince', label: '服务器加速时间' },
  { key: 'connectedAccounts', label: '关联账户' },
  { key: 'badges', label: '徽章' },
];

/** Nitro 等级筛选选项（level 0 = 不限，1-8 对应 background NITRO_TIER_SKUS 的等级） */
const TIER_OPTIONS = [
  { value: 0, label: '不限' },
  { value: 1, label: '铜牌 · 1 个月' },
  { value: 2, label: '银牌 · 3 个月' },
  { value: 3, label: '金牌 · 6 个月' },
  { value: 4, label: '白金 · 1 年' },
  { value: 5, label: '钻石 · 2 年' },
  { value: 6, label: '翡翠 · 3 年' },
  { value: 7, label: '红宝石 · 5 年' },
  { value: 8, label: '火焰蛋白石 · 6 年' },
];

async function loadSettings(): Promise<Settings> {
  try {
    const stored = await browser.storage.local.get(KEY_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(stored[KEY_SETTINGS] || {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function loadStats(): Promise<Stats> {
  try {
    const stored = await browser.storage.local.get(KEY_STATS);
    return { ...DEFAULT_STATS, ...(stored[KEY_STATS] || {}) };
  } catch {
    return DEFAULT_STATS;
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  try {
    await browser.storage.local.set({ [KEY_SETTINGS]: settings });
  } catch (err) {
    console.error('[saveSettings] 保存失败:', err);
  }
}

function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [context, setContext] = useState<ContextInfo | null>(null);
  const [tokenReady, setTokenReady] = useState(false);
  const [status, setStatus] = useState('');
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState<Task | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [stats, setStats] = useState<Stats>(DEFAULT_STATS);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleStatus, setScheduleStatus] = useState('');

  // 找到活跃的 Discord 标签页（优先当前激活页）。找不到返回 null。
  const findDiscordTab = async (): Promise<number | null> => {
    const tabs = await browser.tabs.query({ url: DISCORD_URLS });
    const active = tabs.find((t) => t.active) || tabs[0];
    return active?.id ?? null;
  };

  // 从 background 拉取当前上下文（token 是否就绪 + 服务器/频道）。
  // 注意：即使没找到 tab，也要发消息 —— background 的 resolveTarget 会回退到
  // content script 已同步的 storedAuth/storedTarget。
  const refreshContext = async () => {
    console.log(202)
    let id: number | null = null;
    try {
      id = await findDiscordTab();
    } catch (err) {
      console.error('[refreshContext] tabs.query 失败:', err);
    }
    setTabId(id);
    console.log('[refreshContext] 找到的 tabId =', id);
    console.log(211, id)

    try {
      const resp = await browser.runtime.sendMessage({
        type: 'DME_GET_CONTEXT',
        tabId: id ?? 0,
      });
      console.log('[refreshContext] DME_GET_CONTEXT 响应 =', resp);

      const ctx = resp?.context;
      setTokenReady(!!resp?.tokenReady);
      setContext(
        ctx
          ? {
              tabId: ctx.tabId,
              guildId: ctx.guildId || '',
              channelId: ctx.channelId || '',
              serverName: ctx.serverName || '',
              channelName: ctx.channelName || '',
              avatar: ctx.avatar || '',
              memberCount: ctx.memberCount,
              updatedAt: ctx.updatedAt || 0,
            }
          : null,
      );
    } catch (err) {
      console.error('[refreshContext] sendMessage 失败:', err);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  // 初始化：并行拉取 settings / stats / bootstrap（task + context + tokenReady + schedules）
  useEffect(() => {
    (async () => {
      try {
        let id: number | null = null;
        try {
          id = await findDiscordTab();
        } catch (err) {
          console.error('[bootstrap] tabs.query 失败:', err);
        }
        setTabId(id);

        const [loadedSettings, loadedStats, bootstrap] = await Promise.all([
          loadSettings(),
          loadStats(),
          browser.runtime.sendMessage({ type: 'DME_GET_BOOTSTRAP', tabId: id ?? 0 }),
        ]);

        setSettings(loadedSettings);
        setStats(loadedStats);

        const ctx = bootstrap?.context;
        setTokenReady(!!bootstrap?.tokenReady);
        setContext(
          ctx
            ? {
                tabId: ctx.tabId,
                guildId: ctx.guildId || '',
                channelId: ctx.channelId || '',
                serverName: ctx.serverName || '',
                channelName: ctx.channelName || '',
                avatar: ctx.avatar || '',
                memberCount: ctx.memberCount,
                updatedAt: ctx.updatedAt || 0,
              }
            : null,
        );
        setTask(bootstrap?.task || null);
        setSchedules(bootstrap?.schedules || []);
      } catch (err) {
        console.error('[bootstrap] 初始化失败:', err);
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 订阅 background 广播：任务进度 / 上下文 / 定时任务 / 统计
  useEffect(() => {
    const onMessage = (message: any) => {
      if (message?.type === 'DME_TASK_UPDATED') {
        setTask(message.task);
        if (['complete', 'stopped', 'error'].includes(message.task?.phase)) setStatus('');
      } else if (message?.type === 'DME_CONTEXT_UPDATED') {
        setTokenReady(!!message.tokenReady);
        setContext(message.context || null);
      } else if (message?.type === 'DME_SCHEDULES_UPDATED') {
        browser.runtime
          .sendMessage({ type: 'DME_GET_SCHEDULES' })
          .then((resp) => setSchedules(resp?.schedules || []))
          .catch(() => void 0);
      } else if (message?.type === 'DME_STATS_UPDATED' && message.stats) {
        setStats(message.stats);
      }
    };

    const onTabChanged = () => void refreshContext();

    browser.runtime.onMessage.addListener(onMessage);
    browser.tabs?.onActivated?.addListener(onTabChanged);
    browser.tabs?.onUpdated?.addListener(onTabChanged);

    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      browser.tabs?.onActivated?.removeListener(onTabChanged);
      browser.tabs?.onUpdated?.removeListener(onTabChanged);
    };
  }, []);

  // 订阅 storage 变更：options 页（或别处）改了设置时，实时同步到 sidepanel
  useEffect(() => {
    const onStorageChanged = (changes: any, areaName: string) => {
      if (areaName !== 'local' || !changes[KEY_SETTINGS]) return;
      void loadSettings()
        .then(setSettings)
        .catch(() => void 0);
    };
    browser.storage.onChanged.addListener(onStorageChanged);
    return () => browser.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  const runExport = async () => {
    if (starting) return;
    // 校验至少选中一列，避免导出空表格
    const columnCount =
      settings.enabledBasicColumns.length +
      (settings.fetchDetailedInfo ? settings.enabledDetailedColumns.length : 0);
    if (columnCount === 0) {
      setStatus('请至少选择一列要导出的数据');
      return;
    }
    setStarting(true);
    setStatus('');
    try {
      const resp = await browser.runtime.sendMessage({
        type: 'DME_START_EXPORT',
        tabId: tabId ?? 0,
        target: context || undefined,
        settings,
      });
      if (resp?.ok) {
        setTask(resp.task || null);
      } else {
        setStatus(translateError(resp?.error));
      }
    } catch (err) {
      console.error('[runExport] sendMessage 失败:', err);
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  // 暂停 / 继续（background 依据 currentTask.paused 切换）
  const pauseOrResumeExport = () => {
    if (!task) return;
    browser.runtime
      .sendMessage({ type: task.paused ? 'DME_RESUME' : 'DME_PAUSE' })
      .catch(() => void 0);
  };

  const stopExport = () => {
    browser.runtime.sendMessage({ type: 'DME_STOP' }).catch(() => void 0);
  };

  // 结束并导出当前已收集的成员（部分导出）
  const finishExport = () => {
    browser.runtime
      .sendMessage({ type: 'DME_STOP', finishNow: true })
      .catch(() => void 0);
  };

  // 超时中断后「继续导出」：从断点续跑（复用上次任务 id 与已收集成员）
  const continueExport = async () => {
    if (!task || starting) return;
    setStarting(true);
    setStatus('');
    try {
      const resp = await browser.runtime.sendMessage({ type: 'DME_CONTINUE_EXPORT', taskId: task.id });
      if (resp?.ok) {
        setTask(resp.task || null);
      } else {
        setStatus(translateError(resp?.error));
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  // 超时中断后「结束并导出」：把已收集的成员直接生成表格下载
  const finalizePartial = async () => {
    if (!task || starting) return;
    setStarting(true);
    setStatus('');
    try {
      const resp = await browser.runtime.sendMessage({ type: 'DME_FINALIZE', taskId: task.id });
      if (resp?.ok) {
        setTask(resp.task || null);
      } else {
        setStatus(translateError(resp?.error));
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };


  // 通用设置更新：更新内存并持久化到 storage
  const updateSettings = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next: Settings = { ...settings, [key]: value };
    setSettings(next);
    void saveSettings(next);
  };

  const onNumberChange = (e: RadioChangeEvent) => {
    const value = e.target.value;
    // 「全部」→ 0（不限），其余预设转成数字
    updateSettings('memberLimit', value === 'all' ? 0 : Number(value) || 0);
  };

  // 手动输入成员数量：清空输入框等同于「全部」
  const onNumberInput = (e: ChangeEvent<HTMLInputElement>) => {
    updateSettings('memberLimit', Number(e.target.value) || 0);
  };

  const onDetailChange = (checked: boolean) => {
    // 关闭详细资料时，等级筛选不再生效，重置为「不限」
    const next: Settings = {
      ...settings,
      fetchDetailedInfo: checked,
      ...(checked ? {} : { tierFilter: 0 }),
    };
    setSettings(next);
    void saveSettings(next);
  };

  const onTierChange = (value: number) => {
    updateSettings('tierFilter', value);
  };

  const onAvaterChange = (checked: boolean) => {
    updateSettings('downloadAvatars', checked);
  };

  const changeMode = (mode: string) => {
    return () => updateSettings('mode', mode);
  };

  const updateFormat = (format: string) => {
    updateSettings('format', format);
  };

  // 从 task 推导运行状态（不再依赖独立 running/paused 标志）
  const isRunning = !!task && ACTIVE_PHASES.has(task.phase);
  const isPaused = task?.paused ?? false;
  const isPartial = task?.phase === 'partial';
  const canExport = !!(context?.guildId && context?.channelId && tokenReady);

  // 当前频道对应的定时任务（有则回填时间并展示状态）
  const matchingSchedule =
    schedules.find(
      (s) => s.target?.guildId === context?.guildId && s.target?.channelId === context?.channelId,
    ) || null;

  useEffect(() => {
    if (matchingSchedule) setScheduleTime(matchingSchedule.time);
  }, [matchingSchedule?.id, matchingSchedule?.time]);

  // 主题切换：把 settings.theme 应用到 <html data-theme>（CSS 据此切换明暗）
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme || 'system';
  }, [settings.theme]);

  const saveSchedule = async () => {
    if (!canExport) {
      setScheduleStatus('未获取到频道，无法保存定时任务');
      return;
    }
    setScheduleStatus('');
    try {
      const resp = await browser.runtime.sendMessage({
        type: 'DME_SAVE_SCHEDULE',
        task: {
          ...(matchingSchedule || {}),
          id: matchingSchedule?.id,
          enabled: true,
          time: scheduleTime,
          target: context,
          settings,
        },
      });
      setScheduleStatus(resp?.ok ? '已保存' : translateError(resp?.error));
    } catch (err) {
      setScheduleStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const runScheduleNow = async () => {
    if (!matchingSchedule) return;
    try {
      const resp = await browser.runtime.sendMessage({
        type: 'DME_RUN_SCHEDULE_NOW',
        id: matchingSchedule.id,
      });
      if (resp?.ok) {
        setScheduleStatus('正在连接…');
        if (resp.task) setTask(resp.task);
      } else {
        setScheduleStatus(translateError(resp?.error));
      }
    } catch (err) {
      setScheduleStatus(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return (
      <div className="app">
        <main className="app-shell loading-shell">
          <div className="loading-logo">
            <img src={icon48} alt="" />
          </div>
          <p>Discord 成员导出</p>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="app-shell">
        <header className="app-header">
          <div className="brand-lockup">
            <img alt="" src={icon48} />
            <div>
              <strong>Discord 成员导出</strong>
              <span>导出你有权访问的服务器成员</span>
            </div>
          </div>
          <div className="header-actions">
            <Button
              className="icon-button"
              title="设置"
              icon={<SettingOutlined color="#fff" />}
              onClick={() =>
                void browser.tabs
                  .create({ url: browser.runtime.getURL('/options.html#general') })
                  .catch(() => void 0)
              }
            />
          </div>
        </header>
        <section className="app-scroll">
          <section className={`context-strip ${tokenReady && context ? 'ready' : ''}`}>
            <div className="context-avatar">
              <img alt="" src={context?.avatar || icon48} />
            </div>
            <div className="context-copy">
              <small>
                {context ? '已保存的后台频道' : tokenReady ? '已获取登录态，但尚未进入频道' : '未获取登录态'}
              </small>
              <strong>{context?.serverName || '未检测到服务器'}</strong>
              <span>
                {context
                  ? `#${context.channelName}${context.memberCount ? ` · ${context.memberCount.toLocaleString()} 名成员` : ''}`
                  : '请先进入某个 Discord 频道'}
              </span>
            </div>
            <Button className="icon-button" title="刷新" icon={<ReloadOutlined />} onClick={refreshContext}></Button>
          </section>
          <section className="control-section">
            <div className="section-label">
              <span>01</span>
              <strong>即时导出</strong>
            </div>
            <div className="mode-grid">
              <button className={settings.mode === 'fast' ? 'active' : ''} onClick={changeMode('fast')}>
                <strong>快速</strong>
                <span>适合可见成员列表</span>
              </button>
              <button className={settings.mode === 'deep' ? 'active' : ''} onClick={changeMode('deep')}>
                <strong>深度</strong>
                <span>查找未显示在可见列表中的隐藏成员</span>
              </button>
            </div>
          </section>
          <section className="control-section">
            <div className="field-heading">
              <label>成员数量</label>
              <span>成员数量不限</span>
            </div>
            <input
              className="number-input"
              min="0"
              placeholder="全部"
              value={settings.memberLimit === 0 ? '' : settings.memberLimit}
              onChange={onNumberInput}
            />
            <Radio.Group
              className="chip-row"
              onChange={onNumberChange}
              value={settings.memberLimit === 0 ? 'all' : String(settings.memberLimit)}
            >
              <Radio.Button value="all">全部</Radio.Button>
              <Radio.Button value="100">100</Radio.Button>
              <Radio.Button value="500">500</Radio.Button>
              <Radio.Button value="1000">1000</Radio.Button>
              <Radio.Button value="5000">5000</Radio.Button>
            </Radio.Group>
          </section>
          <section className="control-section compact">
            <label className="toggle-row">
              <div>
                <strong>获取详细资料</strong>
                <span>增加徽章、Nitro 时长、简介和连接账户；速度较慢且可能触发限流。</span>
              </div>
              <Switch checked={settings.fetchDetailedInfo} onChange={onDetailChange} />
            </label>
            {settings.fetchDetailedInfo && (
              <div className="select-row">
                <label>Nitro 等级筛选</label>
                <Select
                  style={{ width: '200px' }}
                  value={settings.tierFilter}
                  onChange={onTierChange}
                  options={TIER_OPTIONS}
                />
              </div>
            )}
          </section>
          <section className="control-section compact">
            <div className="select-row">
              <label>导出格式</label>
              <Select style={{width: '200px'}} value={settings.format} onChange={updateFormat} options={[
                {
                  value: 'xlsx',
                  label: 'Excel .xlsx',
                },
                {
                  value: 'xls',
                  label: 'Excel .xls',
                },
                {
                  value: 'csv',
                  label: 'CSV .csv',
                },
                {
                  value: 'json',
                  label: 'JSON .json',
                },
              ]}>

              </Select>
            </div>
            <label className="toggle-row slim">
              <div>
                <strong>头像另存为 ZIP</strong>
              </div>
              {/* <input type="checkbox" /> */}
              <Switch checked={settings.downloadAvatars} onChange={onAvaterChange} />
            </label>
          </section>
          <section className="advanced-section">
            <button className="advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)}>
              <SettingOutlined style={{ fontSize: 18 }} />
              <span>导出列与文件设置</span>
              {advancedOpen ? <DownOutlined style={{ fontSize: 16 }} /> : <RightOutlined style={{ fontSize: 16 }} />}
            </button>
            {advancedOpen && (
              <div className="advanced-body">
                <ColumnSelector
                  title="基础列"
                  columns={BASIC_COLUMNS}
                  enabled={settings.enabledBasicColumns}
                  onChange={(keys) => updateSettings('enabledBasicColumns', keys)}
                />
                {settings.fetchDetailedInfo && (
                  <ColumnSelector
                    title="详细资料列"
                    columns={DETAILED_COLUMNS}
                    enabled={settings.enabledDetailedColumns}
                    onChange={(keys) => updateSettings('enabledDetailedColumns', keys)}
                  />
                )}
                <label className="stack-field">
                  <span>文件名模板</span>
                  <textarea
                    rows={3}
                    value={settings.filenameTemplate}
                    onChange={(e) => updateSettings('filenameTemplate', e.target.value)}
                  />
                  <small>
                    预览: {renderFilename(settings.filenameTemplate, context, settings.memberLimit || 150)}.{settings.format}
                  </small>
                </label>
                <label className="stack-field">
                  <span>下载子目录</span>
                  <input
                    value={settings.downloadFolder}
                    onChange={(e) => updateSettings('downloadFolder', e.target.value)}
                  />
                  <small>保存在浏览器「下载」目录内，请填写相对路径，例如 Discord Exports/Hidden Members。</small>
                  <small className="path-preview">
                    Downloads/
                    {joinPath(
                      settings.downloadFolder,
                      `${renderFilename(settings.filenameTemplate, context, settings.memberLimit || 150)}.${settings.format}`,
                    )}
                  </small>
                </label>
              </div>
            )}
          </section>
          {/* <section className="control-section schedule-section">
            <div className="section-label">
              <span>02</span>
              <strong>
                <ClockCircleOutlined style={{ fontSize: 15 }} />
                定时导出
              </strong>
            </div>
            <p className="schedule-hint">按本地时间在后台执行。Chrome 需要保持运行，Discord 可以关闭。</p>
            <div className="schedule-row">
              <label>
                <span>每日时间</span>
                <input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} />
              </label>
              <button className="secondary schedule-save" disabled={!canExport || isRunning} onClick={saveSchedule}>
                保存每日导出
              </button>
            </div>
            <div className="schedule-actions">
              {matchingSchedule && (
                <button className="link-action" disabled={isRunning || !matchingSchedule.enabled} onClick={runScheduleNow}>
                  立即运行
                </button>
              )}
              <button
                className="link-action"
                onClick={() =>
                  void browser.tabs
                    .create({ url: browser.runtime.getURL('/options.html#schedules') })
                    .catch(() => void 0)
                }
              >
                管理定时任务
              </button>
              {matchingSchedule && (
                <span className={`schedule-badge ${matchingSchedule.enabled ? 'on' : ''}`}>
                  {matchingSchedule.enabled ? '已启用' : '已禁用'}
                </span>
              )}
            </div>
            {scheduleStatus && <small className="schedule-status">{scheduleStatus}</small>}
          </section> */}
          {task && task.phase !== 'idle' && <TaskCard task={task} />}
          {status && (
            <div className="error-banner">
              <span>{status}</span>
              <button onClick={() => setStatus('')}>×</button>
            </div>
          )}
        </section>
        {/* <footer className="app-footer">
          <div className="footer-main">
            <button className="primary export "  onClick={runExport}>
              <DownloadOutlined />
              导出成员
            </button>
          </div>
          <div className="footer-meta">
            <span>版本 1.0.0</span>
            <span>6 成功导出次数</span>
          </div>
        </footer> */}
        <footer className="app-footer">
          <div className="footer-main">
            {isRunning ? (
              <>
                <button className="secondary" onClick={pauseOrResumeExport}>
                  {isPaused ? <CaretRightOutlined /> : <PauseOutlined />}
                  {isPaused ? '继续' : '暂停'}
                </button>
                <button className="secondary danger" onClick={stopExport}>
                  <StopOutlined />
                  终止
                </button>
                <button
                  className="primary finish"
                  disabled={!task?.collected}
                  onClick={finishExport}
                >
                  <DownloadOutlined />
                  结束并导出 {task?.collected?.toLocaleString() || 0} 人
                </button>
              </>
            ) : isPartial ? (
              <>
                <button
                  className="primary finish"
                  disabled={starting}
                  onClick={continueExport}
                >
                  <ReloadOutlined />
                  {starting ? '正在续跑…' : '继续导出'}
                </button>
                <button
                  className="secondary"
                  disabled={starting}
                  onClick={finalizePartial}
                >
                  <DownloadOutlined />
                  结束并导出 {task?.collected?.toLocaleString() || 0} 人
                </button>
              </>
            ) : (
              <button
                className={`primary export ${starting ? 'loading' : ''}`}
                disabled={!canExport || starting}
                onClick={runExport}
              >
                {starting ? <span className="button-spinner" /> : <DownloadOutlined />}
                {starting ? '正在启动导出' : '导出成员'}
              </button>
            )}
          </div>
          <div className="footer-meta">
            <span>版本 1.0.0</span>
            <span>成功导出次数：{stats.successfulExports}</span>
          </div>
        </footer>
      </main>
    </div>
  );
}

/** 把 background 抛出的错误码翻译成可读文案 */
function translateError(error?: string): string {
  switch (error) {
    case 'TOKEN_MISSING':
      return '未获取到登录 token：请刷新 Discord 页面后重试';
    case 'DISCORD_CHANNEL_REQUIRED':
      return '请进入一个具体的服务器频道';
    case 'ANOTHER_TASK_RUNNING':
      return '已有导出任务在进行中';
    case 'NO_MEMBERS_FOUND':
      return '未找到成员';
    case 'NO_RESUMABLE_TASK':
      return '没有可继续的导出任务';
    case 'NO_CHECKPOINT':
      return '找不到上次的断点数据，请重新导出';
    default:
      return error ? `导出失败：${error}` : '导出失败';
  }
}

/** 安全转非负整数（progress 字段可能来自宽泛类型） */
function safeInt(n: unknown): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

interface Progress {
  visible: boolean;
  indeterminate: boolean;
  percent: number | null;
  current: number;
  total: number;
}

/** 计算进度：collecting/details/paused 阶段显示进度条 */
function computeProgress(task: Task | null): Progress {
  if (!task || !ACTIVE_PHASES.has(task.phase)) {
    return { visible: false, indeterminate: false, percent: null, current: 0, total: 0 };
  }
  const useDetails =
    task.phase === 'details' || (task.phase === 'paused' && safeInt(task.detailTotal) > 0);
  const current = safeInt(useDetails ? task.detailCurrent : task.collected);
  const total = safeInt(useDetails ? task.detailTotal : task.progressTarget);
  if (total) {
    return {
      visible: true,
      indeterminate: false,
      percent: Math.min(100, Math.round((current / total) * 100)),
      current,
      total,
    };
  }
  return { visible: true, indeterminate: true, percent: null, current, total: 0 };
}

/** 把 background 的 status 键映射成可读文案 */
function statusToText(status: string): string | null {
  switch (status) {
    case 'gateway_connecting':
      return '正在连接 Discord Gateway…';
    case 'gateway_requesting_members':
      return '正在请求成员列表…';
    case 'gateway_deep_search':
      return '正在深度搜索隐藏成员…';
    case 'fetching_profiles':
      return '正在获取详细资料…';
    case 'downloading':
      return '正在下载文件…';
    default:
      return null;
  }
}

/** 任务卡标题文案（按 phase 推导） */
function taskStatusText(task: Task): string {
  if (task.phase === 'details') {
    return task.detailTotal
      ? `正在获取详细资料 ${task.detailCurrent}/${task.detailTotal}`
      : '正在获取详细资料…';
  }
  if (task.phase === 'paused') {
    return `已暂停（已收集 ${task.collected} 人）`;
  }
  if (task.phase === 'error') {
    return '导出出错';
  }
  if (task.phase === 'complete') {
    const count = task.resultCount || task.collected;
    if (count === 0 && (task.options?.tierFilter ?? 0) > 0) {
      return '没有符合Nitro等级的成员，处理完成';
    }
    return '导出完成';
  }
  if (task.phase === 'stopped') {
    return `已停止，已导出 ${task.resultCount || task.collected} 人`;
  }
  if (task.phase === 'partial') {
    return `导出中断，已收集 ${(task.collected || 0).toLocaleString()} 人（可继续）`;
  }
  const fromStatus = statusToText(task.status);
  if (fromStatus) return fromStatus;
  if (task.totalMembers) {
    return `正在收集成员 ${task.collected}/${task.totalMembers}`;
  }
  return `正在收集成员（${task.collected} 人）`;
}

/** 把收集提前结束的原因映射成可读文案（正常完成/用户停止返回 null） */
function completeReasonText(reason?: string): string | null {
  switch (reason) {
    case 'overall_timeout':
      return '导出超时，仅导出了部分成员';
    case 'idle_timeout':
      return '长时间未收到新成员数据，已提前结束';
    case 'empty_chunks':
      return '连续多次返回空成员列表，已提前结束';
    case 'socket_closed':
      return '连接中断，仅导出了已收集的部分成员';
    case 'reconnect_exhausted':
      return '多次重连失败，仅导出了部分成员';
    case 'partial_error':
      return '导出过程中出错，仅导出了部分成员';
    default:
      return null; // max_reached（正常）/ stopped（用户停止）不提示
  }
}

/** 任务卡：进度条 + 阶段文案 + 完成/限流/错误提示 */
function TaskCard({ task }: { task: Task }) {
  const progress = computeProgress(task);
  const totalMembers = task.totalMembers || task.context?.memberCount || 0;
  const serverName = task.context?.serverName || '';
  const channelName = task.context?.channelName || '';

  return (
    <div className={`task-card ${task.phase}`}>
      <div className="task-title">
        <span>
          {task.phase === 'complete'
            ? <CheckCircleFilled />
            : task.phase === 'partial'
              ? <ClockCircleOutlined />
              : <LoadingOutlined spin />}
        </span>
        <div>
          <strong>{taskStatusText(task)}</strong>
          <small>
            {serverName}
            {serverName || channelName ? ` · #${channelName}` : ''}
            {totalMembers ? ` · 共 ${totalMembers.toLocaleString()} 人` : ''}
          </small>
        </div>
        {progress.visible && progress.percent !== null && <b>{progress.percent}%</b>}
      </div>
      {progress.visible && (
        <div className={`progress-track ${progress.indeterminate ? 'indeterminate' : ''}`}>
          <span style={progress.percent === null ? undefined : { width: `${progress.percent}%` }} />
        </div>
      )}
      {task.downloaded && <p className="limit-note success">已下载：{task.filename}</p>}
      {task.limitReached && <p className="limit-note">已达到免费版成员数量上限</p>}
      {(task.phase === 'complete' || task.phase === 'partial') && completeReasonText(task.completeReason) && (
        <p className="limit-note">{completeReasonText(task.completeReason)}</p>
      )}
      {task.error && <p className="limit-note error">{translateError(task.error)}</p>}
    </div>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDatetime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

/** 文件名模板 → 实际文件名（替换占位符） */
function renderFilename(template: string, context: ContextInfo | null, memberCount: number): string {
  return template
    .replace(/\{serverName\}/g, context?.serverName || 'Server')
    .replace(/\{channelName\}/g, context?.channelName || 'Channel')
    .replace(/\{datetime\}/g, formatDatetime(new Date()))
    .replace(/\{memberCount\}/g, String(memberCount));
}

/** 拼接下载相对路径（去首尾斜杠） */
function joinPath(folder: string, filename: string): string {
  const cleaned = folder.replace(/^\/+|\/+$/g, '');
  return cleaned ? `${cleaned}/${filename}` : filename;
}

/** 列选择器：全选 / 清空 + 芯片切换 */
function ColumnSelector({ title, columns, enabled, onChange }: {
  title: string;
  columns: ColumnDef[];
  enabled: string[];
  onChange: (keys: string[]) => void;
}) {
  return (
    <div className="column-group">
      <div className="column-head">
        <strong>{title}</strong>
        <div>
          <button onClick={() => onChange(columns.map((c) => c.key))}>全选</button>
          <button onClick={() => onChange([])}>清空</button>
        </div>
      </div>
      <div className="column-chips">
        {columns.map((col) => (
          <button
            key={col.key}
            className={enabled.includes(col.key) ? 'active' : ''}
            onClick={() =>
              onChange(
                enabled.includes(col.key)
                  ? enabled.filter((k) => k !== col.key)
                  : [...enabled, col.key],
              )
            }
          >
            {col.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default App;
