// 集中式应用状态：数据读写全部在此，UI 只做展示与动作调用
import type { AppSettings, OnsiteRecord, Riddle, Schedule, Session, Booth } from '../types';
import { EMPTY_SCHEDULE } from '../types';
import { validateRiddle } from './validate';
import { EMPTY_CTX, loadDataCtx, type DataCtx } from './datafiles';
import * as idb from './idb';
import { formatDate } from './format';
import * as sch from './schedule';

const KV_SETTINGS = 'settings';
const KV_SCHEDULE = 'schedule';

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
  schedule: Schedule;
  ctx: DataCtx; // 拼音/部件离线数据
  selected: Set<string>; // 批量出条选中（会话级，不持久化）
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
    schedule: EMPTY_SCHEDULE,
    ctx: EMPTY_CTX,
    selected: new Set<string>(),
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
        const [riddles, records, settings, schedule, ctx] = await Promise.all([
          idb.getAll<Riddle>(idb.STORE_RIDDLES),
          idb.getAll<OnsiteRecord>(idb.STORE_RECORDS),
          idb.getKV<AppSettings>(KV_SETTINGS),
          idb.getKV<Schedule>(KV_SCHEDULE),
          loadDataCtx(import.meta.env.BASE_URL),
        ]);
        this.state.riddles = riddles.sort((a, b) => a.no - b.no);
        this.state.records = records.sort((a, b) => b.at - a.at);
        if (settings) {
          this.state.settings = {
            event: { ...DEFAULT_SETTINGS.event, ...settings.event },
            print: { ...DEFAULT_SETTINGS.print, ...settings.print },
            prizes: settings.prizes?.length ? settings.prizes : DEFAULT_SETTINGS.prizes,
          };
        }
        if (schedule) {
          this.state.schedule = { ...EMPTY_SCHEDULE, ...schedule,
            sessions: schedule.sessions ?? [], booths: schedule.booths ?? [],
            placements: schedule.placements ?? [], borrows: schedule.borrows ?? [] };
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
    this.state.schedule = sch.pruneRiddles(this.state.schedule, ids);
    await Promise.all([
      ...ids.map((id) => idb.del(idb.STORE_RIDDLES, id)),
      this.saveSettings(this.state.settings),
      this.persistSchedule(),
    ]);
    this.emit();
  }

  async clearRiddles(): Promise<void> {
    this.state.riddles = [];
    this.state.settings.event.riddleIds = [];
    this.state.schedule = { ...EMPTY_SCHEDULE, updatedAt: Date.now() };
    await Promise.all([
      idb.clearStore(idb.STORE_RIDDLES),
      this.saveSettings(this.state.settings),
      this.persistSchedule(),
    ]);
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

  // ---- 分场编排 ----
  private async persistSchedule(): Promise<void> {
    await idb.setKV(KV_SCHEDULE, this.state.schedule);
  }

  /** 直接替换编排（纯函数计算结果落库） */
  private commitSchedule(next: Schedule): Promise<void> {
    this.state.schedule = next;
    return this.persistSchedule().then(() => this.emit());
  }

  async saveSession(input: { id?: string; name: string; start: string; end: string; note?: string }): Promise<Session> {
    const session: Session = {
      id: input.id ?? sch.scheduleUid('sess'),
      name: input.name.trim() || '未命名场次',
      start: input.start, end: input.end,
      note: input.note?.trim() || undefined,
    };
    await this.commitSchedule(sch.upsertSession(this.state.schedule, session));
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    await this.commitSchedule(sch.removeSession(this.state.schedule, id));
  }

  async saveBooth(input: { id?: string; sessionId: string; name: string; owner: string; note?: string }): Promise<Booth> {
    const booth: Booth = {
      id: input.id ?? sch.scheduleUid('booth'),
      sessionId: input.sessionId,
      name: input.name.trim() || '未命名摊位',
      owner: input.owner.trim(),
      note: input.note?.trim() || undefined,
    };
    await this.commitSchedule(sch.upsertBooth(this.state.schedule, booth));
    return booth;
  }

  async deleteBooth(id: string): Promise<void> {
    await this.commitSchedule(sch.removeBooth(this.state.schedule, id));
  }

  /** 分批分场：把谜条设为某场次自有；返回跳过（重复/已在）清单 */
  async assignRiddles(riddleIds: string[], sessionId: string): Promise<sch.AssignResult['skipped']> {
    const result = sch.assignRiddles(this.state.schedule, riddleIds, sessionId, this.state.riddles);
    this.state.schedule = result.schedule;
    await this.persistSchedule();
    this.emit();
    return result.skipped;
  }

  async unassignRiddles(riddleIds: string[]): Promise<void> {
    await this.commitSchedule(sch.unassignRiddles(this.state.schedule, riddleIds));
  }

  async setBooth(riddleId: string, sessionId: string, boothId: string | undefined): Promise<void> {
    await this.commitSchedule(sch.setBooth(this.state.schedule, riddleId, sessionId, boothId));
  }

  async assignManyToBooth(riddleIds: string[], sessionId: string, boothId: string): Promise<void> {
    let next = this.state.schedule;
    for (const id of riddleIds) next = sch.setBooth(next, id, sessionId, boothId);
    await this.commitSchedule(next);
  }

  async borrowRiddle(
    riddleId: string, toSessionId: string, opts: { boothId?: string; reason?: string } = {},
  ): Promise<{ ok: boolean; error?: sch.BorrowResult['error']; conflictNo?: number }> {
    const result = sch.borrowRiddle(this.state.schedule, riddleId, toSessionId, this.state.riddles, opts);
    if (result.error) return { ok: false, error: result.error, conflictNo: result.conflictNo };
    await this.commitSchedule(result.schedule);
    return { ok: true };
  }

  async returnBorrow(borrowId: string): Promise<void> {
    await this.commitSchedule(sch.returnBorrow(this.state.schedule, borrowId));
  }

  /** 一键均衡：按纯函数给出的方案调整挂摊，返回挪动条数 */
  async autoBalance(sessionId: string): Promise<number> {
    const analysis = sch.analyzeBalance(this.state.schedule, sessionId, this.state.riddles);
    if (!analysis.moves.length) return 0;
    await this.commitSchedule(sch.applyMoves(this.state.schedule, sessionId, analysis.moves));
    return analysis.moves.length;
  }

  async clearSchedule(): Promise<void> {
    await this.commitSchedule({ ...EMPTY_SCHEDULE, updatedAt: Date.now() });
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
}

export const store = new AppStore();

// ---- 导出辅助（供各页面/导出模块复用）----
export function exportFileName(prefix: string, ext: string): string {
  const ev = store.getState().settings.event;
  const base = ev.title ? `${ev.title}-` : '';
  return `${prefix}-${base}${formatDate(new Date())}.${ext}`;
}
