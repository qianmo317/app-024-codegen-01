// 分场编排总览：场次 / 摊位 / 跨场均衡 / 借用记录 / 清单导出与打印
import { useMemo, useState } from 'react';
import { useAppState, navigate } from '../ui/router';
import { overview } from '../lib/schedule';
import { stringifyCSV, withBOM } from '../lib/csv';
import { scheduleListRows, borrowRows, SCHEDULE_HEADERS, BORROW_HEADERS } from '../lib/schedule';
import { downloadText, formatDateTime } from '../lib/format';
import { exportFileName, store } from '../lib/store';
import type { Session } from '../types';

export function SchedulePage() {
  const state = useAppState();
  const { schedule: s, riddles } = state;
  const [editing, setEditing] = useState<Session | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');

  const ov = useMemo(() => overview(s, riddles), [s, riddles]);
  const byId = useMemo(() => new Map(riddles.map((r) => [r.id, r])), [riddles]);

  const exportList = () => {
    if (!s.sessions.length) { setNotice('还没有场次，先建一个场次'); return; }
    const csv = stringifyCSV([SCHEDULE_HEADERS, ...scheduleListRows(s, riddles)]);
    downloadText(exportFileName('分场清单', 'csv'), withBOM(csv));
    setNotice('清单已导出（每个场次、每个摊位一行，含借用标记）');
  };

  const exportBorrows = () => {
    if (!s.borrows.length) { setNotice('还没有借用记录'); return; }
    const csv = stringifyCSV([BORROW_HEADERS, ...borrowRows(s, riddles)]);
    downloadText(exportFileName('跨场借用记录', 'csv'), withBOM(csv));
  };

  const delSession = async (id: string, name: string) => {
    if (!confirm(`删除场次「${name}」？其摊位与自有谜条归属会一并清除（谜条本身保留在谜库），相关借用记录标记归还。`)) return;
    await store.deleteSession(id);
    setNotice(`已删除场次「${name}」`);
  };

  const doClear = async () => {
    if (!confirm('清空整个分场编排（场次、摊位、归属与借用记录）？谜条本身不受影响。')) return;
    await store.clearSchedule();
    setNotice('分场编排已清空');
  };

  const activeBorrows = s.borrows.filter((b) => b.status === 'active');

  return (
    <div>
      <div className="page-head">
        <h1>分场编排 <small>{s.sessions.length} 场 · 已分 {ov.totalAssigned}/{riddles.length} 条</small></h1>
        <div className="btn-row">
          <button className="btn btn-primary" onClick={() => { setCreating(true); setEditing({ id: '', name: '', start: '', end: '' }); }}>＋ 新建场次</button>
        </div>
      </div>

      {notice && <div className="notice">{notice}<button className="notice-x" onClick={() => setNotice('')} aria-label="关闭">×</button></div>}

      {ov.suggestions.length > 0 && (
        <div className="panel panel-tips">
          <h3>均衡检查与调整建议</h3>
          <ul className="dup-list">
            {ov.suggestions.map((t, i) => <li key={i} className={t.includes('均衡') ? 'ok-text' : 'warn-text'}>{t}</li>)}
          </ul>
        </div>
      )}

      <div className="btn-row wrap no-print" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => navigate('#/print-schedule')} disabled={!s.sessions.length}>🖨 打印对照表</button>
        <button className="btn" onClick={exportList} disabled={!s.sessions.length}>⬇ 导出清单 CSV（一个文件带去现场）</button>
        <button className="btn" onClick={exportBorrows} disabled={!s.borrows.length}>⬇ 导出借用记录</button>
        <button className="btn btn-danger btn-sm" onClick={() => void doClear()} disabled={!s.sessions.length}>清空编排</button>
      </div>

      {creating && editing && (
        <SessionEditor
          session={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); setNotice('场次已保存'); }}
        />
      )}

      {s.sessions.length === 0 ? (
        <div className="panel empty">
          <p>还没有场次。先建立时段（如「下午场 14:00–16:00」），再进入场次把谜条按谜目/难度/标签分批分进去。</p>
          <p><button className="btn btn-primary" onClick={() => { setCreating(true); setEditing({ id: '', name: '', start: '14:00', end: '16:00' }); }}>＋ 新建第一个场次</button></p>
        </div>
      ) : (
        <div className="sess-grid">
          {ov.stats.map(({ session, total, owned, borrowedIn, lentOut, unplaced }) => {
            const boothCount = s.booths.filter((b) => b.sessionId === session.id).length;
            return (
              <div className="panel sess-card" key={session.id}>
                <div className="sess-card-head">
                  <h3>{session.name}</h3>
                  <div className="btn-row">
                    <button className="btn btn-sm" onClick={() => { setEditing(session); setCreating(false); }}>编辑</button>
                    <button className="btn btn-sm btn-danger" onClick={() => void delSession(session.id, session.name)}>删除</button>
                  </div>
                </div>
                <p className="muted">{session.start || '--:--'} – {session.end || '--:--'}{session.note ? ` · ${session.note}` : ''}</p>
                <div className="sess-statline">
                  <span className="badge badge-big">{total} 条在场</span>
                  <span className="badge">{boothCount} 个摊位</span>
                  {borrowedIn > 0 && <span className="badge badge-borrow">借入 {borrowedIn}</span>}
                  {lentOut > 0 && <span className="badge badge-lend">借出 {lentOut}</span>}
                  {unplaced > 0 && <span className="badge badge-warn">未挂摊 {unplaced}</span>}
                </div>
                <p className="muted small">自有 {owned} 条{borrowedIn ? ` · 借入 ${borrowedIn} 条` : ''}</p>
                <a className="btn btn-primary" href={`#/session/${session.id}`}>进入编排 →</a>
              </div>
            );
          })}
        </div>
      )}

      {activeBorrows.length > 0 && (
        <div className="panel">
          <h3>跨场借用（{activeBorrows.length} 条借用中）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>谜号</th><th>谜面</th><th>出借场次</th><th>借用场次</th><th>挂摊</th><th>借出时间</th><th>操作</th></tr></thead>
              <tbody>
                {activeBorrows.map((b) => {
                  const r = byId.get(b.riddleId);
                  return (
                    <tr key={b.id}>
                      <td className="no-cell">{r?.no ?? '?'}</td>
                      <td>{r?.surface ?? '(谜条已删除)'}</td>
                      <td>{s.sessions.find((x) => x.id === b.fromSessionId)?.name ?? '—'}</td>
                      <td>{s.sessions.find((x) => x.id === b.toSessionId)?.name ?? '—'}</td>
                      <td>{s.booths.find((x) => x.id === b.boothId)?.name ?? '未挂摊'}</td>
                      <td className="muted">{formatDateTime(b.at)}</td>
                      <td><button className="btn btn-sm" onClick={() => void store.returnBorrow(b.id)}>归还</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {s.borrows.some((b) => b.status === 'returned') && (
        <details className="panel no-print">
          <summary className="muted">已归还记录（{s.borrows.filter((b) => b.status === 'returned').length}）</summary>
          <ul className="dup-list small">
            {s.borrows.filter((b) => b.status === 'returned').slice(0, 30).map((b) => {
              const r = byId.get(b.riddleId);
              return (
                <li key={b.id}>
                  #{r?.no ?? '?'} {r?.surface ?? ''}：
                  {s.sessions.find((x) => x.id === b.fromSessionId)?.name ?? '—'} → {s.sessions.find((x) => x.id === b.toSessionId)?.name ?? '—'}
                  {b.returnedAt ? ` · ${formatDateTime(b.returnedAt)} 归还` : ''}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

function SessionEditor({ session, onClose, onSaved }: { session: Session; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(session.name);
  const [start, setStart] = useState(session.start);
  const [end, setEnd] = useState(session.end);
  const [note, setNote] = useState(session.note ?? '');

  const save = async () => {
    if (!name.trim()) { alert('请填写场次名称'); return; }
    if (start && end && start >= end) { alert('结束时间应晚于开始时间'); return; }
    await store.saveSession({ id: session.id || undefined, name, start, end, note });
    onSaved();
  };

  return (
    <div className="panel panel-edit no-print">
      <h3>{session.id ? '编辑场次' : '新建场次'}</h3>
      <div className="field-row">
        <label className="field"><span>场次名称</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：下午场" autoFocus />
        </label>
        <label className="field field-time"><span>开始</span>
          <input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field field-time"><span>结束</span>
          <input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label className="field"><span>备注</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="可留空" />
      </label>
      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => void save()}>保存</button>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
