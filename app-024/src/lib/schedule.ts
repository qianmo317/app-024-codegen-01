// 分场编排：纯函数领域逻辑（场次/摊位/归属/借用/查重/均衡），便于单测
import type { Booth, Borrow, Placement, Riddle, Schedule, Session } from '../types';
import { CATEGORY_LABEL } from '../types';
import { normalizeText, similarity } from './normalize';
import { DUP_THRESHOLD } from './duplicates';

let counter = 0;
export function scheduleUid(prefix = 's'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}${Math.random().toString(36).slice(2, 6)}`;
}

export function nowTs(): number { return Date.now(); }

// ---- 查询 ----
const getPlacement = (s: Schedule, riddleId: string): Placement | undefined =>
  s.placements.find((p) => p.riddleId === riddleId);

/** 谜条归属场次（每条谜条只有一个归属） */
export function ownerSessionOf(s: Schedule, riddleId: string): string | undefined {
  return getPlacement(s, riddleId)?.ownerSessionId;
}

/** 借用给该场次的有效借用记录 */
export function activeBorrowInto(s: Schedule, riddleId: string, sessionId: string): Borrow | undefined {
  return s.borrows.find((b) => b.riddleId === riddleId && b.toSessionId === sessionId && b.status === 'active');
}

/** 某场次实际在场的谜条：自有归属 + 借入（含借入未挂摊） */
export function sessionRiddleIds(s: Schedule, sessionId: string): string[] {
  const ids = new Set<string>();
  for (const p of s.placements) if (p.ownerSessionId === sessionId) ids.add(p.riddleId);
  for (const b of s.borrows) if (b.toSessionId === sessionId && b.status === 'active') ids.add(b.riddleId);
  return [...ids];
}

/** 某摊位上的谜条（自有挂摊 + 借入挂到该摊） */
export function boothRiddleIds(s: Schedule, boothId: string): string[] {
  const ids = new Set<string>();
  for (const p of s.placements) if (p.boothId === boothId) ids.add(p.riddleId);
  for (const b of s.borrows) if (b.boothId === boothId && b.status === 'active') ids.add(b.riddleId);
  return [...ids];
}

/** 在场但未挂摊 */
export function unplacedRiddleIds(s: Schedule, sessionId: string): string[] {
  return sessionRiddleIds(s, sessionId).filter((id) => !boothIdOf(s, id, sessionId));
}

/** 谜条在该场次挂在哪个摊位（借入以借用记录上的挂摊为准） */
export function boothIdOf(s: Schedule, riddleId: string, sessionId: string): string | undefined {
  const p = getPlacement(s, riddleId);
  if (p?.ownerSessionId === sessionId) return p.boothId;
  return activeBorrowInto(s, riddleId, sessionId)?.boothId;
}

export function isBorrowedIn(s: Schedule, riddleId: string, sessionId: string): boolean {
  return !!activeBorrowInto(s, riddleId, sessionId);
}

export function sessionBooths(s: Schedule, sessionId: string): Booth[] {
  return s.booths.filter((b) => b.sessionId === sessionId);
}

export function boothName(s: Schedule, boothId?: string): string {
  if (!boothId) return '未挂摊';
  return s.booths.find((b) => b.id === boothId)?.name ?? '未挂摊';
}

// ---- 场次内查重 ----
export interface SessionDupIssue {
  kind: 'exact' | 'similar';
  aId: string;
  bId: string;
  similarity: number;
}

/**
 * 同一时段内不出现重复谜面：
 * - exact：归一化后完全相同（标点/繁简差异也算），硬性拦截
 * - similar：同谜目且相似度 ≥ 0.85，给出警告但不强制
 */
export function findSessionDupIssues(
  s: Schedule,
  sessionId: string,
  riddles: Riddle[],
  threshold = DUP_THRESHOLD,
): SessionDupIssue[] {
  const byId = new Map(riddles.map((r) => [r.id, r]));
  const present = sessionRiddleIds(s, sessionId).map((id) => byId.get(id)).filter((r): r is Riddle => !!r);
  const norm = present.map((r) => ({ r, n: normalizeText(r.surface) }));
  const issues: SessionDupIssue[] = [];
  for (let i = 0; i < norm.length; i++) {
    for (let j = i + 1; j < norm.length; j++) {
      const a = norm[i], b = norm[j];
      if (!a.n || !b.n) continue;
      if (a.n === b.n) {
        issues.push({ kind: 'exact', aId: a.r.id, bId: b.r.id, similarity: 1 });
        continue;
      }
      if (a.r.category === b.r.category) {
        const sim = similarity(a.n, b.n);
        if (sim >= threshold) issues.push({ kind: 'similar', aId: a.r.id, bId: b.r.id, similarity: sim });
      }
    }
  }
  return issues.sort((x, y) => y.similarity - x.similarity);
}

/** 单条谜条放入某场次前的硬冲突（归一化全等），无冲突返回 null */
export function exactConflict(s: Schedule, sessionId: string, riddle: Riddle, riddles: Riddle[]): Riddle | null {
  const target = normalizeText(riddle.surface);
  if (!target) return null;
  const byId = new Map(riddles.map((x) => [x.id, x]));
  for (const id of sessionRiddleIds(s, sessionId)) {
    if (id === riddle.id) continue;
    const other = byId.get(id);
    if (other && normalizeText(other.surface) === target) return other;
  }
  return null;
}

// ---- 归属编排 ----
export interface AssignResult {
  schedule: Schedule;
  assigned: string[];
  skipped: { riddleId: string; reason: 'already' | 'duplicate'; conflictNo?: number }[];
}

/**
 * 把谜条分批分到某场次（设为该场次自有）。
 * - 已在该场次（自有/借入）跳过
 * - 与场内谜面归一化全等 → 硬拦截
 * - 从其它场次转移归属：自动收回其在外有效借用；目标场次若正借入该条，则借用记录转为归属
 * 只改归属，不动其它场次已有的安排。
 */
export function assignRiddles(s: Schedule, riddleIds: string[], sessionId: string, riddles: Riddle[]): AssignResult {
  const byId = new Map(riddles.map((r) => [r.id, r]));
  let placements = [...s.placements];
  let borrows = [...s.borrows];
  const assigned: string[] = [];
  const skipped: AssignResult['skipped'] = [];

  for (const riddleId of riddleIds) {
    const riddle = byId.get(riddleId);
    if (!riddle) continue;
    const existing = placements.find((p) => p.riddleId === riddleId);
    if (existing?.ownerSessionId === sessionId) {
      skipped.push({ riddleId, reason: 'already' });
      continue;
    }
    // 目标场次正借入该条：转归属时它本身已在场内，不参与自身冲突比对
    const borrowedHere = !!activeBorrowInto({ ...s, placements, borrows }, riddleId, sessionId);
    // 用当前 placements 快照判断场内谜面（已分配进来的同样参与去重）
    const snapshot: Schedule = { ...s, placements, borrows };
    const conflict = borrowedHere ? null : exactConflict(snapshot, sessionId, riddle, riddles);
    if (conflict) {
      skipped.push({ riddleId, reason: 'duplicate', conflictNo: conflict.no });
      continue;
    }
    // 目标场次正借入该条 → 借用结束（转为归属）
    borrows = borrows.map((b) =>
      b.riddleId === riddleId && b.toSessionId === sessionId && b.status === 'active'
        ? { ...b, status: 'returned' as const, returnedAt: nowTs() }
        : b,
    );
    // 归属转移：原归属场次把该条借往别处的有效借用一并收回
    if (existing && existing.ownerSessionId !== sessionId) {
      borrows = borrows.map((b) =>
        b.riddleId === riddleId && b.fromSessionId === existing.ownerSessionId && b.status === 'active'
          ? { ...b, status: 'returned' as const, returnedAt: nowTs() }
          : b,
      );
      placements = placements.map((p) => (p.riddleId === riddleId ? { ...p, ownerSessionId: sessionId, boothId: undefined } : p));
    } else if (!existing) {
      placements.push({ riddleId, ownerSessionId: sessionId });
    } else {
      placements = placements.map((p) => (p.riddleId === riddleId ? { ...p, ownerSessionId: sessionId } : p));
    }
    assigned.push(riddleId);
  }
  return { schedule: { ...s, placements, borrows, updatedAt: nowTs() }, assigned, skipped };
}

/** 从场次移除（自有归属被清掉）；其在外的有效借用自动收回。不影响其它场次自有谜条。 */
export function unassignRiddles(s: Schedule, riddleIds: string[]): Schedule {
  const set = new Set(riddleIds);
  const placements = s.placements.filter((p) => !set.has(p.riddleId));
  const borrows = s.borrows.map((b) =>
    set.has(b.riddleId) && b.status === 'active'
      ? { ...b, status: 'returned' as const, returnedAt: nowTs() }
      : b,
  );
  return { ...s, placements, borrows, updatedAt: nowTs() };
}

/** 挂摊 / 换摊（仅对该场次在场的谜条） */
export function setBooth(s: Schedule, riddleId: string, sessionId: string, boothId: string | undefined): Schedule {
  const p = getPlacement(s, riddleId);
  let placements = s.placements;
  let borrows = s.borrows;
  if (p?.ownerSessionId === sessionId) {
    placements = placements.map((x) => (x.riddleId === riddleId ? { ...x, boothId } : x));
  } else if (activeBorrowInto(s, riddleId, sessionId)) {
    borrows = borrows.map((b) =>
      b.riddleId === riddleId && b.toSessionId === sessionId && b.status === 'active' ? { ...b, boothId } : b,
    );
  } else {
    return s; // 不在该场次，不动
  }
  return { ...s, placements, borrows, updatedAt: nowTs() };
}

// ---- 跨场借用 ----
export interface BorrowResult {
  schedule: Schedule;
  borrow?: Borrow;
  error?: 'no-owner' | 'self' | 'already' | 'duplicate';
  conflictNo?: number;
}

/** 跨场次借用：从归属场次借入，留下借用记录；同谜面硬拦截 */
export function borrowRiddle(
  s: Schedule,
  riddleId: string,
  toSessionId: string,
  riddles: Riddle[],
  opts: { boothId?: string; reason?: string } = {},
): BorrowResult {
  const from = ownerSessionOf(s, riddleId);
  if (!from) return { schedule: s, error: 'no-owner' };
  if (from === toSessionId) return { schedule: s, error: 'self' };
  if (activeBorrowInto(s, riddleId, toSessionId)) return { schedule: s, error: 'already' };
  const riddle = riddles.find((r) => r.id === riddleId);
  if (riddle) {
    const conflict = exactConflict(s, toSessionId, riddle, riddles);
    if (conflict) return { schedule: s, error: 'duplicate', conflictNo: conflict.no };
  }
  const borrow: Borrow = {
    id: scheduleUid('b'), riddleId, fromSessionId: from, toSessionId,
    boothId: opts.boothId, status: 'active', at: nowTs(), reason: opts.reason,
  };
  return { schedule: { ...s, borrows: [...s.borrows, borrow], updatedAt: nowTs() }, borrow };
}

/** 归还：借用记录保留并标记已归还，谜条从借用场次撤下 */
export function returnBorrow(s: Schedule, borrowId: string): Schedule {
  return {
    ...s,
    borrows: s.borrows.map((b) => (b.id === borrowId && b.status === 'active'
      ? { ...b, status: 'returned' as const, returnedAt: nowTs() }
      : b)),
    updatedAt: nowTs(),
  };
}

// ---- 场次 / 摊位增删改 ----
export function upsertSession(s: Schedule, session: Session): Schedule {
  const idx = s.sessions.findIndex((x) => x.id === session.id);
  const sessions = idx >= 0
    ? s.sessions.map((x) => (x.id === session.id ? session : x))
    : [...s.sessions, session];
  return { ...s, sessions, updatedAt: nowTs() };
}

/** 该场次是否还有在场谜条（用于删除前确认） */
export function sessionHasRiddles(s: Schedule, sessionId: string): boolean {
  return sessionRiddleIds(s, sessionId).length > 0;
}

/**
 * 删除场次：连带删除其摊位；其自有归属全部清除；
 * 与它相关的有效借用（借入/借出）全部标记归还。
 */
export function removeSession(s: Schedule, sessionId: string): Schedule {
  const sessions = s.sessions.filter((x) => x.id !== sessionId);
  const boothIds = new Set(s.booths.filter((b) => b.sessionId === sessionId).map((b) => b.id));
  const booths = s.booths.filter((b) => b.sessionId !== sessionId);
  const placements = s.placements
    .filter((p) => p.ownerSessionId !== sessionId)
    .map((p) => (p.boothId && boothIds.has(p.boothId) ? { ...p, boothId: undefined } : p));
  const borrows = s.borrows.map((b) =>
    (b.fromSessionId === sessionId || b.toSessionId === sessionId) && b.status === 'active'
      ? { ...b, status: 'returned' as const, returnedAt: nowTs() }
      : b,
  );
  return { ...s, sessions, booths, placements, borrows, updatedAt: nowTs() };
}

export function upsertBooth(s: Schedule, booth: Booth): Schedule {
  const idx = s.booths.findIndex((x) => x.id === booth.id);
  const booths = idx >= 0
    ? s.booths.map((x) => (x.id === booth.id ? booth : x))
    : [...s.booths, booth];
  return { ...s, booths, updatedAt: nowTs() };
}

/** 删除摊位：挂上的谜条变为未挂摊（归属不变） */
export function removeBooth(s: Schedule, boothId: string): Schedule {
  const booths = s.booths.filter((b) => b.id !== boothId);
  const placements = s.placements.map((p) => (p.boothId === boothId ? { ...p, boothId: undefined } : p));
  const borrows = s.borrows.map((b) => (b.boothId === boothId ? { ...b, boothId: undefined } : b));
  return { ...s, booths, placements, borrows, updatedAt: nowTs() };
}

/** 谜条被删除时清理编排（无归属残留、无悬挂借用） */
export function pruneRiddles(s: Schedule, riddleIds: string[]): Schedule {
  const set = new Set(riddleIds);
  return {
    ...s,
    placements: s.placements.filter((p) => !set.has(p.riddleId)),
    borrows: s.borrows.filter((b) => !set.has(b.riddleId)),
    updatedAt: nowTs(),
  };
}

// ---- 均衡分析 ----
export interface BoothCount { boothId: string; name: string; owner: string; count: number; }

export interface BalanceMove {
  riddleId: string;
  riddleNo: number;
  fromBoothId?: string;
  toBoothId: string;
}

export interface BalanceAnalysis {
  booths: BoothCount[];
  unplaced: number;
  total: number;
  min: number;
  max: number;
  balanced: boolean;
  suggestions: string[];
  moves: BalanceMove[];
}

/**
 * 场内摊位均衡：以「最多与最少相差 ≤ 1 且无未挂摊」为均衡。
 * moves 为一套可直接套用的调整方案（把多出的摊/未挂摊挪到最少的摊），只动挂摊不动归属。
 */
export function analyzeBalance(s: Schedule, sessionId: string, riddles: Riddle[]): BalanceAnalysis {
  const booths = sessionBooths(s, sessionId);
  const byId = new Map(riddles.map((r) => [r.id, r]));
  const presentIds = sessionRiddleIds(s, sessionId);
  const counts = new Map<string, number>(booths.map((b) => [b.id, 0]));
  const holders = new Map<string, string[]>(); // boothId -> 谜条
  const unplacedList: string[] = [];
  for (const id of presentIds) {
    const b = boothIdOf(s, id, sessionId);
    if (b && counts.has(b)) {
      counts.set(b, (counts.get(b) ?? 0) + 1);
      holders.set(b, [...(holders.get(b) ?? []), id]);
    } else {
      unplacedList.push(id);
    }
  }
  const boothCounts: BoothCount[] = booths.map((b) => ({
    boothId: b.id, name: b.name, owner: b.owner, count: counts.get(b.id) ?? 0,
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const total = presentIds.length;
  const vals = booths.length ? boothCounts.map((b) => b.count) : [0];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const suggestions: string[] = [];
  const moves: BalanceMove[] = [];

  if (!booths.length) {
    if (total) suggestions.push('该场次还没有摊位：先建摊位，再把谜条挂上去。');
    return { booths: boothCounts, unplaced: unplacedList.length, total, min: 0, max: 0, balanced: !total, suggestions, moves };
  }

  // 先把未挂摊塞进最少摊，再把超载摊的谜条挪到欠载摊（目标：max-min ≤ 1）
  const work = booths.map((b) => ({
    boothId: b.id,
    ids: [...(holders.get(b.id) ?? [])],
  }));
  const findMin = () => work.reduce((a, b) => (b.ids.length < a.ids.length ? b : a));
  const findMax = () => work.reduce((a, b) => (b.ids.length > a.ids.length ? b : a));

  for (const id of unplacedList) {
    const tgt = findMin();
    tgt.ids.push(id);
    moves.push({ riddleId: id, riddleNo: byId.get(id)?.no ?? 0, toBoothId: tgt.boothId });
  }
  // 每次取最多摊的最后一条挪到最少摊，直到相差 ≤ 1
  let guard = total + 1;
  while (guard-- > 0) {
    const hi = findMax(), lo = findMin();
    if (hi.boothId === lo.boothId || hi.ids.length - lo.ids.length <= 1) break;
    const id = hi.ids.pop()!;
    lo.ids.push(id);
    const r = byId.get(id);
    moves.push({ riddleId: id, riddleNo: r?.no ?? 0, fromBoothId: hi.boothId, toBoothId: lo.boothId });
  }

  if (unplacedList.length) {
    suggestions.push(`${unplacedList.length} 条谜条还没挂摊，建议先挂到条数最少的摊位。`);
  }
  if (max - min > 1) {
    const rich = boothCounts.filter((b) => b.count === max).map((b) => `「${b.name}」${b.count} 条`).join('、');
    const poor = boothCounts.filter((b) => b.count === min).map((b) => `「${b.name}」${b.count} 条`).join('、');
    suggestions.push(`摊位条数不均：${rich} 偏多，${poor} 偏少，建议向下表的调整方案挪动 ${moves.filter((m) => m.fromBoothId).length} 条。`);
  }
  const balanced = max - min <= 1 && unplacedList.length === 0;
  if (balanced) suggestions.push('各摊位条数均衡（相差不超过 1 条）。');
  return { booths: boothCounts, unplaced: unplacedList.length, total, min, max, balanced, suggestions, moves };
}

/** 套用均衡方案（只改挂摊） */
export function applyMoves(s: Schedule, sessionId: string, moves: BalanceMove[]): Schedule {
  let next = s;
  for (const m of moves) next = setBooth(next, m.riddleId, sessionId, m.toBoothId);
  return next;
}

// ---- 全场总览（跨场次均衡） ----
export interface SessionStat {
  session: Session;
  total: number;       // 在场（自有+借入）
  owned: number;
  borrowedIn: number;
  lentOut: number;     // 有效借出
  unplaced: number;
}

export interface ScheduleOverview {
  stats: SessionStat[];
  totalAssigned: number;
  totalUnowned: number;
  suggestions: string[];
}

export function overview(s: Schedule, riddles: Riddle[]): ScheduleOverview {
  const stats: SessionStat[] = s.sessions.map((session) => {
    const owned = s.placements.filter((p) => p.ownerSessionId === session.id).length;
    const borrowedIn = s.borrows.filter((b) => b.toSessionId === session.id && b.status === 'active').length;
    const lentOut = s.borrows.filter((b) => b.fromSessionId === session.id && b.status === 'active').length;
    const unplaced = unplacedRiddleIds(s, session.id).length;
    return { session, total: owned + borrowedIn, owned, borrowedIn, lentOut, unplaced };
  });
  const totalAssigned = new Set(s.placements.map((p) => p.riddleId)).size;
  const totalUnowned = riddles.length - totalAssigned;
  const suggestions: string[] = [];
  const totals = stats.map((x) => x.total);
  if (stats.length >= 2) {
    const mx = Math.max(...totals), mn = Math.min(...totals);
    if (mx - mn >= Math.max(3, Math.ceil(mx * 0.25))) {
      const big = stats.find((x) => x.total === mx)!;
      const small = stats.find((x) => x.total === mn)!;
      suggestions.push(`场次间条数相差较大：「${big.session.name}」${mx} 条、「${small.session.name}」${mn} 条，可把谜条改挂到偏少的场次，或办理跨场借用。`);
    }
  }
  for (const st of stats) {
    if (st.unplaced > 0) suggestions.push(`「${st.session.name}」有 ${st.unplaced} 条在场谜条未挂摊。`);
  }
  if (totalUnowned > 0) suggestions.push(`还有 ${totalUnowned} 条谜条未分到任何场次。`);
  return { stats, totalAssigned, totalUnowned, suggestions };
}

// ---- 按谜目/难度/标签筛选待分配池（供分批分场 UI 使用） ----
export type AssignFilter = {
  category?: Riddle['category'];
  difficulty?: 1 | 2 | 3;
  tag?: string;
};

/** 候选池：谜库中尚未归属到任何场次的谜条（已归属的不在池里，避免误分） */
export function unassignedPool(s: Schedule, riddles: Riddle[], f: AssignFilter = {}): Riddle[] {
  const owned = new Set(s.placements.map((p) => p.riddleId));
  return riddles.filter((r) => {
    if (owned.has(r.id)) return false;
    if (f.category && r.category !== f.category) return false;
    if (f.difficulty && r.difficulty !== f.difficulty) return false;
    if (f.tag && !r.tags.includes(f.tag)) return false;
    return true;
  });
}

/** 把一批谜条按「条数最少优先」自动挂到摊位（不区分谜目，纯均衡） */
export function autoDistributeBooths(s: Schedule, sessionId: string, riddleIds: string[]): Schedule {
  const booths = sessionBooths(s, sessionId);
  if (!booths.length) return s;
  const loads = new Map<string, number>(booths.map((b) => [b.id, boothRiddleIds(s, b.id).length]));
  let next = s;
  // 稳定排序保证结果可预测
  const order = [...booths].sort((a, b) => a.name.localeCompare(b.name));
  for (const id of riddleIds) {
    let pick = order[0];
    for (const b of order) if ((loads.get(b.id) ?? 0) < (loads.get(pick.id) ?? 0)) pick = b;
    next = setBooth(next, id, sessionId, pick.id);
    loads.set(pick.id, (loads.get(pick.id) ?? 0) + 1);
  }
  return next;
}

// ---- 导出 CSV ----
export const SCHEDULE_HEADERS = ['场次', '开始', '结束', '摊位', '摊位负责人', '谜号', '谜面', '谜底', '谜目', '难度', '标签', '在场方式', '归属场次'];
export const BORROW_HEADERS = ['谜号', '谜面', '出借场次', '借用场次', '借用摊位', '状态', '借出时间', '归还时间', '事由'];

function timeLabel(s: Schedule, id: string): string {
  return s.sessions.find((x) => x.id === id)?.name ?? '(已删除场次)';
}

/** 清单行：每个场次 × 每条在场谜条一行 */
export function scheduleListRows(s: Schedule, riddles: Riddle[]): (string | number)[][] {
  const byId = new Map(riddles.map((r) => [r.id, r]));
  const rows: (string | number)[][] = [];
  for (const session of s.sessions) {
    const booths = sessionBooths(s, session.id);
    const order = new Map<string, number>();
    booths.forEach((b, i) => order.set(b.id, i));
    const ids = sessionRiddleIds(s, session.id);
    const enriched = ids.map((id) => {
      const b = boothIdOf(s, id, session.id);
      return { id, b, order: b ? (order.get(b) ?? 999) : 998 };
    }).sort((a, b) => a.order - b.order || (byId.get(a.id)?.no ?? 0) - (byId.get(b.id)?.no ?? 0));
    for (const { id, b } of enriched) {
      const r = byId.get(id);
      if (!r) continue;
      const booth = booths.find((x) => x.id === b);
      const borrowed = isBorrowedIn(s, id, session.id);
      rows.push([
        session.name, session.start, session.end,
        booth?.name ?? '未挂摊', booth?.owner ?? '',
        r.no, r.surface, r.answer, CATEGORY_LABEL[r.category], r.difficulty, r.tags.join('、'),
        borrowed ? '借用' : '自有',
        borrowed ? timeLabel(s, ownerSessionOf(s, id) ?? '') : session.name,
      ]);
    }
  }
  return rows;
}

export function borrowRows(s: Schedule, riddles: Riddle[]): (string | number)[][] {
  const byId = new Map(riddles.map((r) => [r.id, r]));
  const fmt = (ts?: number) => (ts ? new Date(ts).toLocaleString('zh-CN') : '');
  return [...s.borrows]
    .sort((a, b) => b.at - a.at)
    .map((b) => {
      const r = byId.get(b.riddleId);
      return [
        r?.no ?? '', r?.surface ?? '',
        timeLabel(s, b.fromSessionId), timeLabel(s, b.toSessionId),
        boothName(s, b.boothId),
        b.status === 'active' ? '借用中' : '已归还',
        fmt(b.at), fmt(b.returnedAt), b.reason ?? '',
      ];
    });
}
