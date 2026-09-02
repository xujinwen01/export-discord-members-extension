import { useEffect, useState } from 'react';
import { Switch } from 'antd';
import {
  SettingOutlined,
  ClockCircleOutlined,
  CaretRightOutlined,
  DeleteOutlined,
  BulbOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  DisconnectOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import './App.css';
import icon48 from '@/assets/icon48.png';

const KEY_SETTINGS = 'dme:settings:v1';
const KEY_TARGET = 'dme:discord-target:v1';

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

const THEME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
];

const FORMAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'xlsx', label: 'XLSX' },
  { value: 'xls', label: 'XLS' },
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
];

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'fast', label: '快速' },
  { value: 'deep', label: '深度' },
];

interface Schedule {
  id: string;
  enabled: boolean;
  time: string;
  target: {
    guildId?: string;
    channelId?: string;
    serverName?: string;
    channelName?: string;
    avatar?: string;
    memberCount?: number;
  };
  lastExecuted?: string;
  lastResultCount?: number;
  lastError?: string;
  lastLimitReached?: boolean;
  [key: string]: unknown;
}

interface SavedTarget {
  guildId?: string;
  channelId?: string;
  serverName?: string;
  channelName?: string;
  avatar?: string;
  memberCount?: number;
  [key: string]: unknown;
}

function App() {
  // 通过 hash 深链到具体标签（如 options.html#schedules），与 sidepanel 的 tabs.create 对齐
  const [tab, setTab] = useState<'general' | 'schedules'>(
    window.location.hash === '#schedules' ? 'schedules' : 'general',
  );
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [target, setTarget] = useState<SavedTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState(false);

  const refresh = async () => {
    try {
      const resp = await browser.runtime.sendMessage({ type: 'DME_GET_SCHEDULES' });
      setSchedules(resp?.schedules || []);
    } catch (err) {
      console.error('[options] 拉取定时任务失败:', err);
    }
  };

  // 初始加载：设置 + 已保存的频道 + 定时任务
  useEffect(() => {
    (async () => {
      try {
        const stored = await browser.storage.local.get([KEY_SETTINGS, KEY_TARGET]);
        setSettings({ ...DEFAULT_SETTINGS, ...(stored[KEY_SETTINGS] || {}) });
        setTarget((stored[KEY_TARGET] as SavedTarget | undefined) || null);
        await refresh();
      } catch (err) {
        console.error('[options] 初始化失败:', err);
      } finally {
        setLoading(false);
      }
    })();

    const onMessage = (message: any) => {
      if (message?.type === 'DME_SCHEDULES_UPDATED') void refresh();
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  // 主题切换：把 settings.theme 应用到 <html data-theme>
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme || 'system';
  }, [settings.theme]);

  // 浏览器前进/后退或手动改 hash 时同步标签
  useEffect(() => {
    const onHashChange = () => {
      setTab(window.location.hash === '#schedules' ? 'schedules' : 'general');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (next: 'general' | 'schedules') => {
    setTab(next);
    if (window.location.hash !== `#${next}`) window.location.hash = next;
  };

  const flashSaved = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const updateSetting = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    try {
      await browser.storage.local.set({ [KEY_SETTINGS]: next });
      flashSaved();
    } catch (err) {
      console.error('[options] 保存设置失败:', err);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const resetSettings = async () => {
    setSettings(DEFAULT_SETTINGS);
    try {
      await browser.storage.local.set({ [KEY_SETTINGS]: DEFAULT_SETTINGS });
      flashSaved();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const clearAccess = async () => {
    setStatus('');
    try {
      const resp = await browser.runtime.sendMessage({ type: 'DME_CLEAR_DISCORD_ACCESS' });
      if (resp?.ok) {
        setTarget(null);
        flashSaved();
      } else {
        setStatus(translateError(resp?.error));
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  // ---- 定时任务相关 ----
  const toggleSchedule = async (id: string, enabled: boolean) => {
    try {
      const resp = await browser.runtime.sendMessage({ type: 'DME_TOGGLE_SCHEDULE', id, enabled });
      setStatus(resp?.ok ? (enabled ? '已启用' : '已停用') : translateError(resp?.error));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const runNow = async (id: string) => {
    setStatus('');
    try {
      const resp = await browser.runtime.sendMessage({ type: 'DME_RUN_SCHEDULE_NOW', id });
      setStatus(resp?.ok ? '已开始运行' : translateError(resp?.error));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('确定删除这条定时任务吗？')) return;
    try {
      const resp = await browser.runtime.sendMessage({ type: 'DME_DELETE_SCHEDULE', id });
      setStatus(resp?.ok ? '已删除' : translateError(resp?.error));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const serverLabel = (s: Schedule) => s.target.serverName || s.target.guildId || '未知服务器';
  const channelLabel = (s: Schedule) =>
    s.target.channelName ? `#${s.target.channelName}` : s.target.channelId ? `#${s.target.channelId}` : '';

  const targetLabel = target
    ? `${target.serverName || 'Discord Server'}${target.channelName ? ` · #${target.channelName}` : ''}`
    : '';

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <img alt="" src={icon48} />
          <div>
            <strong>Discord 成员导出</strong>
            <span>{tab === 'schedules' ? '定时任务' : '设置'}</span>
          </div>
        </div>
      </header>

      <nav className="options-tabs" aria-label="设置">
        <button className={tab === 'general' ? 'active' : ''} onClick={() => switchTab('general')}>
          <SettingOutlined /> <span>通用设置</span>
        </button>
        {/* <button className={tab === 'schedules' ? 'active' : ''} onClick={() => switchTab('schedules')}>
          <ClockCircleOutlined /> <span>定时任务</span>
          {schedules.length > 0 && <b>{schedules.length}</b>}
        </button> */}
      </nav>

      <section className="app-scroll">
        {loading ? (
          <div className="empty-state">
            <p>加载中…</p>
          </div>
        ) : tab === 'general' ? (
          <section className="settings-grid">
            {/* <div className="settings-card">
              <div className="card-title">
                <GlobalOutlined style={{ fontSize: 22 }} />
                <div>
                  <h2>语言</h2>
                  <p>{LANGUAGE_OPTIONS.find((o) => o.value === settings.language)?.label || settings.language}</p>
                </div>
              </div>
              <select
                value={settings.language}
                onChange={(e) => void updateSetting('language', e.target.value)}
              >
                {LANGUAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div> */}

            <div className="settings-card">
              <div className="card-title">
                <BulbOutlined style={{ fontSize: 22 }} />
                <div>
                  <h2>主题</h2>
                  <p>{THEME_OPTIONS.find((o) => o.value === settings.theme)?.label || settings.theme}</p>
                </div>
              </div>
              <select
                value={settings.theme}
                onChange={(e) => void updateSetting('theme', e.target.value)}
              >
                {THEME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="settings-card wide">
              <div className="card-title">
                <FolderOpenOutlined style={{ fontSize: 22 }} />
                <div>
                  <h2>下载子目录</h2>
                  <p>导出文件会保存在浏览器「下载」目录内的该相对路径下。</p>
                </div>
              </div>
              <input
                value={settings.downloadFolder}
                onChange={(e) => void updateSetting('downloadFolder', e.target.value)}
              />
              <code className="folder-preview">
                Downloads/{joinPath(settings.downloadFolder, `members.${settings.format}`)}
              </code>
            </div>

            <div className="settings-card wide">
              <div className="card-title">
                <FileTextOutlined style={{ fontSize: 22 }} />
                <div>
                  <h2>导出格式与模式</h2>
                  <p>{settings.format.toUpperCase()} · {MODE_OPTIONS.find((o) => o.value === settings.mode)?.label || settings.mode}</p>
                </div>
              </div>
              <div className="inline">
                <select
                  value={settings.mode}
                  onChange={(e) => void updateSetting('mode', e.target.value)}
                >
                  {MODE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <select
                  value={settings.format}
                  onChange={(e) => void updateSetting('format', e.target.value)}
                >
                  {FORMAT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button className="reset-button" onClick={() => void resetSettings()}>
                  <ReloadOutlined /> 重置
                </button>
              </div>
            </div>

            <div className="settings-card wide access-card">
              <div className="card-title">
                <DisconnectOutlined style={{ fontSize: 22 }} />
                <div>
                  <h2>已保存的频道访问</h2>
                  <p>{targetLabel || '尚未保存任何频道'}</p>
                </div>
              </div>
              <button className="danger-button" disabled={!target} onClick={() => void clearAccess()}>
                移除访问
              </button>
            </div>
          </section>
        ) : schedules.length === 0 ? (
          <div className="empty-state">
            <ClockCircleOutlined className="empty-icon" />
            <strong>暂无定时任务</strong>
            <p>在 Discord 成员导出的侧栏中，为某个频道保存「每日导出」后，会出现在这里。</p>
          </div>
        ) : (
          <div className="schedule-list">
            {schedules.map((s) => (
              <article key={s.id} className={`schedule-card ${s.enabled ? 'on' : ''}`}>
                <div className="schedule-main">
                  <div className="schedule-copy">
                    <div className="schedule-target">
                      <strong>{serverLabel(s)}</strong>
                      {channelLabel(s) && <span>{channelLabel(s)}</span>}
                    </div>
                    <div className="schedule-meta">
                      <span className="time-chip">
                        <ClockCircleOutlined /> {s.time}
                      </span>
                      <span className="state-badge">{s.enabled ? '已启用' : '已停用'}</span>
                    </div>
                  </div>
                  <div className="schedule-actions">
                    <Switch checked={s.enabled} onChange={(checked) => toggleSchedule(s.id, checked)} />
                    <button className="action run" disabled={!s.enabled} onClick={() => runNow(s.id)}>
                      <CaretRightOutlined /> 立即运行
                    </button>
                    <button className="action delete" onClick={() => remove(s.id)}>
                      <DeleteOutlined /> 删除
                    </button>
                  </div>
                </div>
                {(s.lastExecuted || s.lastError) && (
                  <div className="schedule-last">
                    {s.lastExecuted && (
                      <span>
                        上次执行 {formatDatetime(s.lastExecuted)}
                        {s.lastResultCount ? ` · 导出 ${s.lastResultCount} 人` : ''}
                        {s.lastLimitReached ? ' · 触及上限' : ''}
                      </span>
                    )}
                    {s.lastError && <span className="last-error">错误：{s.lastError}</span>}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        {(status || saved) && (
          <div className={`status-banner ${saved ? 'saved' : ''}`}>
            <span>{saved ? '已保存' : status}</span>
            <button onClick={() => { setStatus(''); setSaved(false); }}>×</button>
          </div>
        )}
      </section>

      <footer className="app-footer">
        {tab === 'schedules' ? 'Chrome 需保持运行，Discord 可以关闭。' : '设置会即时保存到浏览器本地。'}
      </footer>
    </main>
  );
}

/** 把 background 抛出的错误码翻译成可读文案 */
function translateError(error?: string): string {
  switch (error) {
    case 'TOKEN_MISSING':
      return '未获取到登录 token：请先在 Discord 中登录并打开频道';
    case 'DISCORD_CHANNEL_REQUIRED':
      return '该任务缺少目标频道信息';
    case 'ANOTHER_TASK_RUNNING':
      return '已有导出任务在进行中';
    case 'NO_MEMBERS_FOUND':
      return '未找到成员';
    case 'SCHEDULE_NOT_FOUND':
      return '定时任务不存在或已被删除';
    default:
      return error ? `操作失败：${error}` : '操作失败';
  }
}

/** 拼接下载相对路径（去首尾斜杠） */
function joinPath(folder: string, filename: string): string {
  const cleaned = folder.replace(/^\/+|\/+$/g, '');
  return cleaned ? `${cleaned}/${filename}` : filename;
}

/** 把 ISO 时间转成本地可读格式（YYYY-MM-DD HH:mm） */
function formatDatetime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default App;
