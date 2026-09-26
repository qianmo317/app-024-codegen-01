// 分场编排 store 动作流（Node 下 IndexedDB 不可用，自动降级内存存储）
import { describe, it, expect, beforeEach } from 'vitest';
import { store } from '../src/lib/store';
import type { Riddle } from '../src/types';

function mk(id: string, no: number, surface: string): Riddle {
  return {
    id, no, surface, answer: `答${no}`, category: 'char', format: 'none',
    difficulty: 2, tags: [], check: { verdict: 'pass', reasons: [], checkedAt: 0 },
  };
}

/** saveRiddle 保留传入 id（编辑语义），适合测试固定引用 */
async function seed(...rs: Riddle[]): Promise<void> {
  for (const r of rs) await store.saveRiddle(r);
}

describe('store 分场编排动作', () => {
  beforeEach(() => {
    store._reset();
  });

  it('场次/摊位 CRUD 与排序', async () => {
    const s1 = await store.saveSession({ id: 'S1', name: '晚场', start: '18:00', end: '20:00' });
    const s2 = await store.saveSession({ id: 'S2', name: '午场', start: '13:00', end: '15:00' });
    expect(store.getState().sessions.map((x) => x.id)).toEqual(['S1', 'S2']); // 按插入 order
    // 交换 order 后午场在前
    await store.saveSession({ ...s1, order: 1 });
    await store.saveSession({ ...s2, order: 0 });
    expect(store.getState().sessions.map((x) => x.name)).toEqual(['午场', '晚场']);

    const b = await store.saveBooth({ id: 'B1', name: 'A 摊', owner: '张三' });
    expect(b.owner).toBe('张三');
    const edited = await store.saveBooth({ id: 'B1', name: 'A 摊', owner: '李四' });
    expect(store.getState().booths).toHaveLength(1);
    expect(edited.owner).toBe('李四');
  });

  it('每条谜条只属于一个场次：再次分配即移动', async () => {
    await store.saveSession({ id: 'S1', name: '午场', start: '13:00', end: '' });
    await store.saveSession({ id: 'S2', name: '晚场', start: '18:00', end: '' });
    await seed(mk('R1', 1, '面一'), mk('R2', 2, '面二'));

    await store.assignRiddle('R1', 'S1', '');
    expect(store.assignmentOf('R1')?.sessionId).toBe('S1');
    await store.assignRiddle('R1', 'S2', ''); // 移动
    const a = store.getState().assignments.filter((x) => x.riddleId === 'R1');
    expect(a).toHaveLength(1);
    expect(a[0].sessionId).toBe('S2');
    expect(store.getState().assignments).toHaveLength(1);
  });

  it('改一场的谜条（移动/移出）不影响其它场的安排', async () => {
    await store.saveSession({ id: 'S1', name: '午场', start: '13:00', end: '' });
    await store.saveSession({ id: 'S2', name: '晚场', start: '18:00', end: '' });
    await seed(mk('R1', 1, '面一'), mk('R2', 2, '面二'), mk('R3', 3, '面三'));
    await store.assignMany([
      { riddleId: 'R1', sessionId: 'S1' }, { riddleId: 'R2', sessionId: 'S1' },
      { riddleId: 'R3', sessionId: 'S2' },
    ]);
    // 动午场：把 R1 移走、R2 移出
    await store.assignRiddle('R1', 'S2');
    await store.unassign(['R2']);
    const st = store.getState();
    expect(st.assignments.find((x) => x.riddleId === 'R3')?.sessionId).toBe('S2'); // 晚场不动
    expect(st.assignments.find((x) => x.riddleId === 'R1')?.sessionId).toBe('S2');
    expect(st.assignments.find((x) => x.riddleId === 'R2')).toBeUndefined();
  });

  it('借用：校验（未归属/借给自己/同场撞面）→ 登记 → 计数 → 归还', async () => {
    await store.saveSession({ id: 'S1', name: '午场', start: '', end: '' });
    await store.saveSession({ id: 'S2', name: '晚场', start: '', end: '' });
    await seed(mk('R1', 1, '撞面'), mk('R2', 2, '撞面'), mk('R3', 3, '别的面'));
    await store.assignMany([{ riddleId: 'R1', sessionId: 'S1' }, { riddleId: 'R2', sessionId: 'S2' }]);

    // 未归属不能借
    expect((await store.borrowRiddle({ riddleId: 'R3', toSessionId: 'S2' })).ok).toBe(false);
    // 借给自己不行
    expect((await store.borrowRiddle({ riddleId: 'R1', toSessionId: 'S1' })).ok).toBe(false);
    // 同场撞面拦截（S2 已有同谜面 R2）
    const blocked = await store.borrowRiddle({ riddleId: 'R1', toSessionId: 'S2' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('重复谜面');

    // 无冲突借用：把 R3 借到 S1
    await store.assignRiddle('R3', 'S2');
    const ok = await store.borrowRiddle({ riddleId: 'R3', toSessionId: 'S1', reason: '补货' });
    expect(ok.ok).toBe(true);
    // 重复借同一场拦截
    expect((await store.borrowRiddle({ riddleId: 'R3', toSessionId: 'S1' })).ok).toBe(false);
    // 台账一条，借用中
    expect(store.getState().borrows.filter((b) => !b.returnedAt)).toHaveLength(1);
    // 归属仍是 S2（不变）
    expect(store.assignmentOf('R3')?.sessionId).toBe('S2');

    // 归还
    const recId = ok.record!.id;
    await store.returnBorrow(recId);
    expect(store.getState().borrows.find((b) => b.id === recId)?.returnedAt).toBeTruthy();
  });

  it('归属场次变化或移出时，未归还借用自动归还（不留悬挂）', async () => {
    await store.saveSession({ id: 'S1', name: '午场', start: '', end: '' });
    await store.saveSession({ id: 'S2', name: '晚场', start: '', end: '' });
    await store.saveSession({ id: 'S3', name: '夜场', start: '', end: '' });
    await seed(mk('R1', 1, '面甲'));
    await store.assignRiddle('R1', 'S1');
    const br = await store.borrowRiddle({ riddleId: 'R1', toSessionId: 'S2' });
    expect(br.ok).toBe(true);
    // 移到 S3 → 借用自动归还
    await store.assignRiddle('R1', 'S3');
    expect(store.getState().borrows.find((b) => b.id === br.record!.id)?.returnedAt).toBeTruthy();
  });

  it('删除摊位：谜条保留但变为未指定摊位；删除谜条级联清理归属与借用', async () => {
    await store.saveSession({ id: 'S1', name: '午场', start: '', end: '' });
    await store.saveSession({ id: 'S2', name: '晚场', start: '', end: '' });
    await store.saveBooth({ id: 'B1', name: 'A 摊', owner: '张三' });
    await seed(mk('R1', 1, '面甲'), mk('R2', 2, '面乙'));
    await store.assignMany([{ riddleId: 'R1', sessionId: 'S1', boothId: 'B1' }, { riddleId: 'R2', sessionId: 'S2' }]);
    const br = await store.borrowRiddle({ riddleId: 'R1', toSessionId: 'S2', boothId: 'B1' });
    expect(br.ok).toBe(true);

    await store.removeBooth('B1');
    expect(store.assignmentOf('R1')?.boothId).toBe('');
    expect(store.getState().borrows.find((b) => b.id === br.record!.id)?.boothId).toBe('');
    expect(store.getState().riddles.some((r) => r.id === 'R1')).toBe(true); // 谜条不删

    // 删除谜条 → 归属与借用都清理
    await store.removeRiddles(['R1']);
    expect(store.assignmentOf('R1')).toBeUndefined();
    expect(store.getState().borrows.some((b) => b.riddleId === 'R1')).toBe(false);
  });

  it('删除有归属的时段：非强制拒绝，强制后谜条变未编排', async () => {
    await store.saveSession({ id: 'S1', name: '午场', start: '', end: '' });
    await seed(mk('R1', 1, '面甲'));
    await store.assignRiddle('R1', 'S1');
    const refused = await store.removeSession('S1');
    expect(refused.ok).toBe(false);
    expect(refused.count).toBe(1);
    expect(store.getState().sessions.some((s) => s.id === 'S1')).toBe(true);

    const forced = await store.removeSession('S1', true);
    expect(forced.ok).toBe(true);
    expect(store.assignmentOf('R1')).toBeUndefined();
  });
});
