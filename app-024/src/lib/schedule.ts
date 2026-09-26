// 分场编排：场次/摊位/归属/借用的纯逻辑（清单构建、同时段谜面查重、均衡分析、自动分批、导出）
import type { Assignment, Booth, BorrowRecord, Riddle, Session } from '../types';
import { CATEGORY_LABEL } from '../types';
import { normalizeText } from './normalize';
import { stringifyCSV } from './csv';

export interface SessionBoothCount {
  session: Session;
  booths: { booth: Booth | null; count: number; borrowedIn: number; owned: number }[]; // null = 未指定摊位
  owned: number;       // 归属本场的谜条数
  borrowedIn: number;  // 借入且未归还的条数（按去重谜条数）
  borrowedOut: number; // 本场归属、被别场借走且未归还的条数
  total: number;       // 本场实际挂出 = owned + borrowedIn - borrowedOut
}

export interface ScheduleView {
  bySession: SessionBoothCount[];
  unassigned: Riddle[]; // 尚未编排的谜条
  activeBorrows: BorrowRecord[];
}

/** 某谜条在指定场次实际挂出时占用的摊位（借入优先），未挂出返回 undefined */
export function effectiveBoothOf(
  riddleId: string,
  sessionId: string,
  assignments: Assignment[],
  borrows: BorrowRecord[],
): string | undefined {
  const b = borrows.find((x) => x.riddleId === riddleId && x.toSessionId === sessionId && !x.returnedAt);
  if (b) return b.boothId || undefined;
  const a = assignments.find((x) => x.riddleId === riddleId);
  if (a && a.sessionId === sessionId) return a.boothId || undefined;
  return undefined;
}

/** 构建全场分场视图：每场次每摊位条数（区分归属/借入/借出） */
export function buildScheduleView(
  riddles: Riddle[],
  sessions: Session[],
  booths: Booth[],
  assignments: Assignment[],
  borrows: BorrowRecord[],
): ScheduleView {
  const riddleMap = new Map(riddles.map((r) => [r.id, r]));
  const active = borrows.filter((b) => !b.returnedAt);
  const assignedIds = new Set(assignments.map((a) => a.riddleId));

  const bySession = [...sessions]
    .sort((a, b) => a.order - b.order || a.start.localeCompare(b.start))
    .map((session) => {
      const cell = new Map<string, { owned: number; borrowedIn: number }>();
      const ensure = (k: string) => {
        let v = cell.get(k);
        if (!v) { v = { owned: 0, borrowedIn: 0 }; cell.set(k, v); }
        return v;
      };
      let owned = 0;
      // 归属本场
      for (const a of assignments) {
        if (a.sessionId !== session.id) continue;
        owned++;
        ensure(a.boothId).owned++;
      }
      // 借入本场（去重：同一谜条多条借用记录只计一次，以最新一条定摊位）
      const inSeen = new Map<string, BorrowRecord>();
      for (const b of active) {
        if (b.toSessionId !== session.id || !riddleMap.has(b.riddleId)) continue;
        const prev = inSeen.get(b.riddleId);
        if (!prev || b.at > prev.at) inSeen.set(b.riddleId, b);
      }
      let borrowedIn = 0;
      for (const b of inSeen.values()) {
        borrowedIn++;
        ensure(b.boothId).borrowedIn++;
      }
      // 归属本场但被别场借走
      const outIds = new Set<string>();
      for (const b of active) {
        if (b.fromSessionId === session.id) outIds.add(b.riddleId);
      }
      const borrowedOut = [...outIds].filter((id) =>
        assignments.some((a) => a.riddleId === id && a.sessionId === session.id)).length;

      const usedBoothIds = new Set([...cell.keys()].filter((k) => k !== ''));
      const boothRows = [...booths]
        .sort((a, b) => a.order - b.order)
        .filter((b) => usedBoothIds.has(b.id))
        .map((b) => {
          const v = cell.get(b.id)!;
          return { booth: b as Booth | null, count: v.owned + v.borrowedIn, borrowedIn: v.borrowedIn, owned: v.owned };
        });
      const unspec = cell.get('');
      if (unspec) {
        boothRows.push({ booth: null, count: unspec.owned + unspec.borrowedIn, borrowedIn: unspec.borrowedIn, owned: unspec.owned });
      }
      return {
        session,
        booths: boothRows,
        owned,
        borrowedIn,
        borrowedOut,
        total: owned + borrowedIn - borrowedOut,
      };
    });

  const unassigned = riddles.filter((r) => !assignedIds.has(r.id));
  return { bySession, unassigned, activeBorrows: active };
}

/** 单场清单：按摊位分组（借入/借出均保留，物理谜条仍挂在归属场），保持谜号顺序 */
export interface BoothList {
  booth: Booth | null; // null = 未指定摊位
  items: {
    riddle: Riddle;
    status: 'own' | 'borrowedIn' | 'lentOut'; // 本场归属 / 借入挂出 / 归属但被别场借走
    otherSession?: Session;
  }[];
}

export function sessionList(
  sessionId: string,
  riddles: Riddle[],
  sessions: Session[],
  booths: Booth[],
  assignments: Assignment[],
  borrows: BorrowRecord[],
): BoothList[] {
  const riddleMap = new Map(riddles.map((r) => [r.id, r]));
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const active = borrows.filter((b) => !b.returnedAt);
  const groups = new Map<string, BoothList>();
  const getGroup = (boothId: string): BoothList => {
    let g = groups.get(boothId);
    if (!g) {
      g = { booth: boothId ? booths.find((b) => b.id === boothId) ?? null : null, items: [] };
      groups.set(boothId, g);
    }
    return g;
  };

  // 借入本场（同一谜条多条借用只取最新一条）
  const inLatest = new Map<string, BorrowRecord>();
  for (const b of active) {
    if (b.toSessionId !== sessionId) continue;
    const prev = inLatest.get(b.riddleId);
    if (!prev || b.at > prev.at) inLatest.set(b.riddleId, b);
  }
  for (const b of inLatest.values()) {
    const r = riddleMap.get(b.riddleId);
    if (!r) continue;
    getGroup(b.boothId).items.push({ riddle: r, status: 'borrowedIn', otherSession: sessionMap.get(b.fromSessionId) });
  }
  // 归属本场：被别场借走仍保留（标记借出），借入到本场的自借不重复列
  const lentOutTo = new Map<string, BorrowRecord>();
  for (const b of active) {
    if (b.fromSessionId !== sessionId) continue;
    const prev = lentOutTo.get(b.riddleId);
    if (!prev || b.at > prev.at) lentOutTo.set(b.riddleId, b);
  }
  for (const a of assignments) {
    if (a.sessionId !== sessionId) continue;
    if (inLatest.has(a.riddleId)) continue; // 异常自借，避免重复
    const r = riddleMap.get(a.riddleId);
    if (!r) continue;
    const out = lentOutTo.get(a.riddleId);
    getGroup(a.boothId).items.push(out
      ? { riddle: r, status: 'lentOut', otherSession: sessionMap.get(out.toSessionId) }
      : { riddle: r, status: 'own' });
  }

  return [...booths]
    .sort((a, b) => a.order - b.order)
    .map((b) => groups.get(b.id))
    .filter((g): g is BoothList => !!g)
    .concat(groups.has('') ? [groups.get('')!] : [])
    .map((g) => ({ ...g, items: [...g.items].sort((x, y) => x.riddle.no - y.riddle.no) }));
}

// ---- 同时段谜面查重（归一化；同一物理谜条被借入与归属重合时跳过）----
export interface SurfaceClash {
  norm: string;
  items: { riddle: Riddle; session: Session; boothName: string; borrowed: boolean }[];
}

export function findClashes(
  riddles: Riddle[],
  sessions: Session[],
  booths: Booth[],
  assignments: Assignment[],
  borrows: BorrowRecord[],
): SurfaceClash[] {
  const buckets = new Map<string, SurfaceClash['items']>();

  const add = (norm: string, item: SurfaceClash['items'][number]) => {
    const arr = buckets.get(norm) || [];
    // 同一谜条在同一场重复出现（归属 + 异常自借）只保留一条
    if (arr.some((x) => x.riddle.id === item.riddle.id && x.session.id === item.session.id)) return;
    arr.push(item);
    buckets.set(norm, arr);
  };

  for (const session of sessions) {
    const lists = sessionList(session.id, riddles, sessions, booths, assignments, borrows);
    for (const g of lists) {
      const boothName = g.booth ? g.booth.name : '未指定摊位';
      for (const it of g.items) {
        const n = normalizeText(it.riddle.surface);
        if (n) add(n, { riddle: it.riddle, session, boothName, borrowed: it.status !== 'own' });
      }
    }
  }
  // 仅在同一场次内出现 ≥2 个不同谜条才算撞面
  return [...buckets.entries()]
    .map(([norm, items]) => ({ norm, items }))
    .filter((c) => {
      for (const s of sessions) {
        const ids = new Set(c.items.filter((i) => i.session.id === s.id).map((i) => i.riddle.id));
        if (ids.size >= 2) return true;
      }
      return false;
    });
}

/**
 * 检查谜条放入某场次是否会撞面，返回同场重复谜面（其它谜条）。
 * 预检的是「拟放入」状态：先剔除目标谜条自身的现存条目（重排/模拟时可能存在），
 * 再比较该场实际挂出的其它谜条。
 */
export function clashWith(
  riddle: Riddle,
  sessionId: string,
  riddles: Riddle[],
  sessions: Session[],
  booths: Booth[],
  assignments: Assignment[],
  borrows: BorrowRecord[],
): Riddle[] {
  const n = normalizeText(riddle.surface);
  if (!n) return [];
  const restA = assignments.filter((a) => a.riddleId !== riddle.id);
  const restB = borrows.filter((b) => b.riddleId !== riddle.id);
  const lists = sessionList(sessionId, riddles, sessions, booths, restA, restB);
  const out: Riddle[] = [];
  const seen = new Set<string>();
  for (const g of lists) {
    for (const it of g.items) {
      if (seen.has(it.riddle.id)) continue;
      if (normalizeText(it.riddle.surface) === n) { seen.add(it.riddle.id); out.push(it.riddle); }
    }
  }
  return out;
}

// ---- 均衡分析与调整建议 ----
export interface BalanceAdvice {
  sessionTotals: { session: Session; total: number }[];
  avg: number;
  max: number;
  min: number;
  balanced: boolean;
  messages: string[];
  boothAdvice: { session: Session; booth: Booth | null; count: number; expected: number }[];
}

/**
 * 均衡判定：
 * - 场次间：最多与最少相差不超过 max(2, ceil(平均×阈值))；
 * - 摊位间：同一场内最多与最少摊位相差不超过 max(1, ceil(均值×阈值))。
 */
export function analyzeBalance(view: ScheduleView, sessionThreshold = 0.2, boothThreshold = 0.3): BalanceAdvice {
  const sessionTotals = view.bySession
    .map((s) => ({ session: s.session, total: s.total }))
    .filter((s) => s.total > 0);
  const messages: string[] = [];
  const boothAdvice: BalanceAdvice['boothAdvice'] = [];

  if (sessionTotals.length === 0) {
    return { sessionTotals, avg: 0, max: 0, min: 0, balanced: true, messages: ['尚未编排任何谜条。'], boothAdvice };
  }

  const counts = sessionTotals.map((s) => s.total);
  const total = counts.reduce((a, b) => a + b, 0);
  const avg = total / sessionTotals.length;
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const sessionTol = Math.max(2, Math.ceil(avg * sessionThreshold));
  let balanced = max - min <= sessionTol;

  if (!balanced) {
    const hi = sessionTotals.find((s) => s.total === max)!;
    const lo = sessionTotals.find((s) => s.total === min)!;
    messages.push(
      `场次间不均衡：「${hi.session.name}」${max} 条、「${lo.session.name}」仅 ${min} 条（相差 ${max - min} 条，容差 ${sessionTol}）。建议从「${hi.session.name}」调 ${max - min - sessionTol}~${max - min} 条到「${lo.session.name}」（优先调同谜目或低难度谜条）。`,
    );
  } else {
    messages.push(`场次间基本均衡（${min}~${max} 条，平均 ${avg.toFixed(1)}）。`);
  }

  for (const row of view.bySession) {
    const boothCounts = row.booths.map((b) => ({ booth: b.booth, count: b.count })).filter((b) => b.count > 0);
    if (boothCounts.length < 2) continue;
    const bvals = boothCounts.map((b) => b.count);
    const bAvg = bvals.reduce((a, b) => a + b, 0) / bvals.length;
    const bMax = Math.max(...bvals);
    const bMin = Math.min(...bvals);
    const tol = Math.max(1, Math.ceil(bAvg * boothThreshold));
    if (bMax - bMin > tol) {
      balanced = false;
      const bHi = boothCounts.find((b) => b.count === bMax)!;
      const bLo = boothCounts.find((b) => b.count === bMin)!;
      messages.push(
        `「${row.session.name}」摊位不均：${bHi.booth ? `「${bHi.booth.name}」` : '未指定摊位'} ${bMax} 条、${bLo.booth ? `「${bLo.booth.name}」` : '未指定摊位'} ${bMin} 条，建议调出 ${bMax - bMin - tol}~${bMax - bMin} 条。`,
      );
      for (const b of boothCounts) {
        boothAdvice.push({ session: row.session, booth: b.booth, count: b.count, expected: Math.round(bAvg) });
      }
    }
  }

  const unassigned = view.unassigned.length;
  if (unassigned > 0) messages.push(`还有 ${unassigned} 条谜未编排到场次，可用「自动分批」补齐。`);
  if (view.activeBorrows.length > 0) messages.push(`当前有 ${view.activeBorrows.length} 条跨场借用未归还，条数已计入借入方、从借出方扣除。`);

  return { sessionTotals, avg, max, min, balanced, messages, boothAdvice };
}

// ---- 自动分批 ----
export interface BatchCriteria {
  categories: string[]; // 空 = 不限谜目
  difficulties: number[]; // 空 = 不限难度
  tags: string[]; // 空 = 不限标签；命中任一即可
  onlyUnassigned: boolean;
  perSessionLimit: number; // 每场最多新增多少，0 = 不限
}

export const EMPTY_CRITERIA: BatchCriteria = {
  categories: [], difficulties: [], tags: [], onlyUnassigned: true, perSessionLimit: 0,
};

function matchCriteria(r: Riddle, c: BatchCriteria): boolean {
  if (c.categories.length && !c.categories.includes(r.category)) return false;
  if (c.difficulties.length && !c.difficulties.includes(r.difficulty)) return false;
  if (c.tags.length && !c.tags.some((t) => r.tags.includes(t))) return false;
  return true;
}

export interface BatchPlanItem {
  riddle: Riddle;
  sessionId: string;
  clashRiddles: Riddle[]; // 放入后同场撞面的谜
}

/**
 * 自动分批方案（只出方案，不直接落库）：
 * 符合条件的谜条轮询分到各场次（round-robin 保持均衡），
 * 撞面或该场超限时顺延到下一场；无处可去的场次标记 clashRiddles 且 sessionId=''。
 */
export function planBatch(
  riddles: Riddle[],
  sessions: Session[],
  booths: Booth[],
  assignments: Assignment[],
  borrows: BorrowRecord[],
  criteria: BatchCriteria,
): BatchPlanItem[] {
  const ordered = [...sessions].sort((a, b) => a.order - b.order || a.start.localeCompare(b.start));
  if (!ordered.length) return [];
  // 以当前总挂出条数决定轮转起点，多的场次排后面
  const view = buildScheduleView(riddles, sessions, booths, assignments, borrows);
  const totals = new Map(view.bySession.map((s) => [s.session.id, s.total]));
  const pool = riddles
    .filter((r) => matchCriteria(r, criteria))
    .filter((r) => !criteria.onlyUnassigned || !assignments.some((a) => a.riddleId === r.id))
    .sort((a, b) => a.no - b.no);

  // 工作副本，用于逐条模拟（按 riddleId 去重，重排已归属谜条时不产生重复归属）
  const workA: Assignment[] = [...new Map(assignments.map((a) => [a.riddleId, a])).values()];
  const workB = [...borrows];
  const quota = new Map(ordered.map((s) => [s.id, criteria.perSessionLimit > 0 ? criteria.perSessionLimit : Infinity]));
  const added = new Map(ordered.map((s) => [s.id, 0]));
  const stableIndex = new Map(ordered.map((s, i) => [s.id, i]));
  let rr = 0;
  const out: BatchPlanItem[] = [];

  for (const riddle of pool) {
    // 优先级：当前条数最少优先；同水位按稳定次序从 rr 起轮转
    const tieKey = (sid: string) => (stableIndex.get(sid)! - rr + ordered.length) % ordered.length;
    const priority = [...ordered].sort((a, b) =>
      (totals.get(a.id)! - totals.get(b.id)!) || tieKey(a.id) - tieKey(b.id));
    let placedSession: Session | null = null;
    const clashesAll: Riddle[] = [];
    for (const s of priority) {
      if (added.get(s.id)! >= quota.get(s.id)!) continue;
      const clashes = clashWith(riddle, s.id, riddles, sessions, booths, workA, workB);
      if (clashes.length) { clashesAll.push(...clashes); continue; }
      placedSession = s;
      break;
    }
    if (placedSession) {
      const s = placedSession;
      const idx = workA.findIndex((x) => x.riddleId === riddle.id);
      if (idx >= 0) workA.splice(idx, 1); // 重排已归属谜条：先移除旧归属再模拟
      workA.push({ id: riddle.id, riddleId: riddle.id, sessionId: s.id, boothId: '', at: 0 });
      added.set(s.id, added.get(s.id)! + 1);
      totals.set(s.id, totals.get(s.id)! + 1);
      rr = (stableIndex.get(s.id)! + 1) % ordered.length;
      out.push({ riddle, sessionId: s.id, clashRiddles: [] });
    } else {
      // 所有场次都撞面或满员：满员不排入；全撞面挂到最少场次但标记冲突，由用户决定
      const allClash = clashesAll.length > 0 && clashesAll.length >= ordered.length;
      const fallback = priority.reduce((a, b) => (totals.get(a.id)! <= totals.get(b.id)! ? a : b));
      out.push({
        riddle,
        sessionId: criteria.perSessionLimit > 0 && !allClash ? '' : fallback.id,
        clashRiddles: dedupeRiddles(clashesAll, riddle.id),
      });
    }
  }
  return out;
}

function dedupeRiddles(list: Riddle[], selfId: string): Riddle[] {
  const seen = new Set<string>();
  const out: Riddle[] = [];
  for (const r of list) {
    if (r.id === selfId || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.slice(0, 5);
}

// ---- 导出 ----
export const SCHEDULE_CSV_HEADERS = ['场次', '时段', '摊位', '摊位负责人', '谜号', '谜面', '谜底', '谜目', '难度', '标签', '来源标记'];

/** 全部分场清单 CSV（按场次 → 摊位 → 谜号排序）；含借入标记与未编排行 */
export function scheduleToCSV(
  eventTitle: string,
  riddles: Riddle[],
  sessions: Session[],
  booths: Booth[],
  assignments: Assignment[],
  borrows: BorrowRecord[],
): string {
  const rows: (string | number)[][] = [];
  for (const s of [...sessions].sort((a, b) => a.order - b.order || a.start.localeCompare(b.start))) {
    const groups = sessionList(s.id, riddles, sessions, booths, assignments, borrows);
    for (const g of groups) {
      for (const it of g.items) {
        const r = it.riddle;
        const source = it.status === 'borrowedIn'
          ? `借自「${it.otherSession?.name ?? '其他场'}」`
          : it.status === 'lentOut'
            ? `借给「${it.otherSession?.name ?? '其他场'}」`
            : '本场';
        rows.push([
          s.name,
          `${s.start}-${s.end}`,
          g.booth?.name ?? '未指定摊位',
          g.booth?.owner ?? '',
          r.no,
          r.surface,
          r.answer,
          CATEGORY_LABEL[r.category],
          r.difficulty,
          r.tags.join('、'),
          source,
        ]);
      }
    }
  }
  const view = buildScheduleView(riddles, sessions, booths, assignments, borrows);
  for (const r of view.unassigned.sort((a, b) => a.no - b.no)) {
    rows.push(['未编排', '', '', '', r.no, r.surface, r.answer, CATEGORY_LABEL[r.category], r.difficulty, r.tags.join('、'), '待分配']);
  }
  return stringifyCSV([[`分场编排清单${eventTitle ? ` · ${eventTitle}` : ''}`], SCHEDULE_CSV_HEADERS, ...rows]);
}

/** 借用台账 CSV */
export function borrowLedgerToCSV(
  sessions: Session[],
  booths: Booth[],
  borrows: BorrowRecord[],
  riddles: Riddle[],
): string {
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const boothMap = new Map(booths.map((b) => [b.id, b]));
  const riddleMap = new Map(riddles.map((r) => [r.id, r]));
  const rows = borrows.map((b) => {
    const r = riddleMap.get(b.riddleId);
    return [
      r?.no ?? '', r?.surface ?? '',
      sessionMap.get(b.fromSessionId)?.name ?? '(已删除场次)',
      sessionMap.get(b.toSessionId)?.name ?? '(已删除场次)',
      boothMap.get(b.boothId)?.name ?? '未指定',
      b.reason ?? '',
      b.returnedAt ? '已归还' : '借用中',
      new Date(b.at).toLocaleString('zh-CN'),
      b.returnedAt ? new Date(b.returnedAt).toLocaleString('zh-CN') : '',
    ];
  });
  return stringifyCSV([['谜号', '谜面', '借出方（归属场次）', '借入方', '借入摊位', '借用原因', '状态', '借用时间', '归还时间'], ...rows]);
}
