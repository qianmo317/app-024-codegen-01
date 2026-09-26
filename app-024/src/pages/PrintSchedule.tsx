// 分场对照表打印：按场次 → 摊位分组列谜条，A4 横向；可只看一场或看全部
import { useEffect, useMemo } from 'react';
import { useAppState } from '../ui/router';
import { sessionBooths, sessionRiddleIds, boothIdOf, isBorrowedIn, ownerSessionOf } from '../lib/schedule';
import { CATEGORY_LABEL } from '../types';
import type { Riddle, Schedule, Session } from '../types';

export function PrintSchedule() {
  const state = useAppState();
  const { schedule: s, riddles, settings } = state;

  // 对照表列较多：打印时切到 A4 横向（通过 <html> 上的类切换 @page）
  useEffect(() => {
    document.documentElement.classList.add('print-landscape');
    return () => document.documentElement.classList.remove('print-landscape');
  }, []);

  const targetId = useMemo(() => {
    const m = location.hash.match(/[?&]s=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }, []);

  const sessions = targetId ? s.sessions.filter((x) => x.id === targetId) : s.sessions;
  const byId = useMemo(() => new Map(riddles.map((r) => [r.id, r])), [riddles]);
  const printedAt = new Date().toLocaleString('zh-CN');

  return (
    <div>
      <div className="page-head no-print">
        <h1>分场对照表 <small>{sessions.length} 场 · 可直接打印或另存为 PDF</small></h1>
        <div className="btn-row">
          <a className="btn" href="#/schedule">← 返回编排</a>
          <button className="btn btn-primary" onClick={() => window.print()}>🖨 打印对照表</button>
        </div>
      </div>

      <div className="schedule-print" data-testid="schedule-print">
        {sessions.map((session) => (
          <SessionTable key={session.id} s={s} session={session} byId={byId} host={settings.event.host || settings.print.hostLine} printedAt={printedAt} />
        ))}
        {sessions.length === 0 && <div className="panel empty">没有可打印的场次。</div>}
      </div>
    </div>
  );
}

function SessionTable({
  s, session, byId, host, printedAt,
}: { s: Schedule; session: Session; byId: Map<string, Riddle>; host: string; printedAt: string }) {
  const booths = sessionBooths(s, session.id);
  const present = sessionRiddleIds(s, session.id)
    .map((id) => byId.get(id))
    .filter((r): r is Riddle => !!r)
    .sort((a, b) => a.no - b.no);

  // 按摊位排序分组
  const order = new Map<string, number>();
  booths.forEach((b, i) => order.set(b.id, i));
  const groups = new Map<string, Riddle[]>();
  booths.forEach((b) => groups.set(b.id, []));
  const loose: Riddle[] = [];
  for (const r of present) {
    const b = boothIdOf(s, r.id, session.id);
    if (b && groups.has(b)) groups.get(b)!.push(r);
    else loose.push(r);
  }

  const sections: { title: string; owner: string; rows: Riddle[] }[] = [
    ...booths.map((b) => ({ title: b.name, owner: b.owner, rows: groups.get(b.id) ?? [] })),
  ];
  if (loose.length) sections.push({ title: '未挂摊', owner: '', rows: loose });

  return (
    <section className="cp-sheet" key={session.id}>
      <div className="cp-head">
        <h2>{session.name}</h2>
        <div className="cp-meta">
          {session.start || '--:--'}–{session.end || '--:--'} ｜ 共 {present.length} 条
          {host ? ` ｜ ${host}` : ''}
        </div>
      </div>
      {sections.map((sec) => (
        <div className="cp-block" key={sec.title}>
          <div className="cp-block-title">
            摊位：{sec.title}{sec.owner ? `　负责人：${sec.owner}` : ''}　<span className="cp-count">{sec.rows.length} 条</span>
          </div>
          <table className="cp-table">
            <thead>
              <tr>
                <th className="cp-no">谜号</th>
                <th>谜面</th>
                <th>谜底</th>
                <th className="cp-cat">谜目</th>
                <th className="cp-diff">难度</th>
                <th>标签</th>
                <th className="cp-mode">来源</th>
                <th>归属场次</th>
              </tr>
            </thead>
            <tbody>
              {sec.rows.map((r) => {
                const borrowed = isBorrowedIn(s, r.id, session.id);
                const ownerName = borrowed
                  ? s.sessions.find((x) => x.id === ownerSessionOf(s, r.id))?.name ?? '—'
                  : session.name;
                return (
                  <tr key={r.id}>
                    <td className="cp-no">{r.no}</td>
                    <td>{r.surface}</td>
                    <td>{r.answer}</td>
                    <td>{CATEGORY_LABEL[r.category]}</td>
                    <td>{'★'.repeat(r.difficulty)}</td>
                    <td>{r.tags.join('、')}</td>
                    <td>{borrowed ? '借用' : '自有'}</td>
                    <td>{ownerName}</td>
                  </tr>
                );
              })}
              {sec.rows.length === 0 && (
                <tr><td colSpan={8} className="cp-empty">（空摊位）</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
      <div className="cp-foot">打印时间 {printedAt} · 每条谜条仅一个归属场次；借用条目标注「借用」</div>
    </section>
  );
}
