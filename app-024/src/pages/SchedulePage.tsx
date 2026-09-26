// 分场编排：建时段/摊位 → 按谜目/难度/标签分批 → 场次摊位清单/查重/均衡建议 → 借用台账 → 导出/打印
import { useMemo, useState } from 'react';
import { useAppState } from '../ui/router';
import { CATEGORY_LABEL, type Booth, type Riddle, type RiddleCategory, type Session } from '../types';
import { store } from '../lib/store';
import { downloadText, formatDateTime } from '../lib/format';
import { withBOM } from '../lib/csv';
import { exportFileName } from '../lib/store';
import { Stars } from '../ui/bits';
import {
  analyzeBalance, borrowLedgerToCSV, buildScheduleView, clashWith, findClashes,
  planBatch, scheduleToCSV, sessionList,
  type BatchCriteria, type BatchPlanItem,
} from '../lib/schedule';

type Tab = 'setup' | 'arrange' | 'lists' | 'borrows';

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function SchedulePage() {
  const state = useAppState();
  const [tab, setTab] = useState<Tab>('setup');
  const { riddles, sessions, booths, assignments, borrows } = state;

  const view = useMemo(
    () => buildScheduleView(riddles, sessions, booths, assignments, borrows),
    [riddles, sessions, booths, assignments, borrows],
  );
  const clashes = useMemo(
    () => findClashes(riddles, sessions, booths, assignments, borrows),
    [riddles, sessions, booths, assignments, borrows],
  );
  const balance = useMemo(() => analyzeBalance(view), [view]);

  const exportCSV = () => {
    const csv = scheduleToCSV(state.settings.event.title, riddles, sessions, booths, assignments, borrows);
    downloadText(exportFileName('分场编排清单', 'csv'), withBOM(csv));
  };
  const exportBorrows = () => {
    const csv = borrowLedgerToCSV(sessions, booths, borrows, riddles);
    downloadText(exportFileName('借用台账', 'csv'), withBOM(csv));
  };

  return (
    <div>
      <div className="page-head no-print">
        <h1>
          分场编排
          <small>
            {sessions.length} 个时段 · {booths.length} 个摊位 · 已编排 {riddles.length - view.unassigned.length}/{riddles.length} 条
            {clashes.length > 0 && <b className="bad-text"> · {clashes.length} 组同场重复谜面</b>}
          </small>
        </h1>
        <div className="btn-row">
          <button className="btn" onClick={exportCSV} disabled={!sessions.length}>⬇ 导出清单（一个 CSV）</button>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!sessions.length}>🖨 打印对照表</button>
        </div>
      </div>

      <div className="tabs no-print">
        {([
          ['setup', `① 时段与摊位`],
          ['arrange', '② 分批编排'],
          ['lists', `③ 场次清单${clashes.length ? `（${clashes.length} 处撞面）` : ''}`],
          ['borrows', `④ 借用记录${view.activeBorrows.length ? `（${view.activeBorrows.length} 未还）` : ''}`],
        ] as [Tab, string][]).map(([k, label]) => (
          <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'setup' && <SetupTab sessions={sessions} booths={booths} view={view} goArrange={() => setTab('arrange')} />}
      {tab === 'arrange' && <ArrangeTab />}
      {tab === 'lists' && <ListsTab clashes={clashes} balance={balance} view={view} />}
      {tab === 'borrows' && <BorrowsTab onExport={exportBorrows} />}

      <SchedulePrint view={view} balance={balance} />
    </div>
  );
}

/* ---------------- ① 时段与摊位 ---------------- */

function SetupTab({ sessions, booths, view, goArrange }: {
  sessions: Session[]; booths: Booth[];
  view: ReturnType<typeof buildScheduleView>; goArrange: () => void;
}) {
  const countOfSession = (id: string) => view.bySession.find((s) => s.session.id === id)?.total ?? 0;
  return (
    <div className="setup-grid no-print">
      <div className="panel">
        <h3>时段（场次）</h3>
        <SessionForm />
        <table className="schedule-table">
          <thead><tr><th>顺序</th><th>场次</th><th>时段</th><th>已挂条数</th><th>操作</th></tr></thead>
          <tbody>
            {sessions.map((s, i) => (
              <SessionRow key={s.id} session={s} index={i + 1} count={countOfSession(s.id)} />
            ))}
            {!sessions.length && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center' }}>还没有时段，先添加一场（如午场 13:00–15:00）</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>摊位（全场固定点位，跨时段复用）</h3>
        <BoothForm />
        <table className="schedule-table">
          <thead><tr><th>摊位</th><th>负责人</th><th>位置</th><th>操作</th></tr></thead>
          <tbody>
            {booths.map((b) => <BoothRow key={b.id} booth={b} />)}
            {!booths.length && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center' }}>还没有摊位，先添加一个并填写负责人</td></tr>}
          </tbody>
        </table>
      </div>
      {sessions.length > 0 && (
        <div className="panel" style={{ gridColumn: '1 / -1' }}>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={goArrange}>下一步：把谜条分批分到场次 →</button>
            <span className="muted small">摊位与时段都可以随时回来增删；删除摊位不会删谜条，只把相关谜条变为「未指定摊位」。</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionForm() {
  const [draft, setDraft] = useState({ name: '', start: '', end: '', note: '' });
  const save = async () => {
    if (!draft.name.trim() || !draft.start) return;
    await store.saveSession({ id: uid('s'), ...draft });
    setDraft({ name: '', start: '', end: '', note: '' });
  };
  return (
    <div className="inline-form">
      <input className="input" placeholder="场次名（如午场）" value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      <input className="input" type="time" value={draft.start} title="开始时间"
        onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
      <span className="muted">—</span>
      <input className="input" type="time" value={draft.end} title="结束时间"
        onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
      <button className="btn btn-primary" onClick={save} disabled={!draft.name.trim() || !draft.start}>＋ 添加时段</button>
    </div>
  );
}

function SessionRow({ session, index, count }: { session: Session; index: number; count: number }) {
  const state = useAppState();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session);

  const del = async () => {
    const r = await store.removeSession(session.id);
    if (!r.ok) {
      if (confirm(`「${session.name}」还有 ${r.count} 条谜条归属或借入。强制删除将把这些谜条变为未编排，确定？`)) {
        await store.removeSession(session.id, true);
      }
    }
  };
  const move = async (delta: number) => {
    const list = state.sessions;
    const i = list.findIndex((s) => s.id === session.id);
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    const a = list[i], b = list[j];
    await store.saveSession({ ...a, order: b.order });
    await store.saveSession({ ...b, order: a.order });
  };

  if (!editing) {
    return (
      <tr>
        <td className="muted">{index}<span className="order-btns">
          <button className="btn btn-ghost btn-sm" onClick={() => move(-1)}>↑</button>
          <button className="btn btn-ghost btn-sm" onClick={() => move(1)}>↓</button>
        </span></td>
        <td><b>{session.name}</b>{session.note ? <div className="muted small">{session.note}</div> : null}</td>
        <td>{session.start}{session.end ? `–${session.end}` : ''}</td>
        <td><span className="badge">{count} 条</span></td>
        <td className="btn-row">
          <button className="btn btn-sm" onClick={() => { setDraft(session); setEditing(true); }}>编辑</button>
          <button className="btn btn-sm btn-danger" onClick={del}>删除</button>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td className="muted">{index}</td>
      <td colSpan={2}>
        <div className="inline-form">
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="input" type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
          <input className="input" type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
        </div>
      </td>
      <td colSpan={2}>
        <div className="btn-row">
          <button className="btn btn-sm btn-primary" onClick={async () => { await store.saveSession(draft); setEditing(false); }}>保存</button>
          <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>取消</button>
        </div>
      </td>
    </tr>
  );
}

function BoothForm() {
  const [draft, setDraft] = useState({ name: '', owner: '', location: '', note: '' });
  const save = async () => {
    if (!draft.name.trim()) return;
    await store.saveBooth({ id: uid('b'), ...draft });
    setDraft({ name: '', owner: '', location: '', note: '' });
  };
  return (
    <div className="inline-form booth-form">
      <input className="input" placeholder="摊位名（如 A 区字谜摊）" value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      <input className="input" placeholder="负责人" value={draft.owner}
        onChange={(e) => setDraft({ ...draft, owner: e.target.value })} />
      <input className="input" placeholder="位置（可选）" value={draft.location}
        onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
      <button className="btn btn-primary" onClick={save} disabled={!draft.name.trim()}>＋ 添加摊位</button>
    </div>
  );
}

function BoothRow({ booth }: { booth: Booth }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(booth);
  const del = () => {
    if (confirm(`删除摊位「${booth.name}」？该摊位上的谜条会变为「未指定摊位」，不会被删除。`)) void store.removeBooth(booth.id);
  };
  if (!editing) {
    return (
      <tr>
        <td><b>{booth.name}</b>{booth.note ? <div className="muted small">{booth.note}</div> : null}</td>
        <td>{booth.owner || <span className="muted">未指定</span>}</td>
        <td className="muted">{booth.location || '—'}</td>
        <td className="btn-row">
          <button className="btn btn-sm" onClick={() => { setDraft(booth); setEditing(true); }}>编辑</button>
          <button className="btn btn-sm btn-danger" onClick={del}>删除</button>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={3}>
        <div className="inline-form booth-form">
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="input" value={draft.owner} placeholder="负责人" onChange={(e) => setDraft({ ...draft, owner: e.target.value })} />
          <input className="input" value={draft.location ?? ''} placeholder="位置" onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
        </div>
      </td>
      <td>
        <button className="btn btn-sm btn-primary" onClick={async () => { await store.saveBooth(draft); setEditing(false); }}>保存</button>{' '}
        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>取消</button>
      </td>
    </tr>
  );
}

/* ---------------- ② 分批编排 ---------------- */

function ArrangeTab() {
  const state = useAppState();
  const { riddles, sessions, booths, assignments, borrows } = state;
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<RiddleCategory | ''>('');
  const [difficulty, setDifficulty] = useState<0 | 1 | 2 | 3>(0);
  const [tag, setTag] = useState('');
  const [onlyUnassigned, setOnlyUnassigned] = useState(true);
  const [targetSession, setTargetSession] = useState('');
  const [targetBooth, setTargetBooth] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');

  const allTagList = useMemo(() => {
    const set = new Set<string>();
    for (const r of riddles) for (const t of r.tags) set.add(t);
    return [...set].sort();
  }, [riddles]);

  const pool = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return riddles.filter((r) => {
      if (onlyUnassigned && assignments.some((a) => a.riddleId === r.id)) return false;
      if (category && r.category !== category) return false;
      if (difficulty && r.difficulty !== difficulty) return false;
      if (tag && !r.tags.includes(tag)) return false;
      if (kw && !`${r.no}${r.surface}${r.answer}${r.tags.join()}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [riddles, assignments, q, category, difficulty, tag, onlyUnassigned]);

  if (!sessions.length) {
    return <div className="panel empty no-print">请先在「① 时段与摊位」中创建至少一个时段。</div>;
  }
  const sessionId = targetSession || sessions[0].id;

  const toggle = (id: string) => {
    const s = new Set(checked);
    if (s.has(id)) s.delete(id); else s.add(id);
    setChecked(s);
  };
  const visibleIds = pool.slice(0, 100).map((r) => r.id);

  const doAssign = async (ids: string[]) => {
    const skipNos = new Set<number>();
    let n = 0;
    for (const id of ids) {
      const r = riddles.find((x) => x.id === id)!;
      const dups = clashWith(r, sessionId, riddles, sessions, booths, assignments, borrows);
      if (dups.length) { skipNos.add(r.no); continue; }
      n++;
    }
    const okIds = ids.filter((id) => !skipNos.has(riddles.find((r) => r.id === id)!.no));
    await store.assignMany(okIds.map((riddleId) => ({ riddleId, sessionId, boothId: targetBooth })));
    setChecked(new Set());
    setNotice(skipNos.size
      ? `已分配 ${n} 条到「${sessions.find((s) => s.id === sessionId)?.name}」；${skipNos.size} 条因同场重复谜面跳过（谜号 ${[...skipNos].slice(0, 8).join('、')}${skipNos.size > 8 ? '…' : ''}），可改选其它场次或在清单中强制处理`
      : `已分配 ${n} 条到「${sessions.find((s) => s.id === sessionId)?.name}」`);
  };

  const assignOne = async (r: Riddle, sid: string) => {
    if (!sid) return;
    const dups = clashWith(r, sid, riddles, sessions, booths, assignments, borrows);
    if (dups.length && !confirm(`「${sessions.find((s) => s.id === sid)?.name}」已有相同谜面（谜号 ${[...new Set(dups.map((d) => d.no))].join('、')}）。\n规则要求同一时段不出现重复谜面，仍要分配吗？`)) return;
    await store.assignRiddle(r.id, sid, targetBooth);
  };

  return (
    <div className="no-print">
      {notice && <div className="notice">{notice}<button className="notice-x" onClick={() => setNotice('')} aria-label="关闭">×</button></div>}

      <div className="panel">
        <h3>按条件筛谜条，再分批到场次</h3>
        <div className="toolbar">
          <input className="input search" placeholder="搜索谜号 / 谜面 / 谜底 / 标签…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as RiddleCategory | '')}>
            <option value="">全部谜目</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="input" value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value) as 0 | 1 | 2 | 3)}>
            <option value={0}>全部难度</option>
            <option value={1}>★</option><option value={2}>★★</option><option value={3}>★★★</option>
          </select>
          {allTagList.length > 0 && (
            <select className="input" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">全部标签</option>
              {allTagList.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <label className="check-inline"><input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} /> 只看未编排</label>
        </div>
        <div className="btn-row wrap batch-bar">
          <span>批量分配到</span>
          <select className="input" value={sessionId} onChange={(e) => setTargetSession(e.target.value)}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.start}）</option>)}
          </select>
          <select className="input" value={targetBooth} onChange={(e) => setTargetBooth(e.target.value)}>
            <option value="">未指定摊位</option>
            {booths.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="btn btn-primary" disabled={!checked.size} onClick={() => doAssign([...checked])}>
            分配选中（{checked.size}）
          </button>
          <button className="btn" disabled={!pool.length} onClick={() => doAssign(pool.map((r) => r.id))}>
            全部分配当前筛选（{pool.length}）
          </button>
          <span className="muted small">每条谜条只属于一个场次；再分配即移动，其它场次安排不受影响。</span>
        </div>
      </div>

      <AutoBatch onApplied={(n) => setNotice(`自动分批完成：${n} 条已按均衡方案落位`)} />

      <div className="table-wrap">
        <table className="riddle-table">
          <thead>
            <tr>
              <th><input type="checkbox" aria-label="全选当前显示"
                checked={visibleIds.length > 0 && visibleIds.every((id) => checked.has(id))}
                onChange={(e) => {
                  const s = new Set(checked);
                  for (const id of visibleIds) e.target.checked ? s.add(id) : s.delete(id);
                  setChecked(s);
                }} /></th>
              <th>谜号</th><th>谜面</th><th>谜目</th><th>难度</th><th>当前归属</th><th>单独分配到</th>
            </tr>
          </thead>
          <tbody>
            {pool.slice(0, 100).map((r) => {
              const a = assignments.find((x) => x.riddleId === r.id);
              const aSession = a && sessions.find((s) => s.id === a.sessionId);
              return (
                <tr key={r.id}>
                  <td><input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td className="no-cell">{r.no}</td>
                  <td>{r.surface}{r.tags[0] ? <span className="tag">{r.tags[0]}</span> : null}</td>
                  <td>{CATEGORY_LABEL[r.category]}</td>
                  <td><Stars n={r.difficulty} /></td>
                  <td>{aSession ? <span className="badge badge-solved">{aSession.name}</span> : <span className="muted">未编排</span>}</td>
                  <td>
                    <select className="input input-sm" value="" onChange={(e) => assignOne(r, e.target.value)}>
                      <option value="">移动到…</option>
                      {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
            {!pool.length && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>没有符合条件的谜条{onlyUnassigned ? '（可能已全部分配，可取消「只看未编排」）' : ''}</td></tr>}
          </tbody>
        </table>
        {pool.length > 100 && <p className="muted small" style={{ padding: '6px 10px' }}>符合条件 {pool.length} 条，仅显示前 100 条；可直接用「全部分配当前筛选」处理全部。</p>}
      </div>
    </div>
  );
}

function AutoBatch({ onApplied }: { onApplied: (n: number) => void }) {
  const state = useAppState();
  const { riddles, sessions, booths, assignments, borrows } = state;
  const [open, setOpen] = useState(false);
  const [criteria, setCriteria] = useState<BatchCriteria>({
    categories: [], difficulties: [], tags: [], onlyUnassigned: true, perSessionLimit: 0,
  });
  const [plan, setPlan] = useState<BatchPlanItem[] | null>(null);

  const allTags = useMemo(() => [...new Set(riddles.flatMap((r) => r.tags))].sort(), [riddles]);

  const toggleArr = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const generate = () => {
    setPlan(planBatch(riddles, sessions, booths, assignments, borrows, criteria));
  };
  const apply = async () => {
    if (!plan) return;
    const ok = plan.filter((p) => p.sessionId && !p.clashRiddles.length);
    await store.assignMany(ok.map((p) => ({ riddleId: p.riddle.id, sessionId: p.sessionId, boothId: '' })));
    onApplied(ok.length);
    setPlan(null); setOpen(false);
  };

  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.name ?? '—';
  const clashCount = plan?.filter((p) => p.clashRiddles.length || !p.sessionId).length ?? 0;

  return (
    <div className="panel panel-import">
      <div className="btn-row">
        <button className="btn" onClick={() => { setOpen(!open); setPlan(null); }}>
          {open ? '收起自动分批' : '✨ 自动分批（按谜目/难度/标签 + 均衡轮询）'}
        </button>
        {open && <span className="muted small">从最少条数的场次轮询分配，自动避开同场重复谜面；只先出方案，确认后才落库。</span>}
      </div>
      {open && (
        <div className="autobatch">
          <div className="filter-chips">
            <span className="muted small">谜目（不选=不限）：</span>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <label key={k} className={`chip${criteria.categories.includes(k) ? ' on' : ''}`}>
                <input type="checkbox" hidden checked={criteria.categories.includes(k)}
                  onChange={() => setCriteria({ ...criteria, categories: toggleArr(criteria.categories, k) })} />{v}
              </label>
            ))}
          </div>
          <div className="filter-chips">
            <span className="muted small">难度：</span>
            {[1, 2, 3].map((d) => (
              <label key={d} className={`chip${criteria.difficulties.includes(d) ? ' on' : ''}`}>
                <input type="checkbox" hidden checked={criteria.difficulties.includes(d)}
                  onChange={() => setCriteria({ ...criteria, difficulties: toggleArr(criteria.difficulties, d) })} />{'★'.repeat(d)}
              </label>
            ))}
          </div>
          {allTags.length > 0 && (
            <div className="filter-chips">
              <span className="muted small">标签（任一命中）：</span>
              {allTags.slice(0, 12).map((t) => (
                <label key={t} className={`chip${criteria.tags.includes(t) ? ' on' : ''}`}>
                  <input type="checkbox" hidden checked={criteria.tags.includes(t)}
                    onChange={() => setCriteria({ ...criteria, tags: toggleArr(criteria.tags, t) })} />{t}
                </label>
              ))}
            </div>
          )}
          <div className="btn-row wrap">
            <label className="check-inline"><input type="checkbox" checked={criteria.onlyUnassigned}
              onChange={(e) => setCriteria({ ...criteria, onlyUnassigned: e.target.checked })} /> 只编排未分配的谜条</label>
            <label className="field field-inline"><span>每场最多</span>
              <input className="input input-sm" type="number" min={0} style={{ width: 80 }} value={criteria.perSessionLimit}
                onChange={(e) => setCriteria({ ...criteria, perSessionLimit: Math.max(0, Number(e.target.value) || 0) })} />
              <span className="muted small">条（0=不限）</span>
            </label>
            <button className="btn btn-primary" onClick={generate}>生成方案</button>
          </div>
          {plan && (
            <div className="plan-preview">
              <p>
                方案共 {plan.length} 条，可直接落位 <b className="ok-text">{plan.length - clashCount}</b> 条，
                {clashCount > 0 ? <b className="bad-text"> {clashCount} 条因各场都撞面/满员未排入</b> : ' 无撞面'}。
              </p>
              <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>谜号</th><th>谜面</th><th>拟分到</th><th>冲突</th></tr></thead>
                  <tbody>
                    {plan.slice(0, 200).map((p) => (
                      <tr key={p.riddle.id} className={p.clashRiddles.length || !p.sessionId ? 'row-clash' : ''}>
                        <td>{p.riddle.no}</td><td>{p.riddle.surface}</td>
                        <td>{p.sessionId ? sessionName(p.sessionId) : '—'}</td>
                        <td>{p.clashRiddles.length ? <span className="bad-text small">与 #{p.clashRiddles.map((r) => r.no).join('、#')} 同谜面</span> : <span className="ok-text small">可放</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" onClick={apply}>确认应用（{plan.length - clashCount} 条）</button>
                <button className="btn btn-ghost" onClick={() => setPlan(null)}>取消</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- ③ 场次清单 ---------------- */

function ListsTab({ clashes, balance, view }: {
  clashes: ReturnType<typeof findClashes>;
  balance: ReturnType<typeof analyzeBalance>;
  view: ReturnType<typeof buildScheduleView>;
}) {
  const state = useAppState();
  const { riddles, sessions, booths, assignments, borrows } = state;
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? '');
  const [borrowFor, setBorrowFor] = useState<Riddle | null>(null);
  const [notice, setNotice] = useState('');

  const activeId = sessions.some((s) => s.id === sessionId) ? sessionId : sessions[0]?.id ?? '';
  const groups = useMemo(
    () => activeId ? sessionList(activeId, riddles, sessions, booths, assignments, borrows) : [],
    [activeId, riddles, sessions, booths, assignments, borrows],
  );
  const row = view.bySession.find((s) => s.session.id === activeId);

  const moveBooth = async (r: Riddle, boothId: string) => { await store.setBooth(r.id, boothId); };
  const moveSession = async (r: Riddle, sid: string) => {
    if (!sid || sid === activeId) return;
    const dups = clashWith(r, sid, riddles, sessions, booths, assignments, borrows);
    if (dups.length && !confirm(`移到「${sessions.find((s) => s.id === sid)?.name}」后会有重复谜面（谜号 ${[...new Set(dups.map((d) => d.no))].join('、')}），仍要移动吗？`)) return;
    await store.assignRiddle(r.id, sid);
    setNotice(`谜号 ${r.no} 已移到「${sessions.find((s) => s.id === sid)?.name}」，本场其它安排不变`);
  };
  const removeFromSession = async (r: Riddle) => {
    if (!confirm(`把谜号 ${r.no} 移出本场？移出后为「未编排」，其它场次不受影响。`)) return;
    await store.unassign([r.id]);
  };

  if (!sessions.length) return <div className="panel empty no-print">请先在「① 时段与摊位」中创建时段。</div>;

  return (
    <div className="no-print">
      {notice && <div className="notice">{notice}<button className="notice-x" onClick={() => setNotice('')} aria-label="关闭">×</button></div>}

      <div className="panel balance-panel">
        <h3>场地条数与均衡建议</h3>
        <div className="balance-bars">
          {balance.sessionTotals.map((t) => {
            const w = balance.max ? Math.round((t.total / balance.max) * 100) : 0;
            return (
              <div key={t.session.id} className="balance-row">
                <span className="balance-name">{t.session.name}<small>{t.session.start}</small></span>
                <span className="balance-track"><span className={`balance-fill${t.total === balance.max ? ' max' : t.total === balance.min && balance.sessionTotals.length > 1 ? ' min' : ''}`} style={{ width: `${w}%` }} /></span>
                <b>{t.total} 条</b>
              </div>
            );
          })}
        </div>
        <ul className={`check-list ${balance.balanced ? 'check-pass' : 'check-suspect'}`}>
          {balance.messages.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      </div>

      {clashes.length > 0 && (
        <div className="panel clash-panel">
          <h3 className="bad-text">⚠ 同一时段内出现重复谜面（{clashes.length} 组）</h3>
          <ul className="dup-list">
            {clashes.slice(0, 20).map((c, i) => (
              <li key={i}>
                <b>「{c.items[0].riddle.surface}」</b>
                {' '}在{[...new Set(c.items.map((it) => `${it.session.name}·${it.boothName}`))].map((x) => `「${x}」`).join('、')}
                （谜号 {c.items.map((it) => `#${it.riddle.no}`).join('、')}）
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="tabs">
        {sessions.map((s) => (
          <button key={s.id} className={`tab${s.id === activeId ? ' active' : ''}`} onClick={() => setSessionId(s.id)}>
            {s.name}
            <span className="tab-count">{view.bySession.find((x) => x.session.id === s.id)?.total ?? 0}</span>
          </button>
        ))}
      </div>

      {row && (
        <p className="muted small session-summary">
          {row.session.name}（{row.session.start}{row.session.end ? `–${row.session.end}` : ''}）：
          归属 {row.owned} 条{row.borrowedIn ? `，借入 ${row.borrowedIn} 条` : ''}{row.borrowedOut ? `，借出 ${row.borrowedOut} 条` : ''}，
          实际挂出 <b className={balance.balanced ? 'ok-text' : 'warn-text'}>{row.total} 条</b>
        </p>
      )}

      {groups.map((g) => (
        <div className="panel booth-list" key={g.booth?.id ?? 'none'}>
          <h3>
            {g.booth ? g.booth.name : '未指定摊位'}
            {g.booth?.owner ? <small>负责人：{g.booth.owner}{g.booth.location ? ` · ${g.booth.location}` : ''}</small> : <small className="muted">未指定负责人</small>}
            <span className="badge">{g.items.length} 条</span>
          </h3>
          <div className="table-wrap">
            <table className="schedule-table">
              <thead><tr><th>谜号</th><th>谜面</th><th>谜底</th><th>谜目</th><th>难度</th><th>来源</th><th>本场内调度</th></tr></thead>
              <tbody>
                {g.items.map((it) => (
                  <tr key={`${it.riddle.id}-${it.status}`} className={it.status === 'own' ? '' : 'row-borrowed'}>
                    <td className="no-cell">{it.riddle.no}</td>
                    <td>{it.riddle.surface}{it.riddle.tags[0] ? <span className="tag">{it.riddle.tags[0]}</span> : null}</td>
                    <td>{it.riddle.answer}</td>
                    <td>{CATEGORY_LABEL[it.riddle.category]}</td>
                    <td><Stars n={it.riddle.difficulty} /></td>
                    <td>{it.status === 'borrowedIn'
                      ? <span className="badge badge-warn" title={it.otherSession ? `归属：${it.otherSession.name}` : ''}>借自「{it.otherSession?.name ?? '?'}」</span>
                      : it.status === 'lentOut'
                        ? <span className="badge badge-borrowout" title={`借给：${it.otherSession?.name ?? ''}`}>借给「{it.otherSession?.name ?? '?'}」</span>
                        : <span className="badge badge-solved">本场</span>}</td>
                    <td>
                      {it.status === 'borrowedIn' ? (
                        <span className="muted small">借入谜条，请在借用记录中归还</span>
                      ) : (
                        <div className="row-actions">
                          <select className="input input-sm" value={g.booth?.id ?? ''}
                            onChange={(e) => moveBooth(it.riddle, e.target.value)} title="改挂摊位">
                            <option value="">未指定摊位</option>
                            {booths.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                          <select className="input input-sm" value="" onChange={(e) => moveSession(it.riddle, e.target.value)} title="移到其它场次">
                            <option value="">移到场次…</option>
                            {sessions.filter((s) => s.id !== activeId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                          <button className="btn btn-sm" onClick={() => setBorrowFor(it.riddle)}
                            disabled={it.status === 'lentOut'} title={it.status === 'lentOut' ? '该谜条已借出，请先归还' : ''}>借到别场</button>
                          <button className="btn btn-sm btn-danger" onClick={() => removeFromSession(it.riddle)}>移出</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {!groups.length && <div className="panel empty">本场还没有谜条，去「② 分批编排」分配，或从其它场次借入。</div>}

      {view.unassigned.length > 0 && (
        <div className="panel">
          <h3>未编排（{view.unassigned.length} 条）</h3>
          <p className="muted small">这些谜条还不属于任何场次：{view.unassigned.slice(0, 12).map((r) => `#${r.no}`).join('、')}{view.unassigned.length > 12 ? ' …' : ''}</p>
        </div>
      )}

      {borrowFor && (
        <BorrowDialog riddle={borrowFor} onClose={() => setBorrowFor(null)}
          onDone={() => { setNotice(`已登记借用：谜号 ${borrowFor.no} 归属不变，借入场次清单中可见`); setBorrowFor(null); }} />
      )}
    </div>
  );
}

function BorrowDialog({ riddle, onClose, onDone }: { riddle: Riddle; onClose: () => void; onDone: () => void }) {
  const state = useAppState();
  const assignment = state.assignments.find((a) => a.riddleId === riddle.id);
  const fromSession = state.sessions.find((s) => s.id === assignment?.sessionId);
  const others = state.sessions.filter((s) => s.id !== assignment?.sessionId);
  const [toSession, setToSession] = useState(others[0]?.id ?? '');
  const [boothId, setBoothId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    const res = await store.borrowRiddle({ riddleId: riddle.id, toSessionId: toSession, boothId, reason });
    if (!res.ok) { setError(res.error ?? '借用失败'); return; }
    onDone();
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>跨场次借用 — 谜号 {riddle.no}《{riddle.surface}》</h3>
        <p className="muted small">归属场次保持为「{fromSession?.name ?? '?'}」，仅在借入场次临时挂出，并在借用台账留痕；可随时归还。</p>
        <label className="field"><span>借入场次</span>
          <select className="input" value={toSession} onChange={(e) => setToSession(e.target.value)}>
            {others.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.start}）</option>)}
          </select>
        </label>
        <label className="field"><span>借入摊位</span>
          <select className="input" value={boothId} onChange={(e) => setBoothId(e.target.value)}>
            <option value="">未指定摊位</option>
            {state.booths.map((b) => <option key={b.id} value={b.id}>{b.name}{b.owner ? `（${b.owner}）` : ''}</option>)}
          </select>
        </label>
        <label className="field"><span>借用原因（可选）</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：午场字谜供不应求" />
        </label>
        {error && <p className="msg msg-bad">{error}</p>}
        <div className="btn-row">
          <button className="btn btn-primary" onClick={submit} disabled={!toSession}>登记借用</button>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- ④ 借用记录 ---------------- */

function BorrowsTab({ onExport }: { onExport: () => void }) {
  const state = useAppState();
  const { borrows, sessions, booths, riddles } = state;
  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.name ?? '(已删除场次)';
  const boothName = (id: string) => booths.find((b) => b.id === id)?.name ?? '未指定';
  const riddleOf = (id: string) => riddles.find((r) => r.id === id);

  const active = borrows.filter((b) => !b.returnedAt);
  const history = borrows.filter((b) => b.returnedAt);

  const Section = ({ title, list, showReturn }: { title: string; list: typeof borrows; showReturn: boolean }) => (
    <div className="panel">
      <h3>{title}（{list.length}）</h3>
      {list.length === 0 ? <p className="muted small">暂无记录。借用入口在「③ 场次清单」每条本场谜条的「借到别场」按钮。</p> : (
        <div className="table-wrap">
          <table className="schedule-table">
            <thead><tr><th>谜号</th><th>谜面</th><th>借出方（归属）</th><th>借入方</th><th>摊位</th><th>原因</th><th>时间</th>{showReturn && <th>操作</th>}</tr></thead>
            <tbody>
              {list.map((b) => {
                const r = riddleOf(b.riddleId);
                return (
                  <tr key={b.id}>
                    <td className="no-cell">{r?.no ?? '—'}</td>
                    <td>{r?.surface ?? <span className="muted">谜条已删除</span>}</td>
                    <td>{sessionName(b.fromSessionId)}</td>
                    <td>{sessionName(b.toSessionId)}</td>
                    <td>{boothName(b.boothId)}</td>
                    <td className="muted small">{b.reason || '—'}</td>
                    <td className="muted small">{formatDateTime(b.at)}{b.returnedAt ? <><br />还于 {formatDateTime(b.returnedAt)}</> : ''}</td>
                    {showReturn && (
                      <td className="btn-row">
                        <button className="btn btn-sm btn-primary" onClick={() => store.returnBorrow(b.id)}>归还</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => { if (confirm('删除这条借用记录？')) void store.removeBorrow(b.id); }}>删除</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div className="no-print">
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button className="btn" onClick={onExport} disabled={!borrows.length}>⬇ 导出借用台账 CSV</button>
        <span className="muted small">借用不改归属：归还前谜条计入借入场、从借出场扣减；归还后自动恢复。</span>
      </div>
      <Section title="借用中" list={active} showReturn />
      <Section title="历史记录（已归还）" list={history} showReturn={false} />
    </div>
  );
}

/* ---------------- 打印对照表（屏幕隐藏，打印输出） ---------------- */

function SchedulePrint({ view, balance }: {
  view: ReturnType<typeof buildScheduleView>;
  balance: ReturnType<typeof analyzeBalance>;
}) {
  const state = useAppState();
  const { riddles, sessions, booths, assignments, borrows, settings } = state;
  return (
    <div className="print-area schedule-print" data-testid="schedule-print" aria-hidden>
      <div className="sp-title">
        <h2>{settings.event.title || '元宵灯会'} · 分场编排对照表</h2>
        <div className="sp-sub">
          {settings.event.date} {settings.event.host ? `· ${settings.event.host}` : ''} · 生成于 {formatDateTime(Date.now())}
        </div>
      </div>

      <table className="sp-table">
        <thead><tr><th>场次</th><th>时段</th><th>摊位数</th><th>归属</th><th>借入</th><th>借出</th><th>实挂</th></tr></thead>
        <tbody>
          {view.bySession.map((s) => (
            <tr key={s.session.id}>
              <td><b>{s.session.name}</b></td>
              <td>{s.session.start}{s.session.end ? `–${s.session.end}` : ''}</td>
              <td>{s.booths.length}</td><td>{s.owned}</td><td>{s.borrowedIn}</td><td>{s.borrowedOut}</td><td><b>{s.total}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!balance.balanced && (
        <div className="sp-advice">
          <b>调整建议：</b>
          <ol>{balance.messages.map((m, i) => <li key={i}>{m}</li>)}</ol>
        </div>
      )}

      {sessions.map((session) => {
        const groups = sessionList(session.id, riddles, sessions, booths, assignments, borrows);
        const row = view.bySession.find((s) => s.session.id === session.id);
        return (
          <section key={session.id} className="sp-session">
            <h3 className="sp-session-title">
              {session.name} <small>{session.start}{session.end ? `–${session.end}` : ''} · 实挂 {row?.total ?? 0} 条</small>
            </h3>
            {groups.map((g) => (
              <div key={g.booth?.id ?? 'none'} className="sp-booth">
                <div className="sp-booth-head">
                  摊位：{g.booth ? g.booth.name : '未指定摊位'}
                  {g.booth?.owner ? `　负责人：${g.booth.owner}` : ''}
                  {g.booth?.location ? `　位置：${g.booth.location}` : ''}
                  （{g.items.length} 条）
                </div>
                <table className="sp-table">
                  <thead><tr><th className="sp-no">谜号</th><th>谜面</th><th>谜底</th><th>谜目</th><th>难度</th><th>标签</th><th>来源</th></tr></thead>
                  <tbody>
                    {g.items.map((it) => (
                      <tr key={`${it.riddle.id}-${it.status}`}>
                        <td className="sp-no">{it.riddle.no}</td>
                        <td>{it.riddle.surface}</td>
                        <td>{it.riddle.answer}</td>
                        <td>{CATEGORY_LABEL[it.riddle.category]}</td>
                        <td>{'★'.repeat(it.riddle.difficulty)}</td>
                        <td>{it.riddle.tags.join('、')}</td>
                        <td>{it.status === 'borrowedIn'
                          ? `借自${it.otherSession?.name ?? ''}`
                          : it.status === 'lentOut' ? `借给${it.otherSession?.name ?? ''}` : '本场'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {!groups.length && <p className="muted">（本场暂无谜条）</p>}
          </section>
        );
      })}

      {view.unassigned.length > 0 && (
        <section className="sp-session">
          <h3 className="sp-session-title">未编排谜条（{view.unassigned.length} 条）</h3>
          <table className="sp-table">
            <thead><tr><th className="sp-no">谜号</th><th>谜面</th><th>谜底</th><th>谜目</th></tr></thead>
            <tbody>
              {view.unassigned.map((r) => (
                <tr key={r.id}><td className="sp-no">{r.no}</td><td>{r.surface}</td><td>{r.answer}</td><td>{CATEGORY_LABEL[r.category]}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
