// 分场编排逻辑测试：归属唯一性、同时段查重、借还计数、均衡分析、自动分批、CSV 导出
import { describe, it, expect } from 'vitest';
import {
  analyzeBalance, borrowLedgerToCSV, buildScheduleView, clashWith, findClashes,
  planBatch, scheduleToCSV, sessionList,
  type BatchCriteria, EMPTY_CRITERIA,
} from '../src/lib/schedule';
import type { Assignment, Booth, BorrowRecord, Riddle, Session } from '../src/types';

function r(id: string, no: number, surface: string, category: Riddle['category'] = 'char', difficulty: 1 | 2 | 3 = 2, tags: string[] = []): Riddle {
  return {
    id, no, surface, answer: `答${no}`, category, format: 'none',
    difficulty, tags, check: { verdict: 'pass', reasons: [], checkedAt: 0 },
  };
}

const riddles: Riddle[] = [
  r('r1', 1, '一口咬掉牛尾巴'),
  r('r2', 2, '两人土上蹲', 'char', 1, ['儿童专区']),
  r('r3', 3, '十个哥哥'),
  r('r4', 4, '千里相逢', 'char', 1, ['儿童专区']),
  r('r5', 5, '一块变九块', 'idiom', 3),
  r('r6', 6, '快刀斩乱麻', 'idiom', 1),
  r('r7', 7, '风平浪静', 'place'),
  r('r8', 8, '双喜临门', 'place'),
];

const sessions: Session[] = [
  { id: 's1', name: '午场', start: '13:00', end: '15:00', order: 0 },
  { id: 's2', name: '晚场', start: '18:30', end: '20:30', order: 1 },
];
const booths: Booth[] = [
  { id: 'b1', name: 'A字谜摊', owner: '张三', order: 0 },
  { id: 'b2', name: 'B成语摊', owner: '李四', order: 1 },
];

function assign(entries: [string, string, string?][]): Assignment[] {
  return entries.map(([rid, sid, bid]) => ({ id: rid, riddleId: rid, sessionId: sid, boothId: bid ?? '', at: 0 }));
}
function borrow(rid: string, from: string, to: string, booth = '', returned = false, at = 1000): BorrowRecord {
  return {
    id: `br-${rid}-${to}`, riddleId: rid, fromSessionId: from, toSessionId: to,
    boothId: booth, at, ...(returned ? { returnedAt: at + 1 } : {}),
  };
}

describe('buildScheduleView：归属/借还计数', () => {
  it('无借用：归属条数 = 实挂条数，按摊位拆分', () => {
    const a = assign([['r1', 's1', 'b1'], ['r2', 's1', 'b1'], ['r3', 's1', 'b2'], ['r5', 's2', 'b2']]);
    const view = buildScheduleView(riddles, sessions, booths, a, []);
    const [noon, night] = view.bySession;
    expect(noon.owned).toBe(3);
    expect(noon.borrowedIn).toBe(0);
    expect(noon.borrowedOut).toBe(0);
    expect(noon.total).toBe(3);
    expect(noon.booths.find((x) => x.booth?.id === 'b1')?.count).toBe(2);
    expect(noon.booths.find((x) => x.booth?.id === 'b2')?.count).toBe(1);
    expect(night.total).toBe(1);
    expect(view.unassigned.map((x) => x.id).sort()).toEqual(['r4', 'r6', 'r7', 'r8']);
  });

  it('借用中：借入方 +1；借出方清单保留并标记借出，实挂计数扣除借出；全场合计不重复', () => {
    // r1 归属午场 b1，借给晚场 b2
    const a = assign([['r1', 's1', 'b1'], ['r2', 's1', 'b1'], ['r5', 's2', 'b2']]);
    const br = [borrow('r1', 's1', 's2', 'b2')];
    const view = buildScheduleView(riddles, sessions, booths, a, br);
    const [noon, night] = view.bySession;
    expect(noon.owned).toBe(2);
    expect(noon.borrowedOut).toBe(1);
    expect(noon.total).toBe(1);
    expect(night.owned).toBe(1);
    expect(night.borrowedIn).toBe(1);
    expect(night.total).toBe(2);
    // 借入计入晚场 b2
    expect(night.booths.find((x) => x.booth?.id === 'b2')?.borrowedIn).toBe(1);
    // 物理谜条仍在归属场午场（清单可见，状态为借出）
    const noonLists = sessionList('s1', riddles, sessions, booths, a, br);
    const noonR1 = noonLists.flatMap((g) => g.items).find((it) => it.riddle.id === 'r1');
    expect(noonR1?.status).toBe('lentOut');
    // 全局实挂总数 = 归属总数（谜条没有被复制）
    const hanging = view.bySession.reduce((sum, s) => sum + s.total, 0);
    expect(hanging).toBe(3);
    expect(view.activeBorrows).toHaveLength(1);
  });

  it('已归还的借用不影响计数', () => {
    const a = assign([['r1', 's1', 'b1']]);
    const br = [borrow('r1', 's1', 's2', 'b2', true)];
    const view = buildScheduleView(riddles, sessions, booths, a, br);
    expect(view.bySession[0].total).toBe(1);
    expect(view.bySession[1].total).toBe(0);
    expect(view.activeBorrows).toHaveLength(0);
  });

  it('同一谜条对同一场存在历史+新借用记录时只计一次（取最新）', () => {
    const a = assign([['r1', 's1', 'b1']]);
    const br = [
      borrow('r1', 's1', 's2', 'b2', true, 1000),
      borrow('r1', 's1', 's2', 'b1', false, 2000),
    ];
    const view = buildScheduleView(riddles, sessions, booths, a, br);
    expect(view.bySession[1].borrowedIn).toBe(1);
    // 最新记录挂 b1
    expect(view.bySession[1].booths.find((x) => x.booth?.id === 'b1')?.borrowedIn).toBe(1);
    expect(view.bySession[1].booths.find((x) => x.booth?.id === 'b2')?.borrowedIn).toBeUndefined();
  });
});

describe('sessionList：场次清单', () => {
  it('按摊位分组且按谜号排序，借入带来源场次', () => {
    const a = assign([['r3', 's1', 'b1'], ['r1', 's1', 'b1'], ['r5', 's1', 'b2']]);
    const br = [borrow('r7', 's2', 's1', 'b1')];
    const groups = sessionList('s1', riddles, sessions, booths, a, br);
    const g1 = groups.find((g) => g.booth?.id === 'b1')!;
    expect(g1.items.map((x) => x.riddle.no)).toEqual([1, 3, 7]);
    expect(g1.items.find((x) => x.riddle.id === 'r7')?.status).toBe('borrowedIn');
    expect(g1.items.find((x) => x.riddle.id === 'r7')?.otherSession?.id).toBe('s2');
    expect(g1.items.find((x) => x.riddle.id === 'r1')?.status).toBe('own');
  });

  it('借出的谜条在借出方保留（标记借出），同时出现在借入方（标记借入）', () => {
    const a = assign([['r1', 's1', 'b1'], ['r5', 's2', 'b2']]);
    const br = [borrow('r1', 's1', 's2', 'b2')];
    const noon = sessionList('s1', riddles, sessions, booths, a, br);
    const night = sessionList('s2', riddles, sessions, booths, a, br);
    const noonR1 = noon.flatMap((g) => g.items).find((it) => it.riddle.id === 'r1');
    expect(noonR1?.status).toBe('lentOut');
    expect(noonR1?.otherSession?.id).toBe('s2');
    const nightIds = night.flatMap((g) => g.items.map((it) => it.riddle.id));
    expect(nightIds).toContain('r1');
    expect(nightIds).toContain('r5');
    const nightR1 = night.flatMap((g) => g.items).find((it) => it.riddle.id === 'r1');
    expect(nightR1?.status).toBe('borrowedIn');
  });

  it('未指定摊位的谜条归入 null 组', () => {
    const a = assign([['r1', 's1']]);
    const groups = sessionList('s1', riddles, sessions, booths, a, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].booth).toBeNull();
  });
});

describe('同时段谜面查重', () => {
  it('不同场次出现相同谜面：不算撞面（跨场允许）', () => {
    const a = assign([['r1', 's1', 'b1'], ['r2', 's2', 'b1']]);
    // 造两条相同谜面，分别归属不同场次
    const rs = [r('rx', 99, '一口咬掉牛尾巴'), ...riddles];
    const a2 = [...a, { id: 'rx', riddleId: 'rx', sessionId: 's2', boothId: 'b1', at: 0 }];
    const clashes = findClashes(rs, sessions, booths, a2, []);
    expect(clashes).toHaveLength(0);
  });

  it('同一场次两个不同谜条谜面相同：报撞面', () => {
    const dup = r('rx', 99, '一口咬掉牛尾巴！'); // 标点不同，归一化后相同
    const a = assign([['r1', 's1', 'b1'], ['rx', 's1', 'b2']]);
    const clashes = findClashes([...riddles, dup], sessions, booths, a, []);
    expect(clashes).toHaveLength(1);
    expect(clashes[0].items.map((i) => i.riddle.id).sort()).toEqual(['r1', 'rx']);
  });

  it('借入导致的同场重复：报撞面', () => {
    const dup = r('rx', 99, '一口咬掉牛尾巴');
    // rx 归属晚场，午场已有 r1（同谜面），晚场把 rx 借给午场
    const a = assign([['r1', 's1', 'b1'], ['rx', 's2', 'b1']]);
    const br = [borrow('rx', 's2', 's1', 'b2')];
    const clashes = findClashes([...riddles, dup], sessions, booths, a, br);
    expect(clashes).toHaveLength(1);
    const inNoon = clashes[0].items.filter((i) => i.session.id === 's1');
    expect(inNoon.map((i) => i.riddle.id).sort()).toEqual(['r1', 'rx']);
  });

  it('同一谜条异常借入自己的归属场（store 层会拦，纯函数不重复列）', () => {
    const a = assign([['r1', 's1', 'b1']]);
    const br: BorrowRecord[] = [{ id: 'x', riddleId: 'r1', fromSessionId: 's1', toSessionId: 's1', boothId: 'b2', at: 1 }];
    const lists = sessionList('s1', riddles, sessions, booths, a, br);
    const items = lists.flatMap((g) => g.items);
    expect(items.filter((it) => it.riddle.id === 'r1')).toHaveLength(1);
    const clashes = findClashes(riddles, sessions, booths, a, br);
    expect(clashes).toHaveLength(0);
  });

  it('clashWith：放入前预检返回同场相同谜面', () => {
    const dup = r('rx', 99, '一口咬掉牛尾巴');
    const a = assign([['r1', 's1', 'b1']]);
    const dups = clashWith(dup, 's1', [...riddles, dup], sessions, booths, a, []);
    expect(dups.map((d) => d.id)).toEqual(['r1']);
    expect(clashWith(dup, 's2', [...riddles, dup], sessions, booths, a, [])).toHaveLength(0);
  });
});

describe('analyzeBalance：均衡分析与建议', () => {
  it('条数接近判均衡', () => {
    const a = assign([
      ['r1', 's1'], ['r2', 's1'], ['r3', 's1'],
      ['r4', 's2'], ['r5', 's2'],
    ]);
    const balance = analyzeBalance(buildScheduleView(riddles, sessions, booths, a, []));
    expect(balance.balanced).toBe(true);
    expect(balance.messages.some((m) => m.includes('基本均衡'))).toBe(true);
  });

  it('场次差距过大：不均衡并给出双向调整建议', () => {
    const a = assign([
      ['r1', 's1'], ['r2', 's1'], ['r3', 's1'], ['r4', 's1'], ['r5', 's1'], ['r6', 's1'],
      ['r7', 's2'],
    ]);
    const balance = analyzeBalance(buildScheduleView(riddles, sessions, booths, a, []));
    expect(balance.balanced).toBe(false);
    const msg = balance.messages.join();
    expect(msg).toContain('午场');
    expect(msg).toContain('晚场');
    expect(msg).toMatch(/调 \d+~\d+ 条/);
  });

  it('同一场内摊位不均：给出摊位调整建议', () => {
    const a = assign([
      ['r1', 's1', 'b1'], ['r2', 's1', 'b1'], ['r3', 's1', 'b1'],
      ['r4', 's1', 'b2'],
      ['r5', 's2', 'b1'], ['r6', 's2', 'b2'],
    ]);
    const balance = analyzeBalance(buildScheduleView(riddles, sessions, booths, a, []));
    expect(balance.balanced).toBe(false);
    expect(balance.messages.some((m) => m.includes('摊位不均'))).toBe(true);
    expect(balance.boothAdvice.some((x) => x.session.id === 's1' && x.booth?.id === 'b1')).toBe(true);
  });

  it('空编排：提示未编排且判均衡（不误报）', () => {
    const balance = analyzeBalance(buildScheduleView(riddles, sessions, booths, [], []));
    expect(balance.balanced).toBe(true);
    expect(balance.messages.join()).toContain('尚未编排');
  });

  it('未编排谜条数写入建议', () => {
    const a = assign([['r1', 's1']]);
    const balance = analyzeBalance(buildScheduleView(riddles, sessions, booths, a, []));
    expect(balance.messages.join()).toContain('7 条谜未编排');
  });
});

describe('planBatch：自动分批', () => {
  const criteria: BatchCriteria = { ...EMPTY_CRITERIA };

  it('轮询分配到两场，差距不超过 1', () => {
    const plan = planBatch(riddles, sessions, booths, [], [], criteria);
    expect(plan).toHaveLength(8);
    const to1 = plan.filter((p) => p.sessionId === 's1').length;
    const to2 = plan.filter((p) => p.sessionId === 's2').length;
    expect(Math.abs(to1 - to2)).toBeLessThanOrEqual(1);
    expect(plan.every((p) => p.clashRiddles.length === 0)).toBe(true);
  });

  it('按谜目过滤：只分成语谜', () => {
    const plan = planBatch(riddles, sessions, booths, [], [], { ...criteria, categories: ['idiom'] });
    expect(plan.map((p) => p.riddle.category)).toEqual(['idiom', 'idiom']);
  });

  it('按难度 + 标签过滤', () => {
    const plan = planBatch(riddles, sessions, booths, [], [], { ...criteria, difficulties: [1], tags: ['儿童专区'] });
    expect(plan.map((p) => p.riddle.id).sort()).toEqual(['r2', 'r4']);
  });

  it('每场限额：超限不排入（sessionId 为空）', () => {
    const plan = planBatch(riddles, sessions, booths, [], [], { ...criteria, perSessionLimit: 3 });
    expect(plan.filter((p) => p.sessionId !== '').length).toBe(6);
    expect(plan.filter((p) => p.sessionId === '')).toHaveLength(2);
  });

  it('已分配的谜条默认跳过，取消 onlyUnassigned 后全部重排', () => {
    const a = assign([['r1', 's1', 'b1'], ['r2', 's1', 'b1']]);
    const skip = planBatch(riddles, sessions, booths, a, [], criteria);
    expect(skip.find((p) => p.riddle.id === 'r1')).toBeUndefined();
    const all = planBatch(riddles, sessions, booths, a, [], { ...criteria, onlyUnassigned: false });
    expect(all).toHaveLength(8);
  });

  it('撞面自动避开：与某场已有谜面相同的谜条顺延到其它场', () => {
    // 午场已有 r1（一口咬掉牛尾巴）；未编排的 rx 同谜面，默认只编排未分配项，应落到晚场
    const dup = r('rx', 99, '一口咬掉牛尾巴');
    const a = assign([['r1', 's1', 'b1']]);
    const plan = planBatch([...riddles, dup], sessions, booths, a, [], criteria);
    const x = plan.find((p) => p.riddle.id === 'rx')!;
    expect(x.sessionId).toBe('s2');
    expect(x.clashRiddles).toHaveLength(0);
    // 已归属的 r1 不在方案中（不被重排）
    expect(plan.find((p) => p.riddle.id === 'r1')).toBeUndefined();
  });

  it('两场都撞面时标记冲突，不静默落库', () => {
    const dup = r('rx', 99, '一口咬掉牛尾巴');
    const rs = [...riddles, dup];
    // 午场归属 r1；晚场通过借入也持有 r1 谜面。rx 未编排，两场都放不了
    const a = assign([['r1', 's1', 'b1']]);
    const br = [borrow('r1', 's1', 's2', 'b1')];
    const plan = planBatch(rs, sessions, booths, a, br, criteria);
    const x = plan.find((p) => p.riddle.id === 'rx')!;
    expect(x.clashRiddles.length).toBeGreaterThan(0);
  });
});

describe('导出 CSV', () => {
  it('清单按场次→摊位→谜号输出，含借入标记与未编排段', () => {
    const a = assign([['r3', 's1', 'b1'], ['r1', 's1', 'b1'], ['r5', 's2', 'b2']]);
    const br = [borrow('r7', 's2', 's1', 'b1')];
    const csv = scheduleToCSV('测试灯会', riddles, sessions, booths, a, br);
    expect(csv).toContain('分场编排清单 · 测试灯会');
    // 同摊位内谜号升序
    const i1 = csv.indexOf('1,一口咬掉牛尾巴');
    const i3 = csv.indexOf('3,十个哥哥');
    expect(i1).toBeGreaterThan(0);
    expect(i3).toBeGreaterThan(i1);
    expect(csv).toContain('借自');
    expect(csv).toContain('未编排');
    expect(csv).toContain('摊位负责人');
  });

  it('借用台账含借出方/借入方/状态/时间', () => {
    const br = [borrow('r1', 's1', 's2', 'b2'), borrow('r2', 's1', 's2', 'b1', true)];
    const csv = borrowLedgerToCSV(sessions, booths, br, riddles);
    expect(csv).toContain('借出方（归属场次）');
    expect(csv).toContain('午场');
    expect(csv).toContain('晚场');
    expect(csv).toContain('借用中');
    expect(csv).toContain('已归还');
  });
});
