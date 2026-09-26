// 分场编排领域逻辑测试：归属唯一 / 场内查重 / 跨场借用留痕 / 均衡 / 导出
import { describe, it, expect } from 'vitest';
import { EMPTY_SCHEDULE, type Riddle, type Schedule } from '../src/types';
import {
  scheduleUid, upsertSession, upsertBooth, assignRiddles, unassignRiddles, setBooth,
  borrowRiddle, returnBorrow, removeSession, removeBooth, pruneRiddles,
  sessionRiddleIds, boothRiddleIds, ownerSessionOf, isBorrowedIn,
  findSessionDupIssues, exactConflict, analyzeBalance, overview, unassignedPool,
  scheduleListRows, borrowRows, sessionHasRiddles, autoDistributeBooths,
} from '../src/lib/schedule';

let seq = 0;
function mk(surface: string, opts: { category?: Riddle['category']; difficulty?: 1 | 2 | 3; tags?: string[]; answer?: string } = {}): Riddle {
  seq += 1;
  return {
    id: `r${seq}`, no: seq, surface, answer: opts.answer ?? `答${seq}`,
    category: opts.category ?? 'char', format: 'none',
    difficulty: opts.difficulty ?? 2, tags: opts.tags ?? [],
    check: { verdict: 'pass', reasons: [], checkedAt: 0 },
  };
}

function seedSession(s: Schedule, name: string) {
  const id = scheduleUid('sess');
  return { s: upsertSession(s, { id, name, start: '', end: '' }), id };
}
function seedBooth(s: Schedule, sessionId: string, name: string, owner = '') {
  const id = scheduleUid('booth');
  return { s: upsertBooth(s, { id, sessionId, name, owner }), id };
}

describe('场次与摊位', () => {
  it('新建/更新场次', () => {
    let s = upsertSession(EMPTY_SCHEDULE, { id: 'a', name: '下午场', start: '14:00', end: '16:00' });
    expect(s.sessions).toHaveLength(1);
    s = upsertSession(s, { id: 'a', name: '午后场', start: '14:30', end: '16:30' });
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0].name).toBe('午后场');
    expect(s.updatedAt).toBeGreaterThan(0);
  });

  it('删除摊位后挂摊谜条变为未挂摊但归属保留', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedBooth(s, a.id, '摊1'); s = b.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    s = setBooth(s, r.id, a.id, b.id);
    expect(boothRiddleIds(s, b.id)).toContain(r.id);
    s = removeBooth(s, b.id);
    expect(boothRiddleIds(s, b.id)).toEqual([]);
    expect(ownerSessionOf(s, r.id)).toBe(a.id); // 归属仍在
  });

  it('删除场次清理摊位与归属，相关借用标记归还', () => {
    let s = EMPTY_SCHEDULE;
    const x = seedSession(s, 'X'); s = x.s;
    const y = seedSession(s, 'Y'); s = y.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], x.id, [r]).schedule;
    s = borrowRiddle(s, r.id, y.id, [r]).schedule;
    expect(sessionHasRiddles(s, y.id)).toBe(true);
    s = removeSession(s, y.id);
    expect(s.booths.filter((bb) => bb.sessionId === y.id)).toHaveLength(0);
    expect(sessionRiddleIds(s, y.id)).toEqual([]);
    expect(s.borrows[0].status).toBe('returned'); // 记录保留
  });
});

describe('分批分场：每条谜条只属于一个场次', () => {
  it('分入即设为归属', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const r = mk('面1');
    const res = assignRiddles(s, [r.id], a.id, [r]);
    s = res.schedule;
    expect(res.assigned).toEqual([r.id]);
    expect(ownerSessionOf(s, r.id)).toBe(a.id);
    expect(sessionRiddleIds(s, a.id)).toEqual([r.id]);
  });

  it('重复分入同场跳过（already）', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    const res2 = assignRiddles(s, [r.id], a.id, [r]);
    expect(res2.assigned).toHaveLength(0);
    expect(res2.skipped[0].reason).toBe('already');
  });

  it('转移归属：从一场转到另一场，原场不再含此条', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    s = assignRiddles(s, [r.id], b.id, [r]).schedule;
    expect(ownerSessionOf(s, r.id)).toBe(b.id);
    expect(sessionRiddleIds(s, a.id)).toEqual([]);
    expect(sessionRiddleIds(s, b.id)).toEqual([r.id]);
    // placements 中仍只有一条归属
    expect(s.placements.filter((p) => p.riddleId === r.id)).toHaveLength(1);
  });

  it('移出后谜条无归属但其它场不受影响', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r1 = mk('面1'); const r2 = mk('面2');
    s = assignRiddles(s, [r1.id], a.id, [r1, r2]).schedule;
    s = assignRiddles(s, [r2.id], b.id, [r1, r2]).schedule;
    s = unassignRiddles(s, [r1.id]);
    expect(ownerSessionOf(s, r1.id)).toBeUndefined();
    expect(sessionRiddleIds(s, b.id)).toEqual([r2.id]); // B 场未受影响
  });

  it('谜目/难度/标签筛选待分配池', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const r1 = mk('字1', { category: 'char', difficulty: 1, tags: ['儿童'] });
    const r2 = mk('成语1', { category: 'idiom', difficulty: 3, tags: ['成人'] });
    const r3 = mk('字2', { category: 'char', difficulty: 3 });
    const all = [r1, r2, r3];
    s = assignRiddles(s, [r1.id], a.id, all).schedule;
    expect(unassignedPool(s, all, { category: 'char' }).map((x) => x.id)).toEqual([r3.id]);
    expect(unassignedPool(s, all, { difficulty: 3 }).map((x) => x.id).sort()).toEqual([r2.id, r3.id].sort());
    expect(unassignedPool(s, all, { tag: '成人' }).map((x) => x.id)).toEqual([r2.id]);
  });
});

describe('同一时段内不出现重复谜面', () => {
  it('归一化完全相同（标点差异）硬性拦截', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const r1 = mk('快刀斩乱麻');
    const r2 = mk('快刀、斩乱麻！');
    s = assignRiddles(s, [r1.id], a.id, [r1, r2]).schedule;
    const res = assignRiddles(s, [r2.id], a.id, [r1, r2]);
    expect(res.assigned).toHaveLength(0);
    expect(res.skipped[0].reason).toBe('duplicate');
    expect(res.skipped[0].conflictNo).toBe(r1.no);
  });

  it('exactConflict 能找到归一化相同的在场谜条', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const r1 = mk('一口咬掉牛尾巴');
    s = assignRiddles(s, [r1.id], a.id, [r1]).schedule;
    const r2 = { ...mk('一口咬掉牛尾巴。'), id: 'other' };
    expect(exactConflict(s, a.id, r2, [r1, r2])?.id).toBe(r1.id);
  });

  it('不同场次可挂相同谜面（规则只约束同一时段）', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r1 = mk('谜面相同', undefined);
    const r2 = mk('谜面相同', undefined);
    s = assignRiddles(s, [r1.id], a.id, [r1, r2]).schedule;
    const res = assignRiddles(s, [r2.id], b.id, [r1, r2]);
    expect(res.assigned).toEqual([r2.id]);
  });

  it('findSessionDupIssues 识别完全相同与高相似', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const r1 = mk('一口咬掉牛尾巴');
    const r2 = mk('一口咬掉牛尾巴。');
    const r3 = mk('一口咬掉牛尾巴了');
    s = assignRiddles(s, [r1.id, r3.id], a.id, [r1, r2, r3]).schedule;
    // 手工把 r2 也塞进同场（绕过 assign 硬拦截，模拟借入/存量数据）
    s = { ...s, placements: [...s.placements, { riddleId: r2.id, ownerSessionId: a.id }] };
    const issues = findSessionDupIssues(s, a.id, [r1, r2, r3]);
    expect(issues.some((i) => i.kind === 'exact')).toBe(true);
    expect(issues.some((i) => i.kind === 'similar')).toBe(true);
  });

  it('同谜面但不同谜目不报相似（仅全等仍报 exact）', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const r1 = mk('风平浪静', { category: 'idiom' });
    const r2 = mk('风平浪静打一城市再说', { category: 'place' });
    s = assignRiddles(s, [r1.id], a.id, [r1, r2]).schedule;
    const issues = findSessionDupIssues({ ...s,
      placements: [...s.placements, { riddleId: r2.id, ownerSessionId: a.id }] }, a.id, [r1, r2]);
    expect(issues).toHaveLength(0);
  });
});

describe('跨场借用：留借用记录、可归还', () => {
  it('借入生成 active 记录，归属不变', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    const res = borrowRiddle(s, r.id, b.id, [r], { reason: '补位' });
    expect(res.error).toBeUndefined();
    s = res.schedule;
    expect(ownerSessionOf(s, r.id)).toBe(a.id);
    expect(isBorrowedIn(s, r.id, b.id)).toBe(true);
    expect(sessionRiddleIds(s, b.id)).toContain(r.id);
    expect(s.borrows[0].reason).toBe('补位');
    expect(s.borrows[0].status).toBe('active');
  });

  it('无归属不能借、自己借自己不行、重复借不行', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r = mk('面1');
    expect(borrowRiddle(s, r.id, b.id, [r]).error).toBe('no-owner');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    expect(borrowRiddle(s, r.id, a.id, [r]).error).toBe('self');
    s = borrowRiddle(s, r.id, b.id, [r]).schedule;
    expect(borrowRiddle(s, r.id, b.id, [r]).error).toBe('already');
  });

  it('借入遇场内同谜面拦截', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r1 = mk('同谜面');
    const r2 = mk('同谜面');
    s = assignRiddles(s, [r1.id], a.id, [r1, r2]).schedule;
    s = assignRiddles(s, [r2.id], b.id, [r1, r2]).schedule;
    expect(borrowRiddle(s, r1.id, b.id, [r1, r2]).error).toBe('duplicate');
  });

  it('归还后记录保留为 returned，谜条从借用场撤下', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    s = borrowRiddle(s, r.id, b.id, [r]).schedule;
    const bid = s.borrows[0].id;
    s = returnBorrow(s, bid);
    expect(s.borrows[0].status).toBe('returned');
    expect(s.borrows[0].returnedAt).toBeGreaterThan(0);
    expect(sessionRiddleIds(s, b.id)).not.toContain(r.id);
    expect(sessionRiddleIds(s, a.id)).toContain(r.id);
  });

  it('归属转移到正借入的场次，借用记录转为已归还', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    s = borrowRiddle(s, r.id, b.id, [r]).schedule;
    s = assignRiddles(s, [r.id], b.id, [r]).schedule;
    expect(ownerSessionOf(s, r.id)).toBe(b.id);
    expect(s.borrows.every((x) => x.status === 'returned')).toBe(true);
  });

  it('删除谜条清理归属与借用（pruneRiddles）', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    s = borrowRiddle(s, r.id, b.id, [r]).schedule;
    s = pruneRiddles(s, [r.id]);
    expect(s.placements).toHaveLength(0);
    expect(s.borrows).toHaveLength(0);
  });
});

describe('摊位均衡与调整建议', () => {
  it('未挂摊 + 摊位数不均：给出挪动方案，套用后 max-min ≤ 1', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b1 = seedBooth(s, a.id, '摊一'); s = b1.s;
    const b2 = seedBooth(s, a.id, '摊二'); s = b2.s;
    const rs = [mk('1'), mk('2'), mk('3'), mk('4'), mk('5')];
    s = assignRiddles(s, rs.map((r) => r.id), a.id, rs).schedule;
    s = setBooth(s, rs[0].id, a.id, b1.id);
    s = setBooth(s, rs[1].id, a.id, b1.id);
    s = setBooth(s, rs[2].id, a.id, b1.id);
    s = setBooth(s, rs[3].id, a.id, b1.id);
    // rs[4] 未挂摊 → 摊一 4 条、摊二 0 条、未挂摊 1
    const ana = analyzeBalance(s, a.id, rs);
    expect(ana.max - ana.min).toBe(4);
    expect(ana.unplaced).toBe(1);
    expect(ana.balanced).toBe(false);
    expect(ana.suggestions.some((t) => t.includes('不均'))).toBe(true);
    // 套用方案后均衡
    const fixed = ana.moves.reduce((acc, m) => setBooth(acc, m.riddleId, a.id, m.toBoothId), s);
    const ana2 = analyzeBalance(fixed, a.id, rs);
    expect(ana2.max - ana2.min).toBeLessThanOrEqual(1);
    expect(ana2.unplaced).toBe(0);
    expect(ana2.balanced).toBe(true);
  });

  it('已经均衡时不产生 moves', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b1 = seedBooth(s, a.id, '摊一'); s = b1.s;
    const b2 = seedBooth(s, a.id, '摊二'); s = b2.s;
    const rs = [mk('1'), mk('2')];
    s = assignRiddles(s, rs.map((r) => r.id), a.id, rs).schedule;
    s = autoDistributeBooths(s, a.id, rs.map((r) => r.id));
    const ana = analyzeBalance(s, a.id, rs);
    expect(ana.moves).toHaveLength(0);
    expect(ana.balanced).toBe(true);
  });

  it('autoDistributeBooths 把一批谜条按最少优先挂摊', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b1 = seedBooth(s, a.id, '摊一'); s = b1.s;
    const b2 = seedBooth(s, a.id, '摊二'); s = b2.s;
    const b3 = seedBooth(s, a.id, '摊三'); s = b3.s;
    const rs = [mk('1'), mk('2'), mk('3'), mk('4'), mk('5'), mk('6')];
    s = assignRiddles(s, rs.map((r) => r.id), a.id, rs).schedule;
    s = autoDistributeBooths(s, a.id, rs.map((r) => r.id));
    const counts = [b1.id, b2.id, b3.id].map((id) => boothRiddleIds(s, id).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(6);
  });

  it('没有摊位时给建摊提示', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const rs = [mk('1')];
    s = assignRiddles(s, [rs[0].id], a.id, rs).schedule;
    const ana = analyzeBalance(s, a.id, rs);
    expect(ana.suggestions[0]).toContain('还没有摊位');
  });
});

describe('全场总览与跨场建议', () => {
  it('统计自有/借入/借出/未挂摊并提示场次不均', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const rs = Array.from({ length: 8 }, (_, i) => mk(`面${i}`));
    s = assignRiddles(s, rs.slice(0, 7).map((r) => r.id), a.id, rs).schedule;
    s = assignRiddles(s, [rs[7].id], b.id, rs).schedule;
    s = borrowRiddle(s, rs[0].id, b.id, rs).schedule;
    const ov = overview(s, rs);
    const sa = ov.stats.find((x) => x.session.id === a.id)!;
    const sb = ov.stats.find((x) => x.session.id === b.id)!;
    expect(sa.owned).toBe(7);
    expect(sa.lentOut).toBe(1);
    expect(sb.borrowedIn).toBe(1);
    expect(sb.total).toBe(2);
    expect(ov.totalAssigned).toBe(8);
    expect(ov.suggestions.some((t) => t.includes('场次间条数相差较大'))).toBe(true);
  });

  it('提示未分场的谜条', () => {
    const s = EMPTY_SCHEDULE;
    const rs = [mk('游离')];
    const ov = overview(s, rs);
    expect(ov.totalUnowned).toBe(1);
    expect(ov.suggestions.some((t) => t.includes('未分到任何场次'))).toBe(true);
  });
});

describe('清单导出', () => {
  it('scheduleListRows 每场次每摊一行并标注借用/归属', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, '下午场'); s = a.s;
    const b = seedSession(s, '晚场'); s = b.s;
    const booth = seedBooth(s, a.id, '字谜摊', '张三'); s = booth.s;
    const r1 = mk('自有面');
    const r2 = mk('借用来的面');
    s = assignRiddles(s, [r1.id, r2.id], a.id, [r1, r2]).schedule;
    s = setBooth(s, r1.id, a.id, booth.id);
    s = borrowRiddle(s, r2.id, b.id, [r1, r2], { boothId: undefined }).schedule;
    // r2 已被借入晚场；它在下午场仍是自有
    const rows = scheduleListRows(s, [r1, r2]);
    const afternoon = rows.filter((r) => r[0] === '下午场');
    const evening = rows.filter((r) => r[0] === '晚场');
    expect(afternoon).toHaveLength(2);
    expect(afternoon.find((r) => r[5] === r1.no)![3]).toBe('字谜摊');
    expect(afternoon.find((r) => r[5] === r1.no)![11]).toBe('自有');
    expect(evening).toHaveLength(1);
    expect(evening[0][11]).toBe('借用');
    expect(evening[0][12]).toBe('下午场');
  });

  it('borrowRows 含借用中/已归还状态', () => {
    let s = EMPTY_SCHEDULE;
    const a = seedSession(s, 'A'); s = a.s;
    const b = seedSession(s, 'B'); s = b.s;
    const r = mk('面1');
    s = assignRiddles(s, [r.id], a.id, [r]).schedule;
    s = borrowRiddle(s, r.id, b.id, [r]).schedule;
    s = returnBorrow(s, s.borrows[0].id);
    const rows = borrowRows(s, [r]);
    expect(rows).toHaveLength(1);
    expect(rows[0][5]).toBe('已归还');
    expect(rows[0][2]).toBe('A');
    expect(rows[0][3]).toBe('B');
  });
});
