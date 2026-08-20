/**
 * 封顶控制器 — 通用纯计算，无外部依赖
 *
 * 领域无关的多维封顶裁剪：capDefs 数组驱动，每个 capDef 声明
 * scope（`<维度>_<周期>`，维度 PLATFORM/PER_USER × 周期 DAILY/WEEKLY/MONTHLY/TOTAL）
 * 与 limit（上限），引擎遍历 capDefs 逐维裁剪，最终金额 = min(原金额, 各维剩余额度)。
 * 任意客户通过配置声明自己的封顶维度，引擎不内置任何业务口径。
 *
 * ⚠️ 引擎**不认识日期**（见 CAP_PERIODS 注释）：周期边界由宿主的水位行生命周期决定，
 * 引擎只负责「各周期分桶独立记账 + 逐维取最严裁剪 + 把推进后的水位交回宿主」。
 *
 * v2.2.0 新增：applyBudgetGuard — 总预算兜底保护，防止配错比例导致超发。
 * v2.3.0 新增：applyCaps / applyBudgetGuard 拒绝冲正（负金额）记录 —— 冲正记录流经
 * 封顶阶段会反向推进水位、释放当日已用额度，导致后续发放超发（见 _assertNoReversal）。
 * v2.4.0 新增：WEEKLY / MONTHLY / TOTAL 三个封顶周期（8 个 scope 全组合），
 * 水位 state 扩展出 `periods[PERIOD]` 分桶（DAILY 仍复用顶层字段，向后兼容）。
 *
 * @version 2.4.0
 */

const Decimal = require("../../decimal");

/**
 * 防线：封顶/预算阶段拒绝冲正（负金额）记录
 *
 * 冲正记录（`Reverse.reverseRecords` 产出，`amount` 为负、`direction："REVERSAL"`）
 * 一旦流入 applyCaps，负金额会被累加进水位 state —— 平台/单用户当日已发额度被"退还"，
 * 后续发放据此重新获得额度，最终当日实际发放超过 limit（超发）。
 * 同理 applyBudgetGuard 的总额会被负金额拉低，掩盖真实超发。
 *
 * 因此冲正记录**不应流经 CAP/OVER 阶段**；这里当场抛错而非静默放行。
 * （封顶水位是否随冲正回退是宿主的业务决策：默认不回退最安全 —— 回退会释放当日预算，
 *  给"下单发佣→退款→再下单"的套利留出空间。需要回退的宿主应自行在 saveCapState 里处理。）
 *
 * @param {string} fnName - 调用方函数名（错误信息定位用）
 * @param {Array<Object>} records - 待检查记录
 * @throws {Error} 存在负金额或 direction="REVERSAL" 的记录
 */
function _assertNoReversal(fnName, records) {
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const isReversal = r.direction === "REVERSAL";
    const isNegative = r.amount !== undefined && r.amount !== null && Decimal.lt(r.amount, "0");
    if (isReversal || isNegative) {
      throw new Error(
        `${fnName}：不接受冲正/负金额记录（nodeId=${r.nodeId ?? r.memberId ?? "?"}, amount=${r.amount}）—— ` +
        "负金额会反向推进封顶水位、释放当日已用额度并导致后续发放超发。" +
        "冲正记录（Reverse.reverseRecords 产出）不应流经 CAP / OVER 阶段。"
      );
    }
  }
}

/** 封顶维度：PLATFORM = 平台总量（当期所有受益人合计）；PER_USER = 单个受益节点。 */
const CAP_DIMENSIONS = ["PLATFORM", "PER_USER"];

/**
 * 封顶周期：DAILY / WEEKLY / MONTHLY / TOTAL
 *
 * ⚠️ **引擎不认识日期**：它既不知道"今天"，也不会自己算周一或月初。
 * 周期语义完全由宿主的水位行生命周期决定 —— `PLATFORM_DAILY` 之所以是"日"封顶，
 * 是因为宿主的水位表按业务日期分行、跨天自然从 0 起算。因此：
 * - `WEEKLY` / `MONTHLY`：宿主按 `biz_week` / `biz_month` 分行存水位；
 * - `TOTAL`：不按自然周期归零的累计（**活动总量** / 生命周期总量）——
 *   宿主按活动号分行存水位，活动结束即弃用该行。这就是"活动总量封顶"
 *   （CAMPAIGN_TOTAL）的领域无关表达：引擎不认识"活动"，只认识"这条水位一直不归零"。
 *
 * 引擎负责的是：各周期水位**分桶独立记账**、逐维取最严裁剪、把推进后的水位交回宿主。
 * 所以非 DAILY 封顶**必须**成对配置 `loadCapState` / `saveCapState`（否则每次结算都从 0
 * 起算，月封顶实际退化成单事件封顶 —— 给出虚假的额度保证，比不配更危险）；
 * `GenericSettlementService` 在构造期就拦下这种配置。
 */
const CAP_PERIODS = ["DAILY", "WEEKLY", "MONTHLY", "TOTAL"];

/** 合法封顶 scope = `<维度>_<周期>` 全组合（8 个）。 */
const CAP_SCOPES = CAP_DIMENSIONS.flatMap((d) => CAP_PERIODS.map((p) => `${d}_${p}`));

/**
 * 拆分 scope 为维度与周期（`PER_USER_MONTHLY` → PER_USER + MONTHLY）
 * @param {string} scope - 合法 scope（调用前已校验）
 * @returns {{dimension: string, period: string}}
 */
function _splitScope(scope) {
  const i = scope.lastIndexOf("_");
  return { dimension: scope.slice(0, i), period: scope.slice(i + 1) };
}

/**
 * 取某周期的水位桶（唯一真源，按需建桶）
 *
 * DAILY 复用 state 顶层的 `platformPaid` / `memberPaid`（3.4.x 起的既有形状，向后兼容），
 * 其余周期放在 `state.periods[PERIOD]`。DAILY **不**在 periods 里再存一份 ——
 * 同一个数存两处，宿主只持久化其中一处时会静默半失效（水位偏低 = 超发方向）。
 *
 * @param {Object} state - 封顶水位状态（会被就地写入）
 * @param {string} period - CAP_PERIODS 之一
 * @returns {Object} { platformPaid, memberPaid }
 */
function _getPeriodBucket(state, period) {
  if (period === "DAILY") return state;
  if (!state.periods || typeof state.periods !== "object") state.periods = {};
  if (!state.periods[period]) state.periods[period] = { platformPaid: "0", memberPaid: new Map() };
  return state.periods[period];
}

/**
 * 取桶内 memberPaid Map（用于推进水位；缺失时按需创建）
 * @param {Object} bucket - 水位桶
 * @param {string} period - 周期（错误信息定位用）
 * @returns {Map} memberPaid
 * @throws {Error} memberPaid 存在但不是 Map
 */
function _memberMap(bucket, period) {
  const m = bucket.memberPaid;
  if (m instanceof Map) return m;
  if (m === undefined || m === null) {
    bucket.memberPaid = new Map();
    return bucket.memberPaid;
  }
  throw new Error(
    `applyCaps：${period} 周期的 memberPaid 必须是 Map（收到 ${typeof m}）—— ` +
    "loadCapState 从库里还原时请用 new Map(Object.entries(json))；" +
    "普通对象会让 .get 取不到值、单用户封顶按 0 重新开闸（超发方向）。"
  );
}

/**
 * 读取单用户已发额度（用于 PER_USER 维度裁剪）
 *
 * 配了 PER_USER 封顶却拿不到 memberPaid Map 时**抛错**而非按 0 起算 ——
 * 按 0 起算等于额度重新开闸，方向上是超发。
 *
 * @param {Object} bucket - 水位桶
 * @param {string} period - 周期（错误信息定位用）
 * @param {string|number} nodeId - 受益节点
 * @returns {string} 已发额度（decimal string）
 */
function _memberPaidOf(bucket, period, nodeId) {
  if (!(bucket.memberPaid instanceof Map)) {
    throw new Error(
      `applyCaps：配置了 PER_USER_${period} 封顶，但水位 state 里缺少可用的 memberPaid Map ` +
      `（收到 ${bucket.memberPaid === undefined ? "undefined" : typeof bucket.memberPaid}）—— ` +
      "请在 loadCapState 里还原成 Map；缺失时按 0 起算会让单用户封顶失效并超发。"
    );
  }
  return bucket.memberPaid.get(nodeId) || "0";
}

/**
 * 按封顶定义列表裁剪候选收益记录（通用纯计算）
 *
 * 注意：裁剪后直接推进水位 state，确保同一批次内后续订单不会超发。
 * state 是外部传入的可变对象，调用方需确保单线程内的水位一致性。
 *
 * @param {Array<Object>} records - 候选收益记录（含 nodeId/memberId、amount、snapshot?）
 * @param {Array<Object>} capDefs - 封顶定义
 *        [{ capId, scope, limit, onExceed? }]
 *        scope：`<维度>_<周期>`，维度 PLATFORM/PER_USER × 周期 DAILY/WEEKLY/MONTHLY/TOTAL
 *        （8 个合法值，见 CAP_SCOPES）。未知 scope 抛错（防止配错被当作「无此维度」静默放行而超发）。
 *        limit 为 decimal string；0 表示不限制。
 *        onExceed："REJECT"（缺省，裁剪超出部分）| "ALERT_ONLY"（不裁剪，仅在 snapshot 标记 alertOnly）。
 *        同一 scope 配置多条时取最严（limit 最小）的一条。
 * @param {Object} state - 封顶水位状态：
 *        `{ platformPaid, memberPaid: Map }` 为 **DAILY** 桶（历史形状，向后兼容）；
 *        其余周期在 `state.periods[PERIOD] = { platformPaid, memberPaid: Map }`（按需建桶）。
 *        ⚠️ 非 DAILY 周期若不由宿主持久化并回传，每次调用都从 0 起算 = 该封顶实际不生效。
 * @returns {Array<Object>} 裁剪后的收益记录（附加 snapshot.payoutCaps 快照）
 * @throws {Error} 未知 scope / 存在冲正（负金额）记录 / 配了 PER_USER 封顶但水位缺 memberPaid Map
 */
function applyCaps(records, capDefs = [], state = { platformPaid: "0", memberPaid: new Map() }) {
  const cappedRecords = [];

  // 资金安全：冲正（负金额）记录不得进入封顶阶段（否则反向推进水位 → 后续超发）。
  _assertNoReversal("applyCaps", records);

  // 资金安全（P1-1）：解析封顶定义前先校验 scope 合法性。
  // 未知 scope 必须抛错而非静默放行 —— 否则配置写错 scope（如 PER_USER_MONTHLI）
  // 会被当作「无此维度封顶」而完全不裁剪，直接超发。
  // 注意：capDefSchema 的 scope 枚举已在校验期拦截，但 applyCaps 是纯计算路径，
  // 可能绕过 Validation 直接调用，因此运行时也必须防御。
  for (const c of capDefs) {
    if (!CAP_SCOPES.includes(c.scope)) {
      throw new Error(
        `applyCaps：未知封顶 scope "${c.scope}"（支持: ${CAP_SCOPES.join(", ")}）`
      );
    }
  }

  // 预解析有效封顶：limit>0 才参与裁剪。
  // 资金安全（P1-1）：同 scope 多条时取【最严】（limit 最小）而非第一条 ——
  // 否则更严的第二条会被静默忽略（如 limit:1000 在前、limit:100 在后，实际按 1000 封顶）。
  // 取最严是 fail-safe 方向：宁可少发，不可超发。
  // 遍历顺序固定为 CAP_SCOPES（平台各周期 → 单用户各周期），保证 boundBy 与 ALERT_ONLY
  // 的判定可复现；最终金额与顺序无关（恒等于 min(原金额, 各维剩余额度)）。
  const effective = [];
  for (const scope of CAP_SCOPES) {
    const matched = capDefs.filter((c) => c.scope === scope && Decimal.gt(c.limit, "0"));
    if (!matched.length) continue;
    const strictest = matched.reduce((a, b) => (Decimal.lte(a.limit, b.limit) ? a : b));
    effective.push({
      scope,
      ..._splitScope(scope),
      limit: String(strictest.limit),
      // onExceed 语义：REJECT（默认）= 超出裁剪；ALERT_ONLY = 超出不裁剪、保留原金额，仅记录告警标记。
      onExceed: strictest.onExceed || "REJECT",
    });
  }

  // 参与水位记账的周期：DAILY 始终参与（向后兼容 —— 既有行为是无论是否配置封顶都推进日水位）；
  // 其余周期仅在本次配置了该周期封顶时才建桶推进，避免给宿主 saveCapState 塞进它没准备存的桶。
  const accountedPeriods = [
    "DAILY",
    ...CAP_PERIODS.filter((p) => p !== "DAILY" && effective.some((e) => e.period === p)),
  ];

  // legacy 快照字段：保持既有对账口径不变（老宿主仍读这两个字段）。
  const dailyPlatformPayoutCap = effective.find((e) => e.scope === "PLATFORM_DAILY")?.limit ?? "0";
  const memberDailyYieldCap = effective.find((e) => e.scope === "PER_USER_DAILY")?.limit ?? "0";
  // 全部生效封顶的 limit 表（多周期对账用）。
  const limits = {};
  for (const e of effective) limits[e.scope] = e.limit;

  for (const record of records) {
    const nodeId = record.nodeId ?? record.memberId;
    let allowedAmount = record.amount;
    let boundBy = null;
    const alertOnlyScopes = [];

    for (const cap of effective) {
      const bucket = _getPeriodBucket(state, cap.period);
      const paid = cap.dimension === "PLATFORM"
        ? (bucket.platformPaid || "0")
        : _memberPaidOf(bucket, cap.period, nodeId);
      const remaining = Decimal.sub(cap.limit, paid);
      // 资金安全（P1-1）：恰好用尽剩余额度（allowedAmount == remaining）不算超发，
      // 应正常发放而非标记 ALERT_ONLY。故用 lte（<=）而非 lt（<）判断「未超限」。
      if (Decimal.lte(allowedAmount, remaining)) continue;
      if (cap.onExceed === "ALERT_ONLY") {
        // ALERT_ONLY：超限不裁剪，保留原金额，标记告警
        alertOnlyScopes.push(cap.scope);
        continue;
      }
      // REJECT（默认）：裁剪到剩余额度。只会变小，因此最后一次裁剪它的 scope 即最严的一维。
      allowedAmount = Decimal.min(allowedAmount, remaining);
      boundBy = cap.scope;
    }

    // 没有剩余额度的记录直接丢弃，不写 0 金额收益，避免对账报表出现无意义流水。
    if (Decimal.lte(allowedAmount, "0")) continue;

    // 裁剪金额后附加封顶快照。
    const cappedRecord = { ...record, amount: allowedAmount };
    cappedRecord.snapshot = {
      ...(cappedRecord.snapshot || {}),
      payoutCaps: {
        dailyPlatformPayoutCap,
        memberDailyYieldCap,
        originalAmount: record.amount,
        cappedAmount: allowedAmount,
        ...(effective.length ? { limits } : {}),
        // 实际决定本条金额的那一维（多周期并存时的对账关键）
        ...(boundBy ? { boundBy } : {}),
        // ALERT_ONLY 超发告警标记：运营可据此识别"超发但保留"的记录
        ...(alertOnlyScopes.length
          ? { alertOnly: true, onExceed: "ALERT_ONLY", alertOnlyScopes }
          : {}),
      },
    };
    cappedRecords.push(cappedRecord);

    // 裁剪后立即推进水位，保证同一批次内后续记录看到最新已发额度。
    for (const period of accountedPeriods) {
      const bucket = _getPeriodBucket(state, period);
      bucket.platformPaid = Decimal.add(bucket.platformPaid || "0", allowedAmount);
      const memberPaid = _memberMap(bucket, period);
      memberPaid.set(nodeId, Decimal.add(memberPaid.get(nodeId) || "0", allowedAmount));
    }
  }

  return cappedRecords;
}

/**
 * 总预算兜底保护 — 防止配错比例导致超发（通用纯计算，无外部依赖）
 *
 * 在 DISTRIBUTE 阶段完成后调用，检查所有候选记录的总金额是否超过预算上限。
 * 预算上限 = eventValue × totalBudget / 100，其中 totalBudget 为百分比整数。
 *
 * 三种超发行为：
 * - CAP：按比例缩减每条记录金额（总金额压缩到上限以内），保留所有条目的相对比例关系
 * - WARN：仅向 context 写入警告信息，不修改金额，继续执行
 * - REJECT：抛出错误，终止后续处理
 *
 * @param {Array<Object>} records - 候选收益记录（每条含 amount 字段，decimal string）
 * @param {Object} config - 预算配置
 * @param {string} config.totalBudget - 总预算比例（百分比整数，如 "200" 表示 eventValue 的 200%）
 * @param {string} config.eventValue - 事件金额（decimal string，作为 budget 计算基准）
 * @param {string} [config.onExceed="CAP"] - 超发行为：CAP | WARN | REJECT
 * @param {Object} [context={}] - 共享上下文，WARN 行为写入 context.overBudgetWarnings
 * @returns {Array<Object>} 处理后的记录列表
 * @throws {Error} 当 onExceed=REJECT 且超发时
 */
function applyBudgetGuard(records, config, context = {}) {
  if (!records || records.length === 0) return records;
  // 资金安全：冲正（负金额）记录会把总额拉低，掩盖真实超发 —— 先拒绝再判断配置。
  _assertNoReversal("applyBudgetGuard", records);
  if (!config || !config.totalBudget || !config.eventValue) return records;

  const totalBudget = String(config.totalBudget);
  const eventValue = String(config.eventValue);
  const onExceed = config.onExceed || "CAP";

  // 计算所有候选记录的总金额
  let totalAmount = "0";
  for (const r of records) {
    totalAmount = Decimal.add(totalAmount, r.amount || "0");
  }

  // 计算预算上限：eventValue × totalBudget / 100
  const budgetLimit = Decimal.pct(eventValue, totalBudget);

  // 未超发，直接返回
  if (Decimal.lte(totalAmount, budgetLimit)) {
    return records;
  }

  // 超发处理
  const overAmount = Decimal.sub(totalAmount, budgetLimit);
  const VALID_ON_EXCEED = ["CAP", "WARN", "REJECT"];

  if (onExceed === "REJECT") {
    throw new Error(
      `总预算超发：总金额 ${totalAmount} > 预算上限 ${budgetLimit}（${totalBudget}% × ${eventValue}），超发 ${overAmount}`
    );
  }

  if (onExceed === "WARN") {
    const warning = {
      totalAmount,
      budgetLimit,
      totalBudget,
      overAmount,
      eventValue,
      recordCount: records.length,
    };
    if (!context.overBudgetWarnings) context.overBudgetWarnings = [];
    context.overBudgetWarnings.push(warning);
    return records;
  }

  if (onExceed === "CAP") {
    // 按比例缩减，保留相对比例关系。
    // 精度处理：包装层 mul/div 默认四舍五入到 4 位，直接用会产生累积误差，
    // 导致缩减后求和 > 预算上限（系统性超发）。因此用裸 decimal.js 全精度计算
    // + 「最大剩余法」：按比例取 4 位 floor，再把差额按余数从大到小分配给
    // 余数最大的前 N 条（每条 +0.0001），保证缩减后求和精确等于预算上限。
    const Dec = require("decimal.js"); // 全精度计算（包装层 4 位精度不足，最大剩余法需精确比例）
    const ratio = new Dec(budgetLimit).div(new Dec(totalAmount));
    const pow4 = new Dec("10000");
    const unit = new Dec("0.0001");

    // 1) 每条按比例取 4 位小数（向下取整）
    const floors = records.map((r) => {
      const exact = new Dec(r.amount || "0").mul(ratio);
      return exact.mul(pow4).floor().div(pow4);
    });
    // 2) 计算差额（预算上限 - sum(floor)），以最小单位计
    let floorSum = new Dec("0");
    for (const f of floors) floorSum = floorSum.plus(f);
    const remainderUnits = new Dec(budgetLimit).sub(floorSum).div(unit).toNumber();
    // 3) 按余数从大到小排序记录索引（余数相同保持原顺序，保证确定性）
    const remainderOrder = records.map((r, i) => {
      const exact = new Dec(r.amount || "0").mul(ratio);
      const frac = exact.sub(floors[i]);
      return { i, frac };
    }).sort((a, b) => {
      if (b.frac.gt(a.frac)) return 1;
      if (b.frac.lt(a.frac)) return -1;
      return a.i - b.i;
    });
    // 4) 把差额逐条 +0.0001 分配给余数最大的记录，其余保持 floor
    const bumpSet = new Set(remainderOrder.slice(0, remainderUnits).map((e) => e.i));
    const result = records.map((r, i) => {
      const cappedAmount = bumpSet.has(i) ? floors[i].plus(unit) : floors[i];
      return {
        ...r,
        amount: cappedAmount.toString(),
        snapshot: {
          ...(r.snapshot || {}),
          overBudget: {
            originalAmount: r.amount,
            cappedAmount: cappedAmount.toString(),
            totalAmount,
            budgetLimit,
            ratio: Decimal.round(Decimal.mul(ratio.toString(), "100"), 4) + "%",
          },
        },
      };
    });
    return result;
  }

  // 未知 onExceed 值
  throw new Error(
    `applyBudgetGuard 未知 onExceed 值: "${onExceed}"（支持: CAP, WARN, REJECT）`
  );
}

module.exports = { applyCaps, applyBudgetGuard, CAP_SCOPES, CAP_DIMENSIONS, CAP_PERIODS };
