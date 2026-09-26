// 场次编排详情：建摊位 / 分批分场（谜目·难度·标签）/ 挂摊 / 跨场借用 / 场次内查重 / 均衡建议
import { useMemo, useState } from 'react';
import { useAppState } from '../ui/router';
import { CATEGORY_LABEL, FORMAT_LABEL, type Booth, type Riddle } from '../types';
import {
  sessionBooths, sessionRiddleIds, boothRiddleIds, isBorrowedIn, ownerSessionOf,
  unassignedPool, findSessionDupIssues, analyzeBalance, boothIdOf, scheduleListRows, SCHEDULE_HEADERS,
} from '../lib/schedule';
import { allTags } from '../lib/search';
import { downloadText, stars } from '../lib/format';
import { stringifyCSV, withBOM } from '../lib/csv';
import { exportFileName, store } from '../lib/store';

const PAGE_POOL = 50;

export function SessionPage({ id }: { id: string }) {
  const state = useAppState();
  const { schedule: s, riddles } = state;
  const session = s.sessions.find((x) => x.id === id);

  const [showBoothForm, setShowBoothForm] = useState(false);
  const [editBooth, setEditBooth] = useState<Booth | null>(null);
  const [cat, setCat] = useState<Riddle['category'] | ''>('');
  const [diff, setDiff] = useState<0 | 1 | 2 | 3>(0);
  const [tag, setTag] = useState('');
  const [poolPage, setPoolPage] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [borrowPick, setBorrowPick] = useState('');
  const [borrowBooth, setBorrowBooth] = useState('');
  const [borrowReason, setBorrowReason] = useState('');
  const [boothFilter, setBoothFilter] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'bad'; text: string } | null>(null);

  const tags = useMemo(() => allTags(riddles), [riddles]);
  const byId = useMemo(() => new Map(riddles.map((r) => [r.id, r])), [riddles]);

  const booths = useMemo(() => sessionBooths(s, id), [s, id]);
  const presentIds = useMemo(() => sessionRiddleIds(s, id), [s, id]);
  const presentRiddles = presentIds.map((x) => byId.get(x)!).filter(Boolean);

  const pool = useMemo(
    () => unassignedPool(s, riddles, { category: cat || undefined, difficulty: diff || undefined, tag: tag || undefined }),
    [s, riddles, cat, diff, tag],
  );
  const poolPageCount = Math.max(1, Math.ceil(pool.length / PAGE_POOL));
  const safePoolPage = Math.min(poolPage, poolPageCount - 1);
  const poolRows = pool.slice(safePoolPage * PAGE_POOL, safePoolPage * PAGE_POOL + PAGE_POOL);

  const dupIssues = useMemo(() => findSessionDupIssues(s, id, riddles), [s, id, riddles]);
  const balance = useMemo(() => analyzeBalance(s, id, riddles), [s, id, riddles]);

  // 已归属到其它场次、可借用的谜条
  const foreignOwned = useMemo(
    () => riddles.filter((r) => {
      const o = ownerSessionOf(s, r.id);
      return o && o !== id && !isBorrowedIn(s, r.id, id);
    }),
    [s, riddles, id],
  );

  if (!session) {
    return (
      <div className="panel empty">
        <p>找不到该场次（可能已被删除）。</p>
        <a className="btn" href="#/schedule">返回分场编排</a>
      </div>
    );
  }

  const flash = (kind: 'ok' | 'warn' | 'bad', text: string) => setNotice({ kind, text });

  const doAssign = async (ids: string[]) => {
    if (!ids.length) { flash('warn', '请先勾选要分入的谜条'); return; }
    const skipped = await store.assignRiddles(ids, id);
    setPicked(new Set());
    if (skipped.length) {
      const dup = skipped.filter((x) => x.reason === 'duplicate');
      flash(dup.length ? 'bad' : 'warn',
        dup.length
          ? `${ids.length - skipped.length} 条已分入；${dup.length} 条因同一场次出现重复谜面被拦截（谜号 ${dup.slice(0, 3).map((x) => x.conflictNo).join('、')}…）`
          : `${ids.length - skipped.length} 条已分入，${skipped.length} 条已在场内（跳过）`);
    } else {
      flash('ok', `已把 ${ids.length} 条分入「${session.name}」（只改本场，其它场次安排不受影响）`);
    }
  };

  const doBorrow = async () => {
    if (!borrowPick) { flash('warn', '请选择要借入的谜条'); return; }
    const res = await store.borrowRiddle(borrowPick, id, { boothId: borrowBooth || undefined, reason: borrowReason.trim() || undefined });
    if (!res.ok) {
      const map: Record<string, string> = {
        'no-owner': '该谜条还没有归属场次，请直接「分入」',
        'self': '这是本场自有谜条，无需借用',
        'already': '该谜条已借入本场',
        'duplicate': `场内已有相同谜面（谜号 ${res.conflictNo}），不能借入`,
      };
      flash('bad', map[res.error ?? ''] ?? '借用失败');
      return;
    }
    const r = byId.get(borrowPick);
    setBorrowPick(''); setBorrowBooth(''); setBorrowReason('');
    flash('ok', `已借入 #${r?.no}，借用记录已保留（其它场次安排不变）`);
  };

  const removeFromSession = async (riddleId: string) => {
    const borrowed = isBorrowedIn(s, riddleId, id);
    if (borrowed) {
      const b = s.borrows.find((x) => x.riddleId === riddleId && x.toSessionId === id && x.status === 'active');
      if (b) await store.returnBorrow(b.id);
      flash('ok', '已归还，借用记录保留');
    } else {
      if (!confirm('把这条谜条移出本场？（谜条仍在谜库里，可重新分到其它场次）')) return;
      await store.unassignRiddles([riddleId]);
      flash('ok', '已移出本场');
    }
  };

  const setBoothOf = async (riddleId: string, boothId: string) => {
    await store.setBooth(riddleId, id, boothId || undefined);
  };

  const doAutoBalance = async () => {
    const n = await store.autoBalance(id);
    flash(n ? 'ok' : 'ok', n ? `已按均衡方案调整 ${n} 条谜条的挂摊` : '当前已经很均衡，无需调整');
  };

  const applyOneMove = async (riddleId: string, toBoothId: string) => {
    await store.setBooth(riddleId, id, toBoothId);
  };

  const exportSession = () => {
    const rows = scheduleListRows(s, riddles).filter((row) => row[0] === session.name);
    const csv = stringifyCSV([SCHEDULE_HEADERS, ...rows]);
    downloadText(exportFileName(`场次清单-${session.name}`, 'csv'), withBOM(csv));
    flash('ok', `已导出「${session.name}」清单 ${rows.length} 条`);
  };

  const looseCount = useMemo(
    () => presentRiddles.filter((r) => !boothIdOf(s, r.id, id)).length,
    [presentRiddles, s, id],
  );

  const shownPresent = boothFilter
    ? presentRiddles.filter((r) => {
      const cur = boothIdOf(s, r.id, id);
      return boothFilter === '__loose' ? !cur : cur === boothFilter;
    })
    : presentRiddles;

  const dupSet = new Set<string>();
  dupIssues.forEach((d) => { dupSet.add(d.aId); dupSet.add(d.bId); });

  return (
    <div>
      <div className="page-head">
        <h1>
          <a className="back-link" href="#/schedule">分场编排</a> / {session.name}
          <small>{session.start || '--:--'}–{session.end || '--:--'} · {presentIds.length} 条在场</small>
        </h1>
        <div className="btn-row no-print">
          <button className="btn" onClick={exportSession}>⬇ 导出本场清单</button>
          <button className="btn btn-primary" onClick={() => navigatePrint(id)}>🖨 打印对照表</button>
        </div>
      </div>

      {notice && <div className={`msg msg-${notice.kind} no-print`}>{notice.text}<button className="notice-x" onClick={() => setNotice(null)} aria-label="关闭">×</button></div>}

      {/* 摊位 */}
      <div className="panel no-print">
        <div className="panel-head">
          <h3>摊位（{booths.length}）</h3>
          <button className="btn btn-sm" onClick={() => { setEditBooth(null); setShowBoothForm(true); }}>＋ 新建摊位</button>
        </div>
        {showBoothForm && (
          <BoothEditor
            sessionId={id}
            booth={editBooth}
            onClose={() => setShowBoothForm(false)}
            onSaved={() => { setShowBoothForm(false); }}
          />
        )}
        {booths.length === 0 ? (
          <p className="muted">还没有摊位。建好摊位后可把谜条挂到对应摊位，并指定负责人。</p>
        ) : (
          <div className="booth-chips">
            {booths.map((b) => {
              const n = boothRiddleIds(s, b.id).length;
              return (
                <span className="booth-chip" key={b.id}>
                  <b>{b.name}</b>
                  <span className="muted small">{b.owner || '未指定负责人'} · {n} 条</span>
                  <span className="booth-chip-ops">
                    <button className="btn btn-ghost btn-sm" onClick={() => { setEditBooth(b); setShowBoothForm(true); }}>改</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => {
                      if (confirm(`删除摊位「${b.name}」？上面的谜条变为未挂摊（归属不变）。`)) void store.deleteBooth(b.id);
                    }}>删</button>
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* 均衡 */}
      <div className="panel no-print">
        <h3>场地条数均衡</h3>
        <div className="balance-bars">
          {balance.booths.map((b) => (
            <div className="balance-row" key={b.boothId}>
              <span className="balance-name">{b.name}</span>
              <span className="balance-track">
                <span className="balance-fill" style={{ width: `${balance.max ? (b.count / balance.max) * 100 : 0}%` }} />
              </span>
              <span className="balance-num">{b.count}</span>
            </div>
          ))}
          <div className="balance-row">
            <span className="balance-name muted">未挂摊</span>
            <span className="balance-track"><span className="balance-fill fill-loose" style={{ width: `${balance.max ? (balance.unplaced / balance.max) * 100 : 0}%` }} /></span>
            <span className="balance-num">{balance.unplaced}</span>
          </div>
        </div>
        <ul className="dup-list small">
          {balance.suggestions.map((t, i) => (
            <li key={i} className={t.includes('均衡') && !t.includes('不均') && !t.includes('没') ? 'ok-text' : 'warn-text'}>{t}</li>
          ))}
        </ul>
        {balance.moves.length > 0 && (
          <details>
            <summary className="muted small">查看调整方案（{balance.moves.length} 步，只动挂摊不改归属）</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>谜号</th><th>从</th><th>到</th><th /></tr></thead>
                <tbody>
                  {balance.moves.slice(0, 30).map((m, i) => (
                    <tr key={i}>
                      <td className="no-cell">{m.riddleNo}</td>
                      <td>{booths.find((b) => b.id === m.fromBoothId)?.name ?? '未挂摊'}</td>
                      <td>{booths.find((b) => b.id === m.toBoothId)?.name}</td>
                      <td><button className="btn btn-sm" onClick={() => void applyOneMove(m.riddleId, m.toBoothId)}>应用</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => void doAutoBalance()}>一键应用全部调整</button>
          </details>
        )}
      </div>

      {/* 场次内查重 */}
      {dupIssues.length > 0 && (
        <div className="panel no-print">
          <h3 className="bad-text">场内谜面重复预警（{dupIssues.length} 组）</h3>
          <ul className="dup-list">
            {dupIssues.slice(0, 20).map((d, i) => {
              const a = byId.get(d.aId), b = byId.get(d.bId);
              return (
                <li key={i}>
                  <span className={`badge ${d.kind === 'exact' ? 'badge-warn' : ''}`}>{d.kind === 'exact' ? '完全相同' : `相似 ${Math.round(d.similarity * 100)}%`}</span>{' '}
                  #{a?.no} {a?.surface} ↔ #{b?.no} {b?.surface}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="session-grid">
        {/* 左：本场谜条清单 */}
        <div className="panel">
          <div className="panel-head">
            <h3>本场谜条（{presentIds.length}）</h3>
            <select className="input input-sm" value={boothFilter} onChange={(e) => setBoothFilter(e.target.value)}>
              <option value="">全部摊位</option>
              <option value="__loose">仅未挂摊</option>
              {booths.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {shownPresent.length === 0 ? (
            <p className="muted">本场还没有谜条。在右侧按谜目/难度/标签筛选，勾选后「分入本场」。</p>
          ) : (
            <div className="table-wrap session-list">
              <table>
                <thead><tr><th>谜号</th><th>谜面/谜底</th><th>谜目</th><th>挂摊</th><th>方式</th><th className="no-print" /></tr></thead>
                <tbody>
                  {shownPresent.map((r) => {
                    const borrowed = isBorrowedIn(s, r.id, id);
                    const curBooth = boothIdOf(s, r.id, id);
                    return (
                      <tr key={r.id} className={dupSet.has(r.id) ? 'row-dup' : ''}>
                        <td className="no-cell">{r.no}</td>
                        <td>
                          <a href={`#/riddle/${r.id}`}>{r.surface}</a>
                          <span className="muted small"> ／ {r.answer}</span>
                          <span className="tag" title="难度">{stars(r.difficulty)}</span>
                        </td>
                        <td className="small">{CATEGORY_LABEL[r.category]}{r.format !== 'none' ? `·${FORMAT_LABEL[r.format]}` : ''}</td>
                        <td>
                          <select
                            className="input input-sm"
                            value={curBooth ?? ''}
                            onChange={(e) => void setBoothOf(r.id, e.target.value)}
                          >
                            <option value="">未挂摊</option>
                            {booths.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        </td>
                        <td>
                          {borrowed
                            ? <span className="badge badge-borrow" title={`自有：${s.sessions.find((x) => x.id === ownerSessionOf(s, r.id))?.name}`}>借用</span>
                            : <span className="badge badge-solved">自有</span>}
                        </td>
                        <td className="no-print">
                          <button className="btn btn-ghost btn-sm" onClick={() => void removeFromSession(r.id)}>
                            {borrowed ? '归还' : '移出'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {looseCount > 0 && !boothFilter && (
            <p className="warn-text small">其中 {looseCount} 条尚未挂摊。</p>
          )}
        </div>

        {/* 右：分入 / 借入 */}
        <div>
          <div className="panel no-print">
            <h3>分批分入本场</h3>
            <p className="muted small">候选池为「还没分到任何场次」的谜条；分入即设为本场自有，每条谜条只属于一个场次。</p>
            <div className="toolbar">
              <select className="input input-sm" value={cat} onChange={(e) => { setCat(e.target.value as Riddle['category'] | ''); setPoolPage(0); }}>
                <option value="">全部谜目</option>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select className="input input-sm" value={diff} onChange={(e) => { setDiff(Number(e.target.value) as 0 | 1 | 2 | 3); setPoolPage(0); }}>
                <option value={0}>全部难度</option>
                <option value={1}>★</option><option value={2}>★★</option><option value={3}>★★★</option>
              </select>
              {tags.length > 0 && (
                <select className="input input-sm" value={tag} onChange={(e) => { setTag(e.target.value); setPoolPage(0); }}>
                  <option value="">全部标签</option>
                  {tags.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
            </div>
            <div className="btn-row wrap" style={{ marginBottom: 6 }}>
              <button className="btn btn-sm" onClick={() => setPicked(new Set(poolRows.map((r) => r.id)))}>全选本页</button>
              <button className="btn btn-sm" onClick={() => setPicked(new Set())}>清空勾选</button>
              <span className="muted small">候选 {pool.length} 条 · 已勾 {picked.size}</span>
            </div>
            {pool.length === 0 ? (
              <p className="muted small">没有符合条件的待分谜条（都已分入各场次；如确需，可在下方办理跨场借用）。</p>
            ) : (
              <div className="table-wrap assign-pool">
                <table>
                  <tbody>
                    {poolRows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <input type="checkbox" checked={picked.has(r.id)}
                            onChange={() => {
                              const n = new Set(picked);
                              if (n.has(r.id)) n.delete(r.id); else n.add(r.id);
                              setPicked(n);
                            }} />
                        </td>
                        <td className="no-cell">{r.no}</td>
                        <td className="small">{r.surface}<span className="muted"> ／{r.answer}</span></td>
                        <td className="muted small">{CATEGORY_LABEL[r.category]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {poolPageCount > 1 && (
              <div className="pager pager-sm">
                <button className="btn btn-sm" disabled={safePoolPage === 0} onClick={() => setPoolPage(safePoolPage - 1)}>上一页</button>
                <span className="small">{safePoolPage + 1}/{poolPageCount}</span>
                <button className="btn btn-sm" disabled={safePoolPage >= poolPageCount - 1} onClick={() => setPoolPage(safePoolPage + 1)}>下一页</button>
              </div>
            )}
            <button className="btn btn-primary" disabled={!picked.size} onClick={() => void doAssign([...picked])}>
              分入本场（{picked.size}）
            </button>
          </div>

          <div className="panel no-print">
            <h3>跨场借用（留记录）</h3>
            <p className="muted small">谜条归属不变，仅借到本场使用；同一场次出现重复谜面会被拦截。</p>
            <select className="input" value={borrowPick} onChange={(e) => setBorrowPick(e.target.value)}>
              <option value="">选择其它场次的谜条…</option>
              {foreignOwned.map((r) => {
                const owner = s.sessions.find((x) => x.id === ownerSessionOf(s, r.id));
                return <option key={r.id} value={r.id}>#{r.no} {r.surface.slice(0, 18)}（{owner?.name}）</option>;
              })}
            </select>
            <div className="field-row" style={{ marginTop: 8 }}>
              <label className="field"><span>挂到摊位</span>
                <select className="input" value={borrowBooth} onChange={(e) => setBorrowBooth(e.target.value)}>
                  <option value="">未挂摊</option>
                  {booths.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label className="field flex2"><span>借用事由</span>
                <input className="input" value={borrowReason} onChange={(e) => setBorrowReason(e.target.value)} placeholder="例：本场字谜不够" />
              </label>
            </div>
            <button className="btn btn-primary" onClick={() => void doBorrow()}>借入并留记录</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function navigatePrint(sessionId: string) {
  location.hash = `#/print-schedule${sessionId ? `?s=${encodeURIComponent(sessionId)}` : ''}`;
}

function BoothEditor({ sessionId, booth, onClose, onSaved }: { sessionId: string; booth: Booth | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(booth?.name ?? '');
  const [owner, setOwner] = useState(booth?.owner ?? '');
  const [note, setNote] = useState(booth?.note ?? '');
  const save = async () => {
    if (!name.trim()) { alert('请填写摊位名称'); return; }
    await store.saveBooth({ id: booth?.id, sessionId, name, owner, note });
    onSaved();
  };
  return (
    <div className="booth-editor">
      <div className="field-row">
        <label className="field"><span>摊位名称</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：A 区·字谜摊" autoFocus />
        </label>
        <label className="field"><span>负责人</span>
          <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="谁管这个摊" />
        </label>
        <label className="field flex2"><span>备注</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="btn-row">
        <button className="btn btn-primary btn-sm" onClick={() => void save()}>保存摊位</button>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
