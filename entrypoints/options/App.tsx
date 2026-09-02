import { useEffect, useState } from 'react';
import { Switch } from 'antd';
import {
  ClockCircleOutlined,
  CaretRightOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import './App.css';
import icon48 from '@/assets/icon48.png';

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

function App() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  const refresh = async () => {
    try {
      const resp = await browser.runtime.sendMessage({ type: 'DME_GET_SCHEDULES' });
      setSchedules(resp?.schedules || []);
    } catch (err) {
      console.error('[options] 拉取定时任务失败:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const onMessage = (message: any) => {
      if (message?.type === 'DME_SCHEDULES_UPDATED') void refresh();
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

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

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <img alt="" src={icon48} />
          <div>
            <strong>定时任务管理</strong>
            <span>管理每日自动导出计划</span>
          </div>
        </div>
      </header>

      <section className="app-scroll">
        {loading ? (
          <div className="empty-state">
            <p>加载中…</p>
          </div>
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
        {status && (
          <div className="status-banner">
            <span>{status}</span>
            <button onClick={() => setStatus('')}>×</button>
          </div>
        )}
      </section>

      <footer className="app-footer">Chrome 需保持运行，Discord 可以关闭。</footer>
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

/** 把 ISO 时间转成本地可读格式（YYYY-MM-DD HH:mm） */
function formatDatetime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default App;
