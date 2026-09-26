// 集中式应用状态：数据读写全部在此，UI 只做展示与动作调用
import type { AppSettings, Assignment, Booth, BorrowRecord, OnsiteRecord, Riddle, Session } from '../types';
import { validateRiddle } from './validate';
import { EMPTY_CTX, loadDataCtx, type DataCtx } from './datafiles';
import { clashWith } from './schedule';
import * as idb from './idb';
import { formatDate } from './format';

const KV_SETTINGS = 'settings';

export const DEFAULT_SETTINGS: AppSettings = {
  event: { id: 'event-default', title: '元宵灯会', host: '', date: '', riddleIds: [] },
  print: {
    cardWmm: 63, cardHmm: 135, perPage: 6,
    showAnswerSlip: true, showCutLine: true,
    hostLine: '',
  },
  prizes: ['参与奖', '三等奖', '二等奖', '一等奖'],
};

export interface AppState {
  ready: boolean;
  riddles: Riddle[];
  records: OnsiteRecord[];
  settings: AppSettings;
  ctx: DataCtx; // 拼音/部件离线数据
  selected: Set<string>; // 批量出条选中（会话级，不持久化）
  sessions: Session[];
  booths: Booth[];
  assignments: Assignment[];
  borrows: BorrowRecord[];
}

type Listener = () => void;

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class AppStore {
  private state: AppState = {
    ready: false,
    riddles: [],
    records: [],
    settings: DEFAULT_SETTINGS,
    ctx: EMPTY_CTX,
    selected: new Set<string>(),
    sessions: [],
    booths: [],
    assignments: [],
    borrows: [],
  };
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;

  getState = (): AppState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    this.state = { ...this.state };
    for (const l of this.listeners) l();
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const [riddles, records, settings, ctx, sessions, booths, assignments, borrows] = await Promise.all([
          idb.getAll<Riddle>(idb.STORE_RIDDLES),
          idb.getAll<OnsiteRecord>(idb.STORE_RECORDS),
          idb.getKV<AppSettings>(KV_SETTINGS),
          loadDataCtx(import.meta.env.BASE_URL),
          idb.getAll<Session>(idb.STORE_SESSIONS),
          idb.getAll<Booth>(idb.STORE_BOOTHS),
          idb.getAll<Assignment>(idb.STORE_ASSIGNMENTS),
          idb.getAll<BorrowRecord>(idb.STORE_BORROWS),
        ]);
        this.state.riddles = riddles.sort((a, b) => a.no - b.no);
        this.state.records = records.sort((a, b) => b.at - a.at);
        this.state.sessions = sessions.sort((a, b) => a.order - b.order || a.start.localeCompare(b.start));
        this.state.booths = booths.sort((a, b) => a.order - b.order);
        this.state.assignments = assignments;
        this.state.borrows = borrows.sort((a, b) => b.at - a.at);
        if (settings) {
          this.state.settings = {
            event: { ...DEFAULT_SETTINGS.event, ...settings.event },
            print: { ...DEFAULT_SETTINGS.print, ...settings.print },
            prizes: settings.prizes?.length ? settings.prizes : DEFAULT_SETTINGS.prizes,
          };
        }
        if (!this.state.settings.print.hostLine && this.state.settings.event.host) {
          this.state.settings.print.hostLine = `${this.state.settings.event.host}`;
        }
        this.state.ctx = ctx;
        this.state.ready = true;
        this.emit();
      })();
    }
    return this.initPromise;
  }

  // ---- 谜库 ----
  nextNo(): number {
    return this.state.riddles.reduce((m, r) => Math.max(m, r.no), 0) + 1;
  }

  /** 新增/保存：自动计算谜格校验结果 */
  async saveRiddle(patch: Omit<Riddle, 'id' | 'no' | 'check'> & { id?: string; no?: number }): Promise<Riddle> {
    const id = patch.id ?? uid();
    const existing = patch.id ? this.state.riddles.find((r) => r.id === patch.id) : undefined;
    const no = patch.no ?? existing?.no ?? this.nextNo();
    const check = validateRiddle(patch, this.state.ctx);
    const riddle: Riddle = {
      ...patch,
      id,
      no,
      check: { ...check, checkedAt: Date.now() },
      tags: patch.tags ?? [],
      difficulty: patch.difficulty ?? 2,
    };
    if (existing) {
      this.state.riddles = this.state.riddles.map((r) => (r.id === id ? riddle : r));
    } else {
      this.state.riddles = [...this.state.riddles, riddle];
    }
    this.state.riddles.sort((a, b) => a.no - b.no);
    await idb.put(idb.STORE_RIDDLES, riddle);
    this.emit();
    return riddle;
  }

  /** 批量导入（去重后的新增项） */
  async addRiddles(items: (Omit<Riddle, 'id' | 'no' | 'check'> & Partial<Pick<Riddle, 'no'>>)[]): Promise<number> {
    if (!items.length) return 0;
    let no = this.nextNo();
    const now = Date.now();
    const riddles: Riddle[] = items.map((it) => ({
      ...it,
      id: uid(),
      no: it.no ?? no++,
      tags: it.tags ?? [],
      difficulty: it.difficulty ?? 2,
      check: { ...validateRiddle(it, this.state.ctx), checkedAt: now },
    }));
    this.state.riddles = [...this.state.riddles, ...riddles].sort((a, b) => a.no - b.no);
    await idb.putMany(idb.STORE_RIDDLES, riddles);
    this.emit();
    return riddles.length;
  }

  async recheckAll(): Promise<void> {
    const now = Date.now();
    const riddles = this.state.riddles.map((r) => ({
      ...r,
      check: { ...validateRiddle(r, this.state.ctx), checkedAt: now },
    }));
    this.state.riddles = riddles.sort((a, b) => a.no - b.no);
    await idb.putMany(idb.STORE_RIDDLES, riddles);
    this.emit();
  }

  async removeRiddles(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.state.riddles = this.state.riddles.filter((r) => !set.has(r.id));
    this.state.settings.event.riddleIds = this.state.settings.event.riddleIds.filter((x) => !set.has(x));
    // 级联清理：归属（key = riddleId）、借用记录一并删除，避免悬挂引用
    const staleBorrows = this.state.borrows.filter((b) => set.has(b.riddleId));
    this.state.assignments = this.state.assignments.filter((a) => !set.has(a.riddleId));
    this.state.borrows = this.state.borrows.filter((b) => !set.has(b.riddleId));
    await Promise.all([
      ...ids.map((id) => idb.del(idb.STORE_RIDDLES, id)),
      ...ids.map((id) => idb.del(idb.STORE_ASSIGNMENTS, id)),
      ...staleBorrows.map((b) => idb.del(idb.STORE_BORROWS, b.id)),
    ]);
    await this.saveSettings(this.state.settings); // 同步活动清单
    this.emit();
  }

  async clearRiddles(): Promise<void> {
    this.state.riddles = [];
    this.state.settings.event.riddleIds = [];
    this.state.assignments = [];
    this.state.borrows = [];
    await idb.clearStore(idb.STORE_RIDDLES);
    await idb.clearStore(idb.STORE_ASSIGNMENTS);
    await idb.clearStore(idb.STORE_BORROWS);
    await this.saveSettings(this.state.settings);
    this.emit();
  }

  async loadSample(samples: Omit<Riddle, 'id' | 'no' | 'check'>[]): Promise<number> {
    return this.addRiddles(samples);
  }

  // ---- 批量选中（会话级）----
  toggleSelect(id: string): void {
    const s = new Set(this.state.selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    this.state.selected = s;
    this.emit();
  }

  selectMany(ids: string[], on: boolean): void {
    const s = new Set(this.state.selected);
    for (const id of ids) { if (on) s.add(id); else s.delete(id); }
    this.state.selected = s;
    this.emit();
  }

  clearSelection(): void {
    this.state.selected = new Set();
    this.emit();
  }

  // ---- 现场登记 ----
  recordsOf(riddleId: string): OnsiteRecord[] {
    return this.state.records.filter((r) => r.riddleId === riddleId);
  }

  async addRecord(rec: Omit<OnsiteRecord, 'id' | 'at'> & { at?: number }): Promise<OnsiteRecord> {
    const full: OnsiteRecord = { ...rec, id: uid(), at: rec.at ?? Date.now() };
    this.state.records = [full, ...this.state.records];
    await idb.put(idb.STORE_RECORDS, full);
    this.emit();
    return full;
  }

  async removeRecord(id: string): Promise<void> {
    this.state.records = this.state.records.filter((r) => r.id !== id);
    await idb.del(idb.STORE_RECORDS, id);
    this.emit();
  }

  async clearRecords(): Promise<void> {
    this.state.records = [];
    await idb.clearStore(idb.STORE_RECORDS);
    this.emit();
  }

  /** 兑奖号码生成：按登记时间顺序生成 DJ-xxxx（仅生成号码，不做在线抽奖） */
  async generatePrizeCodes(): Promise<number> {
    let n = 0;
    const sorted = [...this.state.records].sort((a, b) => a.at - b.at);
    for (const r of sorted) {
      if (!r.code) {
        n++;
        r.code = `DJ-${String(n).padStart(4, '0')}`;
        await idb.put(idb.STORE_RECORDS, r);
      }
    }
    if (n) this.emit();
    return n;
  }

  // ---- 设置 ----
  async saveSettings(patch: Partial<AppSettings>): Promise<void> {
    this.state.settings = {
      event: { ...this.state.settings.event, ...patch.event },
      print: { ...this.state.settings.print, ...patch.print },
      prizes: patch.prizes ?? this.state.settings.prizes,
    };
    await idb.setKV(KV_SETTINGS, this.state.settings);
    this.emit();
  }

  // ---- 分场编排：场次 ----
  async saveSession(patch: Omit<Session, 'order'> & { order?: number }): Promise<Session> {
    const existing = this.state.sessions.find((s) => s.id === patch.id);
    const order = patch.order ?? existing?.order ?? this.state.sessions.length;
    const session: Session = {
      id: patch.id,
      name: patch.name.trim() || '未命名场次',
      start: patch.start,
      end: patch.end,
      note: patch.note?.trim() || undefined,
      order,
    };
    this.state.sessions = [...this.state.sessions.filter((s) => s.id !== session.id), session]
      .sort((a, b) => a.order - b.order || a.start.localeCompare(b.start));
    await idb.put(idb.STORE_SESSIONS, session);
    this.emit();
    return session;
  }

  /** 删除场次；force=false 时若仍有归属谜条则拒绝并返回条数 */
  async removeSession(id: string, force = false): Promise<{ ok: boolean; count: number }> {
    const count = this.state.assignments.filter((a) => a.sessionId === id).length;
    const activeIn = this.state.borrows.filter((b) => !b.returnedAt && b.toSessionId === id).length;
    if (!force && (count || activeIn)) return { ok: false, count: count + activeIn };
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    // 强制删除：归属的谜条变为未编排；相关借用记录删除
    const droppedAssignments = this.state.assignments.filter((a) => a.sessionId === id);
    const droppedBorrows = this.state.borrows.filter((b) => b.fromSessionId === id || b.toSessionId === id);
    this.state.assignments = this.state.assignments.filter((a) => a.sessionId !== id);
    this.state.borrows = this.state.borrows.filter((b) => b.fromSessionId !== id && b.toSessionId !== id);
    await Promise.all([
      idb.del(idb.STORE_SESSIONS, id),
      ...droppedAssignments.map((a) => idb.del(idb.STORE_ASSIGNMENTS, a.id)),
      ...droppedBorrows.map((b) => idb.del(idb.STORE_BORROWS, b.id)),
    ]);
    this.emit();
    return { ok: true, count: 0 };
  }

  // ---- 分场编排：摊位 ----
  async saveBooth(patch: Omit<Booth, 'order'> & { order?: number }): Promise<Booth> {
    const booth: Booth = {
      id: patch.id,
      name: patch.name.trim() || '未命名摊位',
      owner: patch.owner.trim(),
      location: patch.location?.trim() || undefined,
      note: patch.note?.trim() || undefined,
      order: patch.order ?? (this.state.booths.find((b) => b.id === patch.id)?.order ?? this.state.booths.length),
    };
    this.state.booths = [...this.state.booths.filter((b) => b.id !== booth.id), booth]
      .sort((a, b) => a.order - b.order);
    await idb.put(idb.STORE_BOOTHS, booth);
    this.emit();
    return booth;
  }

  /** 删除摊位：该摊位移除，相关归属/借用的摊位归为「未指定」（记录保留） */
  async removeBooth(id: string): Promise<void> {
    this.state.booths = this.state.booths.filter((b) => b.id !== id);
    const touchedA = this.state.assignments.filter((a) => a.boothId === id).map((a) => ({ ...a, boothId: '' }));
    const touchedB = this.state.borrows.filter((b) => b.boothId === id).map((b) => ({ ...b, boothId: '' }));
    this.state.assignments = this.state.assignments.map((a) => (a.boothId === id ? { ...a, boothId: '' } : a));
    this.state.borrows = this.state.borrows.map((b) => (b.boothId === id ? { ...b, boothId: '' } : b));
    await Promise.all([
      idb.del(idb.STORE_BOOTHS, id),
      idb.putMany(idb.STORE_ASSIGNMENTS, touchedA),
      idb.putMany(idb.STORE_BORROWS, touchedB),
    ]);
    this.emit();
  }

  // ---- 分场编排：归属（每条谜条只属于一个场次）----
  assignmentOf(riddleId: string): Assignment | undefined {
    return this.state.assignments.find((a) => a.riddleId === riddleId);
  }

  /** 分配/移动谜条归属（同一条只能在一个场次）；boothId='' 表示未指定摊位 */
  async assignRiddle(riddleId: string, sessionId: string, boothId = ''): Promise<void> {
    const prev = this.state.assignments.find((a) => a.riddleId === riddleId);
    const next: Assignment = {
      id: riddleId, // key 恒等于 riddleId，保证唯一
      riddleId, sessionId, boothId,
      at: prev?.at ?? Date.now(),
    };
    this.state.assignments = [...this.state.assignments.filter((a) => a.riddleId !== riddleId), next];
    const touched = this.closeBorrowsIfMoved([[riddleId, prev?.sessionId, sessionId]]);
    await Promise.all([
      idb.put(idb.STORE_ASSIGNMENTS, next),
      ...touched.map((b) => idb.put(idb.STORE_BORROWS, b)),
    ]);
    this.emit();
  }

  async assignMany(entries: { riddleId: string; sessionId: string; boothId?: string }[]): Promise<number> {
    if (!entries.length) return 0;
    const now = Date.now();
    const map = new Map(this.state.assignments.map((a) => [a.riddleId, a]));
    const moves: [string, string | undefined, string][] = [];
    for (const e of entries) {
      const prev = map.get(e.riddleId);
      moves.push([e.riddleId, prev?.sessionId, e.sessionId]);
      map.set(e.riddleId, {
        id: e.riddleId, riddleId: e.riddleId,
        sessionId: e.sessionId, boothId: e.boothId ?? prev?.boothId ?? '',
        at: prev?.at ?? now,
      });
    }
    this.state.assignments = [...map.values()];
    const touched = this.closeBorrowsIfMoved(moves);
    await Promise.all([
      idb.putMany(idb.STORE_ASSIGNMENTS, this.state.assignments),
      ...touched.map((b) => idb.put(idb.STORE_BORROWS, b)),
    ]);
    this.emit();
    return entries.length;
  }

  /** 归属场次变化时，把该谜条未归还的借用自动归还（保留台账），返回被更新的记录 */
  private closeBorrowsIfMoved(moves: [string, string | undefined, string][]): BorrowRecord[] {
    const changed = new Set(moves.filter(([, from, to]) => from !== undefined && from !== to).map(([id]) => id));
    if (!changed.size) return [];
    const now = Date.now();
    const touched: BorrowRecord[] = [];
    this.state.borrows = this.state.borrows.map((b) => {
      if (b.returnedAt || !changed.has(b.riddleId)) return b;
      const next = { ...b, returnedAt: now };
      touched.push(next);
      return next;
    });
    return touched;
  }

  /** 把一批谜条移出某场次（变为未编排）；若正被别场借用，相关借用自动归还并保留台账 */
  async unassign(riddleIds: string[]): Promise<void> {
    const set = new Set(riddleIds);
    this.state.assignments = this.state.assignments.filter((a) => !set.has(a.riddleId));
    const now = Date.now();
    const touchedBorrows = this.state.borrows
      .filter((b) => set.has(b.riddleId) && !b.returnedAt)
      .map((b) => ({ ...b, returnedAt: now }));
    this.state.borrows = this.state.borrows.map((b) =>
      !b.returnedAt && set.has(b.riddleId) ? { ...b, returnedAt: now } : b);
    await Promise.all([
      ...riddleIds.map((rid) => idb.del(idb.STORE_ASSIGNMENTS, rid)),
      ...touchedBorrows.map((b) => idb.put(idb.STORE_BORROWS, b)),
    ]);
    this.emit();
  }

  /** 仅改摊位（同一场内调度，不动归属场次） */
  async setBooth(riddleId: string, boothId: string): Promise<void> {
    const a = this.state.assignments.find((x) => x.riddleId === riddleId);
    if (!a || a.boothId === boothId) return;
    const next = { ...a, boothId };
    this.state.assignments = this.state.assignments.map((x) => (x.riddleId === riddleId ? next : x));
    await idb.put(idb.STORE_ASSIGNMENTS, next);
    this.emit();
  }

  // ---- 分场编排：跨场借用（归属不变，留借用记录，可归还）----
  /**
   * 借用：把已归属 fromSession 的谜条借给 toSession 临时挂出。
   * 校验：谜条须有归属、不能借给自己、同场不能有重复谜面。
   */
  async borrowRiddle(input: {
    riddleId: string; toSessionId: string; boothId?: string; reason?: string;
  }): Promise<{ ok: boolean; error?: string; record?: BorrowRecord }> {
    const a = this.state.assignments.find((x) => x.riddleId === input.riddleId);
    if (!a) return { ok: false, error: '该谜条尚未归属任何场次，无法借用；请先分配归属' };
    if (a.sessionId === input.toSessionId) return { ok: false, error: '借入方就是谜条归属场次，无需借用' };
    if (!this.state.sessions.some((s) => s.id === input.toSessionId)) return { ok: false, error: '借入场次不存在' };
    const active = this.state.borrows.filter((b) => !b.returnedAt);
    if (active.some((b) => b.riddleId === input.riddleId && b.toSessionId === input.toSessionId)) {
      return { ok: false, error: '该谜条已借入本场且尚未归还' };
    }
    const riddle = this.state.riddles.find((r) => r.id === input.riddleId);
    if (riddle) {
      const dups = clashWith(riddle, input.toSessionId, this.state.riddles, this.state.sessions, this.state.booths, this.state.assignments, this.state.borrows);
      if (dups.length) {
        const toName = this.state.sessions.find((s) => s.id === input.toSessionId)?.name ?? '';
        return { ok: false, error: `借入后「${toName}」将出现重复谜面（谜号 ${[...new Set(dups.map((d) => d.no))].join('、')}）` };
      }
    }
    const record: BorrowRecord = {
      id: uid(),
      riddleId: input.riddleId,
      fromSessionId: a.sessionId,
      toSessionId: input.toSessionId,
      boothId: input.boothId ?? '',
      reason: input.reason?.trim() || undefined,
      at: Date.now(),
    };
    this.state.borrows = [record, ...this.state.borrows];
    await idb.put(idb.STORE_BORROWS, record);
    this.emit();
    return { ok: true, record };
  }

  /** 归还：把借用记录标记为已归还（保留台账） */
  async returnBorrow(id: string): Promise<void> {
    const b = this.state.borrows.find((x) => x.id === id);
    if (!b || b.returnedAt) return;
    const next = { ...b, returnedAt: Date.now() };
    this.state.borrows = this.state.borrows.map((x) => (x.id === id ? next : x));
    await idb.put(idb.STORE_BORROWS, next);
    this.emit();
  }

  async removeBorrow(id: string): Promise<void> {
    this.state.borrows = this.state.borrows.filter((b) => b.id !== id);
    await idb.del(idb.STORE_BORROWS, id);
    this.emit();
  }

  // ---- 统计 ----
  stats(): { total: number; solved: number; remaining: number; prizes: number } {
    const solvedSet = new Set(this.state.records.map((r) => r.riddleId));
    return {
      total: this.state.riddles.length,
      solved: solvedSet.size,
      remaining: this.state.riddles.length - solvedSet.size,
      prizes: this.state.records.filter((r) => r.prize.trim()).length,
    };
  }

  riddleByNo(no: number): Riddle | undefined {
    return this.state.riddles.find((r) => r.no === no);
  }

  /** 测试用：清空全部内存状态（不触 IDB） */
  _reset(): void {
    this.initPromise = null;
    this.state = {
      ready: false, riddles: [], records: [], settings: DEFAULT_SETTINGS,
      ctx: EMPTY_CTX, selected: new Set<string>(),
      sessions: [], booths: [], assignments: [], borrows: [],
    };
  }
}

export const store = new AppStore();

// ---- 导出辅助（供各页面/导出模块复用）----
export function exportFileName(prefix: string, ext: string): string {
  const ev = store.getState().settings.event;
  const base = ev.title ? `${ev.title}-` : '';
  return `${prefix}-${base}${formatDate(new Date())}.${ext}`;
}
