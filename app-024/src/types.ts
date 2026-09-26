// 数据模型（对应 PRD §7）
export type RiddleFormat =
  | 'none' | 'qiqian' | 'juanlian' | 'xufei' | 'lihua'
  | 'baitou' | 'fendi' | 'shanglou' | 'xialou';

export type RiddleCategory = 'char' | 'object' | 'idiom' | 'place' | 'person' | 'other';
export type AgeGroup = 'child' | 'teen' | 'adult' | 'all';
export type Verdict = 'pass' | 'suspect' | 'fail';

export type Riddle = {
  id: string;
  no: number;            // 谜号（现场对号、谜条大字）
  surface: string;       // 谜面
  answer: string;        // 谜底
  category: RiddleCategory;
  format: RiddleFormat;
  formatNote?: string;   // 谜格说明（谜条上展示）
  author?: string;
  source?: string;
  difficulty: 1 | 2 | 3;
  ageGroup?: AgeGroup;
  tags: string[];
  note?: string;
  check: { verdict: Verdict; reasons: string[]; checkedAt: number };
};

export type OnsiteRecord = {
  id: string;
  riddleId: string;
  winnerName?: string;
  winnerRef?: string;
  prize: string;
  at: number;
  note?: string;
  code?: string;         // 兑奖号码
};

export type EventInfo = {
  id: string;
  title: string;
  host: string;
  date: string;
  riddleIds: string[];
};

export type PrintSetup = {
  cardWmm: number;
  cardHmm: number;
  perPage: number;
  showAnswerSlip: boolean;  // 同页双联：下联回收联（含谜底）
  showCutLine: boolean;
  hostLine: string;
};

export type AppSettings = {
  event: EventInfo;
  print: PrintSetup;
  prizes: string[];
};

// ---- 分场编排 ----
/** 时段（一场灯会分若干场次，按时段先后排序） */
export type Session = {
  id: string;
  name: string;      // 场次名，如「午场」
  start: string;     // HH:MM
  end: string;       // HH:MM
  note?: string;
  order: number;
};

/** 摊位（全场固定点位，跨时段复用；负责人即「归谁管」） */
export type Booth = {
  id: string;
  name: string;      // 摊位名，如「A 区字谜摊」
  owner: string;     // 负责人
  location?: string; // 场地位置
  note?: string;
  order: number;
};

/**
 * 谜条归属：每条谜条至多一条记录（id 恒等于 riddleId，天然唯一）。
 * 归属场次 = 谜条正式所属场次；boothId 可为 ''（暂未指定摊位）。
 */
export type Assignment = {
  id: string;        // = riddleId
  riddleId: string;
  sessionId: string;
  boothId: string;
  at: number;
};

/** 跨场次借用记录：归属不变，借来的场次临时挂出；归还后置 returnedAt */
export type BorrowRecord = {
  id: string;
  riddleId: string;
  fromSessionId: string; // 借出方（归属场次）
  toSessionId: string;   // 借入方（临时挂出场次）
  boothId: string;       // 借入场挂在哪个摊位（'' = 未指定）
  reason?: string;
  at: number;
  returnedAt?: number;   // 未设置 = 借用中
};

export const CATEGORY_LABEL: Record<RiddleCategory, string> = {
  char: '猜一字', object: '猜一物', idiom: '猜成语', place: '猜地名', person: '猜人名', other: '其他',
};

export const FORMAT_LABEL: Record<RiddleFormat, string> = {
  none: '无格', qiqian: '秋千格', juanlian: '卷帘格', xufei: '徐妃格', lihua: '梨花格',
  baitou: '白头格', fendi: '粉底格', shanglou: '上楼格', xialou: '下楼格',
};

export const AGE_LABEL: Record<AgeGroup, string> = {
  child: '儿童', teen: '少年', adult: '成人', all: '通用',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: '通过', suspect: '存疑', fail: '不通过',
};

export const VERDICT_ICON: Record<Verdict, string> = {
  pass: '✓', suspect: '？', fail: '✕',
};

export const CATEGORY_FROM_LABEL: Record<string, RiddleCategory> = {};
for (const [k, v] of Object.entries(CATEGORY_LABEL)) CATEGORY_FROM_LABEL[v] = k as RiddleCategory;
CATEGORY_FROM_LABEL['字'] = 'char'; CATEGORY_FROM_LABEL['一物'] = 'object';
CATEGORY_FROM_LABEL['成语'] = 'idiom'; CATEGORY_FROM_LABEL['地名'] = 'place';
CATEGORY_FROM_LABEL['人名'] = 'person';

export const FORMAT_FROM_LABEL: Record<string, RiddleFormat> = {};
for (const [k, v] of Object.entries(FORMAT_LABEL)) FORMAT_FROM_LABEL[v] = k as RiddleFormat;

export const AGE_FROM_LABEL: Record<string, AgeGroup> = {};
for (const [k, v] of Object.entries(AGE_LABEL)) AGE_FROM_LABEL[v] = k as AgeGroup;
