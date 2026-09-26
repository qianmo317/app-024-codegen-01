// 分场编排 store 集成：内存 IDB 降级下走完整编排动作（UI 层只调这些动作）
// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// store.ts 顶层用到 import.meta.env.BASE_URL 与（惰性）indexedDB
vi.stubGlobal('indexedDB', undefined);

const { store } = await import('../src/lib/store');

beforeEach(async () => {
  await store.clearSchedule();
  // 清谜库：直接复用动作
  await store.clearRiddles();
});

describe('store 分场编排动作链', () => {
  it('建场→建摊→分条→挂摊→借用→归还→清单导出数据齐备', async () => {
    // 准备谜条（绕过校验数据 ctx，直接落库）
    const n = await store.addRiddles([
      { surface: '面一', answer: '一', category: 'char', format: 'none', difficulty: 1, tags: ['简'] },
      { surface: '面二', answer: '二', category: 'char', format: 'none', difficulty: 2, tags: [] },
      { surface: '面三', answer: '三', category: 'idiom', format: 'none', difficulty: 3, tags: ['难'] },
      { surface: '面四', answer: '四', category: 'char', format: 'none', difficulty: 2, tags: [] },
    ]);
    expect(n).toBe(4);

    const s1 = await store.saveSession({ name: '下午场', start: '14:00', end: '16:00' });
    const s2 = await store.saveSession({ name: '晚场', start: '18:00', end: '20:00' });
    const b1 = await store.saveBooth({ sessionId: s1.id, name: '字谜摊', owner: '张三' });
    const b2 = await store.saveBooth({ sessionId: s1.id, name: '成语摊', owner: '李四' });
    expect(store.getState().schedule.sessions).toHaveLength(2);

    const st = store.getState();
    const ids = st.riddles.map((r) => r.id);
    // 分 3 条到下午场
    let skipped = await store.assignRiddles(ids.slice(0, 3), s1.id);
    expect(skipped).toHaveLength(0);
    // 再分同场：全部 already
    skipped = await store.assignRiddles(ids.slice(0, 3), s1.id);
    expect(skipped.every((x) => x.reason === 'already')).toBe(true);

    // 挂摊：前两条挂字谜摊
    await store.setBooth(ids[0], s1.id, b1.id);
    await store.setBooth(ids[1], s1.id, b1.id);

    // 第 4 条分到晚场，再借一条下午场的到晚场
    await store.assignRiddles([ids[3]], s2.id);
    const br = await store.borrowRiddle(ids[0], s2.id, { reason: '晚场补位' });
    expect(br.ok).toBe(true);

    let schState = store.getState().schedule;
    expect(schState.borrows).toHaveLength(1);
    expect(schState.borrows[0].status).toBe('active');

    // 均衡：下午场 3 条，字谜摊 2、成语摊 0、未挂摊 1 → 一键均衡后相差 ≤1
    const moved = await store.autoBalance(s1.id);
    expect(moved).toBeGreaterThan(0);
    const { analyzeBalance } = await import('../src/lib/schedule');
    let ana = analyzeBalance(store.getState().schedule, s1.id, store.getState().riddles);
    expect(ana.max - ana.min).toBeLessThanOrEqual(1);
    expect(ana.unplaced).toBe(0);

    // 归还借用
    const borrowId = store.getState().schedule.borrows[0].id;
    await store.returnBorrow(borrowId);
    schState = store.getState().schedule;
    expect(schState.borrows[0].status).toBe('returned');

    // 删除一条谜：编排被清理
    await store.removeRiddles([ids[3]]);
    schState = store.getState().schedule;
    expect(schState.placements.some((p) => p.riddleId === ids[3])).toBe(false);
    expect(schState.borrows.some((b) => b.riddleId === ids[3])).toBe(false);

    // 改一场不影响另一场：下午场仍有 3 条
    const { sessionRiddleIds } = await import('../src/lib/schedule');
    expect(sessionRiddleIds(store.getState().schedule, s1.id)).toHaveLength(3);
    expect(sessionRiddleIds(store.getState().schedule, s2.id)).toHaveLength(0);

    // 删摊位不删归属
    await store.deleteBooth(b2.id);
    expect(store.getState().schedule.placements.every((p) => p.boothId !== b2.id)).toBe(true);
  });

  it('同谜面跨标点在同一场被 store 拦截', async () => {
    await store.addRiddles([
      { surface: '快刀斩乱麻', answer: '迎刃而解', category: 'idiom', format: 'none', difficulty: 2, tags: [] },
    ]);
    const r2 = await store.saveRiddle({ surface: '快刀、斩乱麻！', answer: '迎刃而解', category: 'idiom', format: 'none', difficulty: 2, tags: [] });
    const s1 = await store.saveSession({ name: '场', start: '', end: '' });
    const st = store.getState();
    const first = st.riddles.find((r) => r.surface === '快刀斩乱麻')!;
    await store.assignRiddles([first.id], s1.id);
    const skipped = await store.assignRiddles([r2.id], s1.id);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('duplicate');
  });
});
