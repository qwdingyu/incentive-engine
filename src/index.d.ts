/**
 * TypeScript 类型声明 — @usethink/incentive-engine
 *
 * 手写声明，与 src/ 下的 JSDoc 及运行时行为一一对应。
 * 金额一律用 decimal string 传递（避免浮点误差）；比例为「百分比整数」，10 表示 10%。
 *
 * 注意：本文件描述的是引擎的**对外契约**。带 `_` 前缀的成员是模板内部实现，
 * 仅因 customerAdapterTemplate 需要被复制/覆写才对外暴露，不构成稳定 API。
 */

/** 金额/比例的字符串表示（decimal string，如 "1000.0000"） */
export type DecimalString = string;

/** 数值入参：接受字符串或数字，引擎内部统一 String() 化 */
export type Numeric = DecimalString | number;

/** 奖励类型 */
export type RewardType = "DIRECT" | "LEVEL" | "FIXED" | "CUSTOM";

/** 奖励目标（引擎仅支持这两种） */
export type RewardTarget = "SOURCE" | "PARENT" | "ANCESTOR";

/** 封顶维度：PLATFORM = 平台当期合计；PER_USER = 单个受益节点当期合计 */
export type CapDimension = "PLATFORM" | "PER_USER";

/**
 * 封顶周期。
 * ⚠️ 引擎**不认识日期**：周期边界由宿主的水位行生命周期决定
 * （DAILY 按业务日分行、WEEKLY/MONTHLY 按周/月分行、TOTAL 不归零 = 活动总量）。
 */
export type CapPeriod = "DAILY" | "WEEKLY" | "MONTHLY" | "TOTAL";

/** 封顶 scope = `<维度>_<周期>` 全组合（8 个）；未知 scope 会抛错 */
export type CapScope = `${CapDimension}_${CapPeriod}`;

/** 封顶超限行为 */
export type CapOnExceed = "REJECT" | "ALERT_ONLY";

/** 预算兜底超发行为 */
export type BudgetOnExceed = "CAP" | "WARN" | "REJECT";

/** 条件类型 */
export type ConditionType = "COMPARE" | "AND" | "OR" | "NOT";

/** 比较操作符 */
export type ComparisonOperator = "GTE" | "GT" | "LTE" | "LT" | "EQ" | "NE";

/**
 * COMPARE 条件的数据源
 * - "event"：事件侧（如「订单金额 >= 1000 才发佣」）
 * - "target"：受益节点侧（如「只给 V2 以上的上级发」「上级团队业绩满 5 万才发」）
 * - 省略：调用方给的默认数据源（rewardDefs 场景 = 事件；rankDefs 场景 = 被评估节点）
 */
export type ConditionSource = "event" | "target";

/** 规则集里可声明的流水线阶段处理器（ruleSetConfigSchema 的白名单） */
export type RuleSetStageHandler = "DISTRIBUTE" | "RANK" | "CAMPAIGN" | "CAP" | "OVER" | "SPLIT";

/**
 * 流水线阶段处理器。
 * "REVERSE"（冲正）只能在运行期构造 —— 它需要运行期的原始收益记录，
 * 写进规则集会被 ruleSetConfigSchema 拒绝（见 RuleSetStageHandler）。
 */
export type StageHandler = RuleSetStageHandler | "REVERSE";

/**
 * 冲正超出可冲正余额时的处理策略。
 * - "CLAMP"（缺省）：裁剪到剩余可冲正额度，记录带 snapshot.reversal.clamped
 * - "REJECT"：抛错（宁可整笔失败也不冒超额追回的风险）
 */
export type ReversalOnExceed = "CLAMP" | "REJECT";

/**
 * 绝对时刻。引擎**没有日历、也绝不调用 Date.now()** —— 判定时刻一律由宿主显式给出。
 * 只接受两种无歧义写法：`Date` 实例，或**带时区偏移量**的 ISO-8601 字符串
 * （`"2026-11-11T00:00:00+08:00"` / `"2026-11-10T16:00:00Z"`）。
 * 不带偏移的 `"2026-11-11T00:00:00"` 按进程本地时区解析、纯日期 `"2026-11-11"` 按 UTC 解析
 * —— 两者约定相反，同一份配置在不同环境下实际生效时刻会相差数小时，因此**都会抛错**；
 * 数字时间戳同样抛错（秒与毫秒无法区分）。
 */
export type Instant = Date | string;

/**
 * 时间窗口，**左闭右开** `[startAt, endAt)`。
 * 两端都必填：只写开始等于「永久生效」，那正是「双十一翻倍规则发到十二月」的成因。
 */
export interface TimeWindow {
  startAt: Instant;
  endAt: Instant;
}

/**
 * 活动期加成定义（限时系数）。
 * 加成必须在封顶/预算裁剪**之前**执行（CAMPAIGN 阶段排在 CAP/OVER 之后会抛错），
 * 否则「日限额 100」会被 2 倍活动放大成 200。
 */
export interface CampaignDefLike extends TimeWindow {
  campaignId: string;
  /**
   * 加成**倍数**（不是百分比）：`2` 翻倍、`1.5` 一点五倍、不加成写 `1`。
   * 取值范围 `0 < multiplier <= CAMPAIGN_MULTIPLIER_MAX`（10）——
   * 上限用于拦住「按百分比写成 100」这类会放大 100 倍的笔误。
   */
  multiplier: Numeric;
  /** 限定加成哪些奖励项；**省略 = 全部**。空数组语义相反（谁都不加成），会抛错 */
  rewardIds?: string[];
  metadata?: Record<string, unknown>;
}

/** 活动加成汇总（对账用；executePipeline 写入 context.campaignSummary） */
export interface CampaignSummary {
  /** 本次判定所用的事件发生时刻（ISO-8601 UTC）；无活动定义时为 null */
  occurredAt: string | null;
  /** 命中窗口的活动 ID（按 campaignDefs 顺序） */
  activeCampaignIds: string[];
  /** 实际被加成的记录数 */
  boostedCount: number;
  /** 未被加成、原样透传的记录数 */
  untouchedCount: number;
  totalBefore: DecimalString;
  totalAfter: DecimalString;
  /** 按活动汇总：campaignId → { count, totalBefore, totalAfter } */
  byCampaign: Record<string, { count: number; totalBefore: DecimalString; totalAfter: DecimalString }>;
}

/** 节点（分销关系树上的一个成员） */
export interface NodeLike {
  id: string;
  parentId?: string | null;
  rankId?: string;
  /**
   * 等级分成比例（百分比整数字符串）。
   * 两条来路：宿主预计算后写在节点上，或由 RANK 阶段现场评级写回。
   * ⚠️ 未评级时必须保持 undefined —— 写 "0" 兜底会被 RANK 判定为「宿主已预计算」而跳过评级。
   */
  rankRate?: DecimalString;
  attrs?: Record<string, unknown>;
  tags?: string[] | Set<string>;
  [key: string]: unknown;
}

/** 业务事件（触发一次激励计算的输入） */
export interface EventLike {
  eventId?: string | null;
  sourceNodeId: string;
  eventType?: string;
  eventValue?: Numeric;
  attrs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 条件定义（COMPARE 原子条件 / AND·OR·NOT 复合条件） */
export interface ConditionLike {
  /** 省略时按扁平 COMPARE 处理（引擎自动补 type: "COMPARE"） */
  type?: ConditionType;
  field?: string;
  operator?: ComparisonOperator;
  value?: unknown;
  subKey?: string | number;
  /** COMPARE 的求值数据源；rankDefs 的条件只允许 "target"（等级评估没有事件上下文） */
  source?: ConditionSource;
  children?: ConditionLike[];
}

/** 奖励定义（「怎么分」的声明式表达） */
export interface RewardDefLike {
  rewardId: string;
  type?: RewardType;
  /** 比例（百分比整数，10 = 10%）；LEVEL 通常为 null（用链上 rankRate） */
  rate?: Numeric | null;
  /** FIXED 必填：固定金额 */
  fixedAmount?: Numeric | null;
  /** CUSTOM：固定金额常量 */
  amount?: Numeric | null;
  /** CUSTOM：动态取数路径 "eventValue" | "event.attrs.<path>" */
  amountFrom?: string | null;
  target?: RewardTarget;
  /**
   * target: "ANCESTOR" 的定点层号（>= 1 的整数，1 = 最近的祖先），
   * 层号口径与 LEVEL 的 maxDepth/levelRates 一致。用于「只给第 n 层这一个人发」
   * 的定点单层发放（DIRECT/FIXED/CUSTOM 均可），不遍历整条祖先链。
   * ⚠️ target: "ANCESTOR" 时必填：缺失或非法（0 / 负数 / 小数）在计算时抛错，
   * 不兜底取第 1 层；挂在 SOURCE/PARENT 上会被 ruleSetConfigSchema 拒绝。
   * 祖先链长度不足该层时不产生记录（运行期数据，不抛错）。
   * ⚠️ 与 PARENT 一样受 skipRankZero（缺省 true）约束 —— 比例挂在规则上的定点发放
   * 通常应显式写 skipRankZero: false，否则未评级节点会被静默跳过。
   */
  ancestorLevel?: number | null;
  /** 是否跳过最低等级（rankRate <= 0）节点，缺省 true */
  skipRankZero?: boolean;
  /** LEVEL 是否累加到链式水位（极差），缺省 false */
  accumulateInChain?: boolean;
  /**
   * LEVEL 链式发放层数上限（>= 1 的整数）；缺省 null/undefined = 不限层数。
   * 按祖先链位置计数（1 = 最近的祖先），被 diffRate<=0 跳过的层同样占一层。
   * ⚠️ 非法值（0 / 负数 / 小数 / 非数字）在计算时抛错，不静默忽略；
   * 挂在非 LEVEL 类型上会被 ruleSetConfigSchema 拒绝。
   */
  maxDepth?: number | null;
  /**
   * LEVEL 按层固定比例表（百分比整数，索引 0 = 最近的祖先）。
   * 配置后改走「第 n 层拿 levelRates[n-1]」口径：不读 rankRate、不推进水位，
   * 各层相互独立（"一级 10%、二级 5%、三级 3%" 这类多级固定比例分销）。
   * 比例为 0 的层不发放但仍占一层；有效层数 = min(levelRates.length, maxDepth)。
   * ⚠️ 与 accumulateInChain: true 互斥（两套口径发放总额不同），空数组 / 含非法元素 /
   * 全为 0 均抛错；挂在非 LEVEL 类型上会被 ruleSetConfigSchema 拒绝。
   */
  levelRates?: Array<Numeric> | null;
  allocatorId?: string | null;
  conditions?: ConditionLike[];
  metadata?: Record<string, unknown>;
}

/** 等级定义（「谁能拿、拿多少比例」） */
export interface RankDefLike {
  /**
   * 宿主侧等级表主键（`Model.RankDef` 接受 `number | string`）。
   * **可选**：规则集里的 `rankDefs` 形如 `{ rankId, levelIndex, rankRate }`，
   * `ruleSetConfigSchema` 不接受 `id`（未知键），引擎评级也只读
   * `levelIndex` / `conditions` / `rankRate` / `rankId`。
   */
  id?: string | number;
  /** 等级序号；> 0 的等级必须声明晋升门槛，否则 evaluateTier 判为不满足 */
  levelIndex?: number;
  rankId?: string;
  rankRate?: Numeric;
  conditions?: ConditionLike[];
  metadata?: Record<string, unknown>;
}

/** 封顶定义 */
export interface CapDefLike {
  capId?: string;
  scope: CapScope;
  /** 上限（decimal string）；"0" 表示不限制 */
  limit: Numeric;
  onExceed?: CapOnExceed;
}

/** 拆分目标 */
export interface AllocationTargetLike {
  target: string;
  /** 占比（百分比整数）；同一组 targets 之和必须等于 100，否则抛错 */
  ratio: Numeric;
}

/** 引擎产出的候选收益记录 */
export interface RewardRecord {
  nodeId: string;
  rewardId: string;
  rewardType: RewardType;
  amount: DecimalString;
  snapshot: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 待冲正的原始发放记录（宿主从落账表映射而来）。
 * recordId 与 nodeId 都是必填 —— 缺任一项都无法定位"从谁身上追回多少"。
 */
export interface OriginalRewardRecord {
  /** 原始收益记录主键（别名 id 亦可）；用于幂等与 reversedMap 定位 */
  recordId?: string | number;
  id?: string | number;
  /** 受益节点（别名 memberId 亦可） */
  nodeId?: string;
  memberId?: string;
  /** 原始发放金额（正数 decimal string）；负数抛错 */
  amount: Numeric;
  rewardId?: string;
  rewardType?: RewardType;
  /** 冲正记录不可再冲正（会产出正金额 = 凭空发钱），传入即抛错 */
  direction?: string;
  [key: string]: unknown;
}

/**
 * 冲正记录。amount 为**负数**（SUM(amount) 即净发放），reversedAmount 为正数绝对值。
 */
export interface ReversalRecord {
  nodeId: string;
  rewardId?: string;
  rewardType?: RewardType;
  /** 负金额（decimal string），如 "-30" */
  amount: DecimalString;
  /** 本次追回的绝对值（decimal string），如 "30" */
  reversedAmount: DecimalString;
  direction: "REVERSAL";
  originalRecordId: string | number;
  snapshot: {
    reversal: {
      originalRecordId: string | number;
      originalAmount: DecimalString;
      alreadyReversed: DecimalString;
      remainingBefore: DecimalString;
      /** 实际生效的冲正比例（百分比字符串） */
      ratio: DecimalString;
      /** "RATIO"（直接给比例） | "EVENT_VALUE"（按 reversalValue/originalEventValue 推导） */
      basis: "RATIO" | "EVENT_VALUE";
      reversalValue?: DecimalString;
      originalEventValue?: DecimalString;
      /** 仅当被裁剪到剩余额度时出现 */
      clamped?: true;
      reasonCode?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 冲正汇总（对账用） */
export interface ReversalSummary {
  ratio: DecimalString;
  basis: "RATIO" | "EVENT_VALUE";
  /** 实际产出的冲正记录数 */
  recordCount: number;
  /** 跳过的原始记录数（金额为 0 / 已全额冲正） */
  skippedCount: number;
  /** 被裁剪到剩余额度的记录数 */
  clampedCount: number;
  totalOriginal: DecimalString;
  /** 本次追回总额（正数） */
  totalReversed: DecimalString;
}

/**
 * 封顶水位状态。
 * ⚠️ 可变对象：applyCaps 会就地推进水位，重放同一个 state 会重复累计。
 * 跨事件累计需由宿主持久化（见 GenericSettlementService 的 loadCapState/saveCapState）。
 */
export interface CapPeriodBucket {
  /** 该周期内平台累计已发额度 */
  platformPaid: DecimalString;
  /** 该周期内各节点累计已发额度（必须是 Map；普通对象会抛错） */
  memberPaid: Map<string, DecimalString>;
}

export interface CapState extends CapPeriodBucket {
  /**
   * 非 DAILY 周期的水位桶（按需建桶）。DAILY 复用顶层 platformPaid/memberPaid，
   * **不**在此重复存放 —— 同一个数存两处，只持久化一处时会静默半失效（超发方向）。
   * ⚠️ 宿主持久化时需连同 periods 一起存取，否则周/月/活动总量封顶实际不生效。
   */
  periods?: Partial<Record<Exclude<CapPeriod, "DAILY">, CapPeriodBucket>>;
}

/** 流水线阶段定义。config 的形状由 handler 决定。 */
export interface PipelineStage {
  /** 阶段标识（缺省取 handler，作为 results 的键） */
  id?: string;
  handler: StageHandler;
  config?: {
    // DISTRIBUTE
    event?: EventLike;
    /** 事件来源节点对象；仅 target:"SOURCE" + 受益节点侧条件（source:"target"）时必需 */
    sourceNode?: NodeLike | null;
    directParent?: NodeLike | null;
    ancestors?: NodeLike[];
    rewardDefs?: RewardDefLike[];
    /**
     * 多个 DISTRIBUTE 阶段的合并语义。第 2 个及以后的 DISTRIBUTE **必填**，
     * 缺省抛错（静默覆盖会让前序收益记录无声消失）：
     * - "append"  累加到前序记录，多组奖励并存
     * - "replace" 丢弃前序记录，仅保留本阶段产出
     */
    merge?: "append" | "replace";
    // RANK（就地写回 node.rankRate / node.rankId；必须排在 DISTRIBUTE 之前，否则抛错）
    nodes?: NodeLike[];
    rankDefs?: RankDefLike[];
    /** true 时覆盖宿主已预计算的 rankRate，缺省 false */
    overwrite?: boolean;
    // CAMPAIGN（活动期加成；必须排在 DISTRIBUTE 之后、CAP/OVER 之前，每条流水线最多一个）
    campaignDefs?: CampaignDefLike[];
    /** 活动窗口的判定基准 = 事件发生时刻。有 campaignDefs 时必填（引擎不用当前时间兜底） */
    occurredAt?: Instant | null;
    // CAP
    capDefs?: CapDefLike[];
    // OVER
    totalBudget?: Numeric;
    eventValue?: Numeric;
    /** OVER 用 BudgetOnExceed；REVERSE 用 ReversalOnExceed */
    onExceed?: BudgetOnExceed | ReversalOnExceed;
    // REVERSE（冲正；与 DISTRIBUTE 互斥、每条流水线最多一个、必须是首个产出阶段）
    originalRecords?: OriginalRewardRecord[];
    /** 冲正比例（百分比，如 "100" 全额 / "30" 部分）；与 reversalValue 互斥、二者必给其一 */
    ratio?: Numeric;
    /** 本次退款金额；需与 originalEventValue 成对给出 */
    reversalValue?: Numeric;
    /** 原始事件金额；需与 reversalValue 成对给出 */
    originalEventValue?: Numeric;
    /** 各原始记录已冲正累计（key = recordId）；多次部分退款必传 */
    reversedMap?: Map<string | number, Numeric> | Record<string, Numeric> | null;
    /** 冲正原因码，写入 snapshot.reversal.reasonCode */
    reasonCode?: string | null;
    // SPLIT（必须是最后一个阶段）
    totalAmount?: Numeric;
    targets?: AllocationTargetLike[];
    [key: string]: unknown;
  };
}

/** 拆分结果 */
export interface SplitResult {
  splits: Array<{ target: string; amount: DecimalString }>;
  snapshot: Record<string, DecimalString>;
}

/** 流水线执行结果 */
export interface PipelineResult {
  /** 各阶段输出，键为 stage.id（缺省为 handler） */
  results: Record<string, RewardRecord[] | ReversalRecord[] | SplitResult>;
  /** 最后一个阶段的输出 */
  final: RewardRecord[] | ReversalRecord[] | SplitResult | null;
  /** 共享上下文（含 capState、overBudgetWarnings 等） */
  context: {
    capState: CapState;
    overBudgetWarnings?: unknown[];
    /** REVERSE 阶段执行后写入 */
    reversalSummary?: ReversalSummary;
    /** CAMPAIGN 阶段执行后写入 */
    campaignSummary?: CampaignSummary;
    [key: string]: unknown;
  };
}

// ==================== Model — 纯数据模型 ====================

export declare namespace Model {
  class EngineNode implements NodeLike {
    constructor(params: { id: string; parentId?: string | null; rankId?: string; attrs?: Record<string, unknown>; tags?: string[] | Set<string> });
    id: string;
    parentId: string | null;
    rankId: string;
    attrs: Record<string, unknown>;
    /** 构造时统一为 Set（传数组也会转为 Set） */
    tags: Set<string>;
    /** 构造时不产生该字段：需宿主预计算写入，或由 RANK 阶段评级写回 */
    rankRate?: DecimalString;
    [key: string]: unknown;
  }

  class EngineEvent {
    constructor(params: { eventId?: string | null; sourceNodeId: string; eventType?: string; eventValue?: Numeric; attrs?: Record<string, unknown> });
    eventId: string | null;
    sourceNodeId: string;
    eventType: string;
    eventValue: DecimalString;
    attrs: Record<string, unknown>;
  }

  class RewardDef {
    constructor(params: RewardDefLike);
    rewardId: string;
    type: RewardType;
    rate: DecimalString | null;
    fixedAmount: DecimalString | null;
    amount: DecimalString | null;
    amountFrom: string | null;
    target: RewardTarget;
    /** target="ANCESTOR" 的定点层号；构造时 Number() 归一，未配置为 null */
    ancestorLevel: number | null;
    skipRankZero: boolean;
    accumulateInChain: boolean;
    /** LEVEL 链式层数上限；构造时 Number() 归一，未配置为 null */
    maxDepth: number | null;
    /** LEVEL 按层固定比例表；构造时逐项 String() 归一，未配置为 null */
    levelRates: DecimalString[] | null;
    allocatorId: string | null;
    conditions: ConditionLike[];
    metadata: Record<string, unknown>;
  }

  class RankDef {
    constructor(params: RankDefLike);
    id: string;
    levelIndex: number;
    rankId: string;
    /** 原样保留（不做 String() 归一），传数字则为数字 */
    rankRate: Numeric;
    conditions: ConditionLike[];
    metadata: Record<string, unknown>;
  }

  class AllocationTarget {
    constructor(params: AllocationTargetLike);
    target: string;
    ratio: DecimalString;
  }

  class Condition {
    constructor(params?: ConditionLike);
    type: ConditionType;
    field?: string;
    operator?: ComparisonOperator;
    value?: unknown;
    subKey?: string | number;
    source?: ConditionSource;
    children?: ConditionLike[];
  }
}

// ==================== Distribute — 奖励分配 ====================

export declare namespace Distribute {
  /**
   * 遍历 rewardDefs 产出全部候选记录（DIRECT/FIXED/CUSTOM 单条，LEVEL 沿祖先链多条）。
   * target: "ANCESTOR" 的定点单层发放从 ancestors[ancestorLevel - 1] 取目标节点，
   * 记录的 snapshot 带 target: "ANCESTOR" 与 ancestorLevel/depth 层号；
   * 未声明 ancestorLevel 或其值非法时抛错，链长不足该层则不产生记录。
   *
   * rewardDef.conditions 含受益节点侧条件（COMPARE 的 source: "target"）时改为按
   * **受益人**逐个求值：LEVEL 逐层求值（不满足的层不发放、不推进水位、不改变其余层层号），
   * 单受益人原语解析受益节点后求值（PARENT 无上级 / ANCESTOR 链长不足 → 不发，不抛错）。
   * 此时 target: "SOURCE" 的奖励必须传入 sourceNode，否则抛错（不静默按事件求值）。
   */
  function distributeByDefs(params: {
    event: EventLike;
    /** 事件来源节点对象；仅 target:"SOURCE" + 受益节点侧条件时必需 */
    sourceNode?: NodeLike | null;
    directParent?: NodeLike | null;
    ancestors?: NodeLike[];
    rewardDefs?: RewardDefLike[];
  }): RewardRecord[];

  /** 按 eventValue × rate 计算；无目标 / 比例<=0 / 命中 skipRankZero / 金额<=0 → null */
  function calculateDirect(params: {
    rewardDef: RewardDefLike;
    eventValue?: Numeric;
    targetNode?: NodeLike | null;
  }): RewardRecord | null;

  /** 固定金额发放（与 eventValue 无关） */
  function calculateFixed(params: {
    rewardDef: RewardDefLike;
    targetNode?: NodeLike | null;
  }): RewardRecord | null;

  /** 固定金额 + 可选动态取数（amountFrom），取数失败回退 amount */
  function calculateCustom(params: {
    rewardDef: RewardDefLike;
    event?: EventLike | null;
    targetNode?: NodeLike | null;
  }): RewardRecord | null;

  /**
   * 沿祖先链分配。缺省按 rankRate 做水位差（accumulateInChain=true 才累加水位）；
   * 配置 rewardDef.levelRates 时改为「第 n 层拿 levelRates[n-1] 的固定比例」。
   * rewardDef.maxDepth 限制参与计算的祖先层数；非法 maxDepth / levelRates 抛错。
   * 每条记录的 snapshot.depth 为其祖先链层号（1 = 最近的祖先）；
   * 按层固定比例的记录另带 snapshot.mode === "LEVEL_RATES"。
   */
  function calculateLevelChain(params: {
    rewardDef: RewardDefLike;
    eventValue?: Numeric;
    ancestors?: NodeLike[];
    /**
     * 逐层节点过滤器（受益节点侧条件用）。返回 false 的层不发放、**不推进水位**、
     * 也不改变其余层的层号 —— 与 diffRate<=0 跳过完全同一口径。省略 = 全部层参与。
     */
    nodeFilter?: ((node: NodeLike, depth: number) => boolean) | null;
  }): RewardRecord[];
}

// ==================== Evaluate — 等级/条件评估 ====================

export declare namespace Evaluate {
  /**
   * 判断节点是否满足某等级。
   * ⚠️ fail-closed：levelIndex > 0 且既无 conditions 也无遗留 min_* 门槛时判为不满足。
   */
  function evaluateTier(node: NodeLike, tier: RankDefLike): boolean;

  /** 取最高满足的等级（tiers 需按 levelIndex 升序）；无满足项返回 null */
  function getHighestQualifiedTier<T extends RankDefLike>(node: NodeLike, tiers?: T[]): T | null;

  /**
   * 评估单个条件表达式（支持 COMPARE / AND / OR / NOT 嵌套）。
   * COMPARE 声明 source 时从 context 取对应数据源（{ event, target }）；
   * 未声明则对第 2 参 data 求值。source 未知或 context 缺该数据源时抛错
   * （绝不静默回落到另一个数据源 —— 那会把门槛悄悄放行）。
   */
  function evaluateCondition(
    condition: ConditionLike,
    data: Record<string, unknown>,
    context?: { event?: EventLike | null; target?: NodeLike | null } | Record<string, unknown>
  ): boolean;
}

// ==================== Allocate — 封顶/预算/拆分 ====================

export declare namespace Allocate {
  /**
   * 多维封顶裁剪（8 个 scope：PLATFORM/PER_USER × DAILY/WEEKLY/MONTHLY/TOTAL）。
   * 最终金额 = min(原金额, 各生效维度剩余额度)；snapshot.payoutCaps.boundBy 标记实际裁剪它的那一维。
   * ⚠️ 就地推进 state 水位；同一 scope 配多条时取最严（limit 最小）；未知 scope 抛错。
   * ⚠️ 非 DAILY 周期必须由宿主持久化 state.periods 并回传，否则每次调用从 0 起算 = 该封顶不生效。
   * ⚠️ 传入负金额或 direction:"REVERSAL" 的记录会抛错 —— 负金额会反向推进水位、
   *    释放当日已用额度并导致后续发放超发。冲正记录不应流经 CAP / OVER。
   */
  function applyCaps(records: RewardRecord[], capDefs?: CapDefLike[], state?: CapState): RewardRecord[];

  /** 合法封顶 scope 全集（8 个），供宿主配置后台/自建校验引用，避免各自硬编码枚举 */
  const CAP_SCOPES: readonly CapScope[];

  /** 总预算兜底：上限 = eventValue × totalBudget%，超出按 onExceed 处理（CAP 用最大剩余法缩减） */
  function applyBudgetGuard(
    records: RewardRecord[],
    config: { totalBudget: Numeric; eventValue: Numeric; onExceed?: BudgetOnExceed },
    context?: Record<string, unknown>
  ): RewardRecord[];

  /**
   * 活动期加成：命中窗口的记录金额 × 系数（ROUND_DOWN 截断到 4 位）。
   *
   * ⚠️ 必须在封顶/预算裁剪**之前**调用 —— 先裁剪后加成会绕过封顶（limit 100 × 2 = 200）。
   * ⚠️ 同一条记录被多个活动同时命中会**抛错**（相乘 = 数倍超发；静默择一 = 悄悄改钱）。
   * ⚠️ campaignDefs 非空时 occurredAt 必填，缺失抛错 —— 引擎绝不用当前时间兜底，
   *    否则结算重试/补跑历史单会套错活动系数。
   * ⚠️ 传入负金额或 direction:"REVERSAL" 的记录抛错（加成会放大追回金额）。
   *
   * 命中的记录是**新对象**（`snapshot.campaign` 记录对账快照），未命中的原样透传。
   */
  function applyCampaign(
    records: RewardRecord[],
    campaignDefs?: CampaignDefLike[],
    options?: { occurredAt?: Instant | null }
  ): { records: RewardRecord[]; summary: CampaignSummary };

  /**
   * 解析某一时刻生效的活动（可按 rewardId 过滤）；时刻非法抛错而非当作「无活动」。
   *
   * 返回的是**入参里的原始定义对象**（同一引用，按 campaignDefs 顺序），
   * 不是归一化后的副本 —— `multiplier` 保持宿主传入的原类型（数字仍是数字）。
   */
  function resolveActiveCampaigns(
    campaignDefs: CampaignDefLike[],
    occurredAt: Instant,
    options?: { rewardId?: string }
  ): CampaignDefLike[];

  /** 活动系数上限（10）。校验层与计算层同源引用，避免枚举漂移 */
  const CAMPAIGN_MULTIPLIER_MAX: number;

  /** 按比例拆分总额；targets 的 ratio 之和必须等于 100，否则抛错 */
  function splitByTargets(totalAmount: Numeric, targets?: AllocationTargetLike[]): SplitResult;

  /** 按策略比较一组金额 */
  function compareAmounts(
    strategy: "MAX" | "MIN" | "FIRST",
    amounts: Numeric[],
    options?: { defaultValue?: DecimalString }
  ): DecimalString;
}

// ==================== Reverse — 冲正（退款/撤单追回） ====================

export declare namespace Reverse {
  const REVERSAL_DIRECTION: "REVERSAL";

  /**
   * 把原始发放记录按比例反向追回，产出**负金额**的冲正记录。
   *
   * 冲正侧的 fail-closed 方向与发放侧相反：「宁可少追回，不可超额追回」——
   * 超额追回等于凭空扣款。因此：金额按 4 位小数**截断**（ROUND_DOWN）、
   * 引擎不提供缺省比例（默认全额冲正属超额方向）、`ratio` 与
   * `reversalValue/originalEventValue` 互斥且必给其一、缺 recordId/nodeId 抛错、
   * 冲正记录不可再冲正、超出剩余可冲正额度按 onExceed 处理。
   *
   * 已全额冲正的记录不再产出第二条（计算侧幂等）。
   * 产出的记录**不应**流经 CAP / OVER（applyCaps / applyBudgetGuard 会抛错）。
   */
  function reverseRecords(params: {
    originalRecords: OriginalRewardRecord[];
    /** 冲正比例（百分比，0 < ratio <= 100）；与 reversalValue 互斥 */
    ratio?: Numeric;
    /** 本次退款金额（> 0，且不得大于 originalEventValue）；需与 originalEventValue 成对 */
    reversalValue?: Numeric;
    /** 原始事件金额（> 0）；需与 reversalValue 成对 */
    originalEventValue?: Numeric;
    /** 各原始记录已冲正累计（key = recordId）；多次部分退款必传，否则会重复追回 */
    reversedMap?: Map<string | number, Numeric> | Record<string, Numeric> | null;
    /** 缺省 "CLAMP" */
    onExceed?: ReversalOnExceed;
    reasonCode?: string | null;
  }): { records: ReversalRecord[]; summary: ReversalSummary };
}

// ==================== Orchestrate — 流水线编排 ====================

export declare namespace Orchestrate {
  /** 顺序执行阶段；SPLIT 必须是最后一个阶段，CAP/OVER 之前必须有 DISTRIBUTE */
  function executePipeline(params: { stages?: PipelineStage[]; context?: Record<string, unknown> }): PipelineResult;
}

// ==================== Adapters — 规则集适配 ====================

/** 规则集配置（config_json 的形状） */
export interface RuleSetConfig {
  rewardDefs?: RewardDefLike[];
  rankDefs?: RankDefLike[];
  capDefs?: CapDefLike[];
  allocators?: Array<{ allocatorId?: string; targets: AllocationTargetLike[] }>;
  /**
   * 活动期加成。窗口重叠且加成范围相交的两条定义会在**配置期**被拒绝
   * （运行期同时命中会抛错，等于活动一开就全线停发）。
   */
  campaignDefs?: CampaignDefLike[];
  /**
   * 规则集生效期（左闭右开）。事件发生时刻落在窗口外 → 本次**不发放**（少发方向），
   * 而不是静默按原比例继续发（「双十一规则发到十二月」）。
   */
  effective?: TimeWindow;
  /**
   * 缺省 [{handler:"DISTRIBUTE"},{handler:"CAP"}]；
   * 存在 campaignDefs 时缺省为 [DISTRIBUTE, CAMPAIGN, CAP]。
   */
  pipelineDef?: { stages?: Array<{ handler: RuleSetStageHandler; id?: string; config?: Record<string, unknown> }> };
  [key: string]: unknown;
}

export declare namespace Adapters {
  /** 把规则集配置翻译成 executePipeline 可执行的 stages */
  function buildPipelineStages(
    config: RuleSetConfig,
    params: {
      event: EventLike;
      /** 事件来源节点对象；仅 target:"SOURCE" + 受益节点侧条件时必需（不参与 RANK 评级） */
      sourceNode?: NodeLike | null;
      directParent?: NodeLike | null;
      ancestors?: NodeLike[];
      /** 事件发生时刻；配了 campaignDefs 时必需（CAMPAIGN 阶段的判定基准） */
      occurredAt?: Instant | null;
    }
  ): PipelineStage[];

  /**
   * 官方接入模板（纯计算场景）。复制后覆写 4 个 _map/_build 函数即可。
   * 下划线成员是模板实现细节，不是稳定 API。
   */
  namespace customerAdapterTemplate {
    const CUSTOMER_NAME: string;
    const CUSTOMER_VERSION: string;
    /** ⚠️ 无 rankRate 时保持字段 undefined —— 写 "0" 会让 RANK 阶段跳过评级 */
    function _mapMemberToNode(member: Record<string, unknown>): NodeLike;
    function _mapEvent(bizEvent: Record<string, unknown>): EventLike;
    function _buildRankDefs(tierConfigs: Array<Record<string, unknown>>): RankDefLike[];
    function _buildRewardDefs(rewardConfigs: Array<Record<string, unknown>>): RewardDefLike[];
    function executeCustomerIncentive(params: {
      event: Record<string, unknown>;
      directParent?: Record<string, unknown> | null;
      ancestors?: Array<Record<string, unknown>>;
      /** 规则集：顶层字段优先，回退 config_json */
      ruleSet: RuleSetConfig | { config_json?: RuleSetConfig; [key: string]: unknown };
      capState?: CapState | null;
    }): PipelineResult;
  }
}

// ==================== Decimal — 安全金额计算 ====================

/** decimal.js 包装：precision 28、ROUND_HALF_UP，缺省 4 位小数 */
export declare namespace Decimal {
  function mul(a: Numeric, b: Numeric, dp?: number): DecimalString;
  function add(a: Numeric, b: Numeric, dp?: number): DecimalString;
  function sub(a: Numeric, b: Numeric, dp?: number): DecimalString;
  /** ⚠️ 除数为 0 时抛错（不再返回 Infinity/NaN） */
  function div(a: Numeric, b: Numeric, dp?: number): DecimalString;
  function round(value: Numeric, dp?: number): DecimalString;
  /** value × pct%（百分比整数） */
  function pct(value: Numeric, pct: Numeric, dp?: number): DecimalString;
  function gte(a: Numeric, b: Numeric): boolean;
  function gt(a: Numeric, b: Numeric): boolean;
  function lt(a: Numeric, b: Numeric): boolean;
  function lte(a: Numeric, b: Numeric): boolean;
  function eq(a: Numeric, b: Numeric): boolean;
  function min(a: Numeric, b: Numeric): DecimalString;
  function max(a: Numeric, b: Numeric): DecimalString;
  function neg(value: Numeric): DecimalString;
  function toDisplay(value: Numeric, dp?: number): DecimalString;
  function toFixed(value: Numeric, dp?: number): DecimalString;
}

// ==================== Services — 框架服务 ====================

/** 单事件结算结果。所有失败路径均返回 success:false，不抛异常。 */
export interface SettleResult<TRow = unknown> {
  success: boolean;
  data?: { lines: TRow[]; skipped?: boolean };
  message?: string;
  /** true 表示幂等命中（本次未新增落账） */
  idempotent?: boolean;
}

/** 批量结算结果 */
export interface BatchSettleResult<TRow = unknown> {
  success: boolean;
  data?: { results: Array<{ lines: TRow[]; idempotent: boolean }> };
  message?: string;
}

/**
 * 冲正配置块（`SettlementServiceConfig.reversal`）。
 * 不配置时 `reverse()` 返回 `{ success: false }`，`settle()` 行为完全不变。
 */
export interface SettlementReversalConfig<TEvent = Record<string, unknown>, TRow = unknown> {
  /**
   * 读原始发放记录。**在冲正事务内调用**（透传 transaction），
   * 宿主可加行锁 —— 否则并发冲正各自看到旧的"已冲正累计"而超额追回。
   */
  loadOriginalRecords: (
    businessEvent: TEvent,
    ctx: { transaction: unknown; options?: Record<string, unknown> }
  ) => Promise<unknown[]>;
  /** 落账行 → 引擎侧原始记录；返回 null 表示排除该行 */
  buildOriginalRecord: (row: unknown, businessEvent: TEvent) => OriginalRewardRecord | null;
  /**
   * 解析本次冲正比例。引擎**不提供缺省值**：
   * 返回 `{ ratio }` 或 `{ reversalValue, originalEventValue }`（可选 onExceed / reasonCode）。
   */
  resolveReversal: (businessEvent: TEvent) => {
    ratio?: Numeric;
    reversalValue?: Numeric;
    originalEventValue?: Numeric;
    onExceed?: ReversalOnExceed;
    reasonCode?: string | null;
  };
  /** 冲正记录 → 落账行；返回 null 表示丢弃该条 */
  buildRecord: (
    businessEvent: TEvent,
    reversalRecord: ReversalRecord,
    extra?: Record<string, unknown>
  ) => Record<string, unknown> | null;
  /**
   * 冲正专属幂等键（通常按**退款单号**，不要复用发放侧的订单号）——
   * 复用会把同一订单的第二次部分退款误判为幂等命中而静默不追回。
   */
  idempotency: {
    buildPreReadWhere: (event: TEvent) => Record<string, unknown>;
    buildFallbackWhere: (event: TEvent) => Record<string, unknown>;
  };
  /**
   * 读各原始记录的已冲正累计（key = recordId）。
   * **多次部分退款场景必配**，否则每次都按原始全额算比例，累计会超额追回。
   */
  loadReversedMap?: (
    businessEvent: TEvent,
    ctx: { transaction: unknown }
  ) => Promise<Map<string | number, Numeric> | Record<string, Numeric> | null>;
  /**
   * 冲正落账后的钩子。**独立于发放侧 postProcess**（不会复用）——
   * 复用会把冲正行当作新增发放计入宿主累计/业绩统计（重复计数）。
   */
  postProcess?: (businessEvent: TEvent, createdRecords: TRow[], transaction: unknown) => Promise<void>;
}

/** 冲正结果 */
export interface ReverseResult<TRow = unknown> {
  success: boolean;
  data?: {
    lines: TRow[];
    summary?: ReversalSummary | null;
    /** 无可冲正记录 / 已全额冲正 / buildRecord 全过滤：不落账 */
    skipped?: boolean;
  };
  message?: string;
  idempotent?: boolean;
}

/** GenericSettlementService 配置 */
export interface SettlementServiceConfig<TEvent = Record<string, unknown>, TRow = unknown> {
  /** 服务名（日志标识） */
  name: string;
  /** 默认规则集编码 */
  ruleSetCode: string;
  /** Sequelize Model（落账表） */
  model: Record<string, unknown>;
  /** Sequelize 实例（必需） */
  sequelize: Record<string, unknown>;
  /** 规则集服务，需有 getActiveRuleSet；返回信封 { success, data: { config_json } } */
  ruleSetService: { getActiveRuleSet: (...args: unknown[]) => Promise<{ success: boolean; data?: { config_json?: RuleSetConfig } }> };
  buildEvent: (event: TEvent) => EventLike;
  buildDirectParent?: (event: TEvent) => NodeLike | null;
  buildAncestors?: (event: TEvent) => NodeLike[];
  /** 事件来源节点对象；仅 target:"SOURCE" + 受益节点侧条件（source:"target"）时必需 */
  buildSourceNode?: (event: TEvent) => NodeLike | null;
  /**
   * 事件**发生时刻**构造钩子（缺省读 `event.occurredAt`）。
   * 仅当规则集带时间维度（`effective` 生效期 / `campaignDefs` 活动加成）时必需 ——
   * 取不到时结算返回 `{ success:false }`，引擎不会用当前时间兜底
   * （结算重试/补跑历史单会因此套错活动系数）。返回 `Date` 或带偏移量的 ISO-8601。
   */
  buildOccurredAt?: (event: TEvent) => Instant | null;
  /** 引擎记录 → 落账行；返回 null 表示丢弃该条 */
  buildRecord: (businessEvent: TEvent, engineRecord: RewardRecord, extra?: Record<string, unknown>) => Record<string, unknown> | null;
  idempotency: {
    buildPreReadWhere: (event: TEvent) => Record<string, unknown>;
    buildFallbackWhere: (event: TEvent) => Record<string, unknown>;
  };
  postProcess?: (businessEvent: TEvent, createdRecords: TRow[], transaction: unknown) => Promise<void>;
  /**
   * 封顶水位加载钩子（与 saveCapState 成对配置）。
   * 不配置时每次结算水位从零开始 —— 日封顶只在单个事件内生效。
   * ⚠️ 规则集含非 DAILY 周期封顶（_WEEKLY/_MONTHLY/_TOTAL）时必须成对配置，
   * 否则结算返回 { success:false }；还原时需连同 capState.periods 一起（memberPaid 还原成 Map）。
   */
  loadCapState?: (options?: Record<string, unknown>) => Promise<CapState | null>;
  /** 封顶水位持久化钩子；在结算事务内调用，与落账原子提交 */
  saveCapState?: (capState: CapState, transaction: unknown) => Promise<void>;
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  /** true 时用 model.bulkCreate 批量插入（缺省 false：逐条 create） */
  useBulkCreate?: boolean;
  /** 宿主注入的 sequelize UniqueConstraintError 类（file:/npm 安装下解析不到宿主 node_modules 时需要） */
  UniqueConstraintError?: new (...args: never[]) => Error;
  /** 冲正（退款/撤单追回）配置块；配置后 reverse() 可用 */
  reversal?: SettlementReversalConfig<TEvent, TRow>;
}

export declare namespace Services {
  const REQUIRED_CONFIG_KEYS: readonly string[];

  class GenericSettlementService<TEvent = Record<string, unknown>, TRow = unknown> {
    constructor(config: SettlementServiceConfig<TEvent, TRow>);
    name: string;
    ruleSetCode: string;
    useBulkCreate: boolean;

    /** 自管事务的完整结算（幂等快路径在事务外） */
    settle(businessEvent: TEvent, options?: { ruleSetCode?: string; [key: string]: unknown }): Promise<SettleResult<TRow>>;

    /** 委托模式：调用方已持有事务 */
    settleWithTransaction(
      businessEvent: TEvent,
      transaction: unknown,
      options?: { ruleSetCode?: string; [key: string]: unknown }
    ): Promise<SettleResult<TRow>>;

    /** 批量结算，同一事务原子提交；失败返回 success:false（事务已回滚，零落账） */
    batchSettle(events: TEvent[], options?: { ruleSetCode?: string; [key: string]: unknown }): Promise<BatchSettleResult<TRow>>;

    list(params?: {
      page?: number;
      pageSize?: number;
      where?: Record<string, unknown>;
      order?: unknown[];
    }): Promise<{ list: TRow[]; pagination: { page: number; pageSize: number; total: number } }>;

    /**
     * 冲正（退款/撤单追回）。需配置 `config.reversal`，否则返回 `{ success: false }`。
     *
     * 与 settle 的三处差异：计算在**事务内**（冲正金额依赖 DB 现值，宿主可在
     * loadOriginalRecords 里加行锁）、幂等键用 `reversal.idempotency`（通常按退款单号）、
     * **不回退封顶水位**（回退会退还当日已用额度，给"下单发佣→退款→再下单"留出套利空间）。
     *
     * 找不到可冲正的原始记录属正常运行期情况：返回 `{ success: true, data: { skipped: true } }`。
     */
    reverse(businessEvent: TEvent, options?: Record<string, unknown>): Promise<ReverseResult<TRow>>;

    /** 按条件查单条；where 为空时抛错（防止 findOne({}) 返回任意行） */
    getByWhere(where: Record<string, unknown>): Promise<TRow | null>;
  }
}

// ==================== Validation — 配置校验 ====================

export declare namespace Validation {
  /** 传入宿主的 joi 实例，返回一组 schema 与唯一性校验器（joi 为可选 peer，故用工厂注入） */
  function createRuleSetValidation(Joi: unknown): {
    pctRateSchema: unknown;
    nonNegativeSchema: unknown;
    rewardDefSchema: unknown;
    conditionSchema: unknown;
    rewardConditionTreeSchema: unknown;
    rankConditionTreeSchema: unknown;
    rankDefSchema: unknown;
    capDefSchema: unknown;
    allocatorSchema: unknown;
    pipelineStageConfigSchema: unknown;
    pipelineStageSchema: unknown;
    pipelineDefSchema: unknown;
    ruleSetConfigSchema: unknown;
    /** Joi custom 校验器：(arr, helpers) => arr | helpers.error(...) */
    validateRewardIdUniqueness: (arr: RewardDefLike[], helpers: { error: (code: string, ctx?: Record<string, unknown>) => unknown }) => unknown;
    validateRankIdUniqueness: (arr: RankDefLike[], helpers: { error: (code: string, ctx?: Record<string, unknown>) => unknown }) => unknown;
    validateCapIdUniqueness: (arr: CapDefLike[], helpers: { error: (code: string, ctx?: Record<string, unknown>) => unknown }) => unknown;
    engineEventPreviewSchema: unknown;
  };

  /** 校验 GenericSettlementService 的客户配置对象 */
  function validateCustomerConfig(
    config: Record<string, unknown>,
    useJoi?: boolean
  ): { valid: boolean; errors?: string[]; warnings?: string[] };

  /** 引擎配置字段键名常量（单一事实来源，供消费方 diff/遍历引用） */
  const CONFIG_FIELD_KEYS: Readonly<{
    REWARD_DEFS: "rewardDefs";
    RANK_DEFS: "rankDefs";
    CAP_DEFS: "capDefs";
    ALLOCATORS: "allocators";
    PIPELINE_DEF: "pipelineDef";
    REWARD_ID: "rewardId";
    RANK_ID: "rankId";
    CAP_ID: "capId";
    TYPE: "type";
    TARGET: "target";
    RATE: "rate";
    FIXED_AMOUNT: "fixedAmount";
    AMOUNT: "amount";
    AMOUNT_FROM: "amountFrom";
    MAX_DEPTH: "maxDepth";
    LEVEL_RATES: "levelRates";
    ANCESTOR_LEVEL: "ancestorLevel";
    LEVEL_INDEX: "levelIndex";
    SCOPE: "scope";
    LIMIT: "limit";
  }>;
}

// ==================== Utils — 工具函数 ====================

/** 灰度版本项 */
export interface GrayscaleVersion {
  version: string;
  /** 权重（整数，同一配置内之和应为 100） */
  weight?: number;
  config_json?: RuleSetConfig;
  [key: string]: unknown;
}

export declare namespace Utils {
  /** 按 routingKey 的 md5 分桶选版本；未启用/无版本时返回 null */
  function selectVersionByRoutingKey(
    grayscaleConfig: { enabled?: boolean; versions?: GrayscaleVersion[] } | null,
    routingKey: string
  ): GrayscaleVersion | null;

  /** 校验灰度权重之和是否为 100 */
  function validateGrayscaleWeights(grayscaleConfig: { versions?: GrayscaleVersion[] } | null): boolean;

  /** 分页参数归一（pageSize 上限 100） */
  function normalizePagination(
    page?: number | string,
    pageSize?: number | string,
    opts?: { maxPageSize?: number; defaultPageSize?: number }
  ): { page: number; pageSize: number; offset: number };

  /** 取指定时区下的日期字符串 YYYY-MM-DD */
  function formatDateInTimezone(date: Date | string, timezone: string): string;

  /**
   * 在 YYYY-MM-DD 上加减天数，返回 YYYY-MM-DD（用于 T+N 业务日期）。
   * 纯 UTC 日期算术，跨夏令时结果与时区无关。
   * 注意：按自然日计算，**不跳过周末/节假日**。
   */
  function addBusinessDays(dateStr: string, days: number): string;

  /** 天数差 = dateB - dateA（两端均为 YYYY-MM-DD，可为负） */
  function dateDiff(dateA: string, dateB: string): number;

  /**
   * 解析绝对时刻 → epoch 毫秒。只接受 `Date` 实例或**带时区偏移量**的 ISO-8601；
   * 无偏移字符串、纯日期、数字时间戳一律抛错（见 Instant 的说明）。
   */
  function parseInstant(label: string, value: Instant): number;

  /**
   * 判定时刻是否落在窗口内，**左闭右开** `[startAt, endAt)`。
   * `endAt <= startAt` 抛错（空窗口/反向窗口永不命中 = 整段规则静默失效）。
   */
  function isWithinWindow(window: TimeWindow, occurredAt: Instant, label?: string): boolean;
}

/* ============================================================================
 * 默认导出（v4.1.0 新增，纯增量）
 * ==========================================================================*/

/**
 * 引擎默认导出 —— 与 CJS `module.exports` 的形状**一一对应**。
 *
 * 为什么需要它：
 * 本文件原先只有具名导出（`export declare namespace X`），没有 `export default`
 * 也没有 `export =`。打包型消费方以 `import engine from "@usethink/incentive-engine"`
 * 方式引入时（`esModuleInterop` + `moduleResolution: bundler`）拿不到类型，
 * 只能各自手写 `declare module` 兜底 —— 手写声明与真实导出一旦漂移，
 * TS 不会报错，错误会一直潜伏到运行时（曾造成消费方奖励静默不发放）。
 *
 * ⚠️ 不能用 `export =`：`export =` 无法与本文件已有的具名导出共存，
 * 改成 `export =` 会破坏所有 `import { Distribute } from ...` 的存量用法。
 *
 * ⚠️ 维护约束：本对象的键必须与 `src/index.js` 的 `module.exports` 完全一致。
 * 新增/删除顶层子模块时，必须同步改这里（`npm test` 有形状契约测试兜底）。
 */
declare const engine: {
  Model: typeof Model;
  Distribute: typeof Distribute;
  Evaluate: typeof Evaluate;
  Allocate: typeof Allocate;
  Orchestrate: typeof Orchestrate;
  Reverse: typeof Reverse;
  Adapters: typeof Adapters;
  Decimal: typeof Decimal;
  Services: typeof Services;
  Validation: typeof Validation;
  Utils: typeof Utils;
};

export default engine;
