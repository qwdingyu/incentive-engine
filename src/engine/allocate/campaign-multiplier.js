/**
 * 活动期加成 — 通用纯计算，无外部依赖
 *
 * 领域无关的「限时活动系数」原语：在已产出的收益记录上乘一个活动系数
 * （双十一佣金翻倍、开业首周 1.5 倍、限时冲榜加成）。
 *
 * 为什么必须由引擎提供而不是宿主自己乘：
 * 加成系数直接放大发放金额，宿主各自实现会在三处口径分叉 ——
 * ① 加成在封顶**之前**还是之后（放在之后等于绕过封顶，日限额形同虚设）；
 * ② 两个活动窗口重叠时是相乘还是取一个（相乘 = 静默数倍超发）；
 * ③ 精度方向（四舍五入 vs 截断）。三类分叉的出错方向都是**超发**。
 *
 * 资金安全（fail-closed，与发放侧同源「宁可少发，不可超发」）：
 * - 加成金额一律 **ROUND_DOWN**（截断到 4 位小数）。
 * - 时刻由宿主显式提供，引擎**绝不调用 `Date.now()`**：结算重试、补跑昨天的单、
 *   对账重算都会在活动窗口之外执行，用「当前时刻」判定等于给历史订单套上今天的系数。
 * - 时间窗口只接受**无歧义的绝对时刻**（Date / 带偏移量 ISO-8601），
 *   `startAt`/`endAt` 都必填，左闭右开 `[startAt, endAt)`（见 utils/instant-window.js）。
 * - 同一条记录被**多个活动同时命中 → 抛错**（相乘会数倍超发，静默择一等于悄悄改钱）。
 *   静态可判的窗口重叠已由 `Validation` 在配置期拦截，此处是运行期兜底。
 * - `multiplier` 必须落在 `0 < multiplier <= CAMPAIGN_MULTIPLIER_MAX`：
 *   把「100%（即不加成）」误写成 `multiplier: 100` 是最容易犯的一类配置错误，
 *   无上限会直接放大 100 倍。系数是**倍数**不是百分比。
 * - 负金额 / `direction:"REVERSAL"` 的记录**抛错**：对冲正记录加成会放大追回金额
 *   （从用户账上多扣钱），且加成阶段本就只应作用于发放侧。
 *
 * @version 1.0.0
 */

const Dec = require("decimal.js");

/** 金额精度：与 src/decimal.js 包装层一致（4 位小数）。 */
const AMOUNT_DP = 4;
/**
 * 活动系数上限（倍数，不是百分比）。
 *
 * 上限的意义：`multiplier: 100` 这类「误把倍数写成百分比」的笔误会被当场拒绝，
 * 而不是把发放额放大 100 倍。分佣场景的真实活动系数通常在 1~3 之间。
 */
const CAMPAIGN_MULTIPLIER_MAX = 10;
/** 冲正记录的方向标记（与 reverse/reversal-calculator.js 同值）。 */
const REVERSAL_DIRECTION = "REVERSAL";

const { isWithinWindow, parseInstant } = require("../../utils/instant-window");

/**
 * 校验单条活动定义并返回归一化结果（非法值一律抛错，不静默跳过）。
 * @param {Object} def - 活动定义
 * @param {number} i - 下标（错误定位用）
 * @returns {Object} { campaignId, multiplier: Dec, rewardIds: Array<string>|null, startAt, endAt }
 */
function _normalizeDef(def, i) {
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    throw new Error(`applyCampaign：campaignDefs[${i}] 必须是对象`);
  }
  const campaignId = def.campaignId;
  if (campaignId === undefined || campaignId === null || campaignId === "") {
    throw new Error(`applyCampaign：campaignDefs[${i}] 缺少 campaignId（对账与重叠告警的定位键）`);
  }
  let mul;
  try {
    mul = new Dec(def.multiplier);
  } catch (e) {
    mul = new Dec(NaN);
  }
  if (mul.isNaN() || !mul.isFinite() || !mul.gt(0) || mul.gt(CAMPAIGN_MULTIPLIER_MAX)) {
    throw new Error(
      `applyCampaign：活动 "${campaignId}" 的 multiplier 必须是 0 < multiplier <= ${CAMPAIGN_MULTIPLIER_MAX} 的**倍数**` +
      `（收到 ${JSON.stringify(def.multiplier)}）—— 2 表示翻倍、1.5 表示 1.5 倍；` +
      "不加成请写 1。它不是百分比：写 100 会把发放额放大 100 倍，因此设有上限。"
    );
  }
  // rewardIds：限定本活动只加成哪些奖励项；不写（或 null）= 全部奖励。
  // 空数组是「谁都不加成」，与「不写」语义冲突，属配置错误 → 抛错。
  let rewardIds = null;
  if (def.rewardIds !== undefined && def.rewardIds !== null) {
    if (!Array.isArray(def.rewardIds) || def.rewardIds.length === 0) {
      throw new Error(
        `applyCampaign：活动 "${campaignId}" 的 rewardIds 必须是非空数组（限定加成范围），` +
        "不限定请直接省略该字段 —— 空数组等于「谁都不加成」，与省略的语义相反"
      );
    }
    rewardIds = def.rewardIds.map((r) => String(r));
  }
  return {
    campaignId: String(campaignId),
    multiplier: mul,
    rewardIds,
    startAt: def.startAt,
    endAt: def.endAt,
  };
}

/**
 * 解析在某个时刻生效的活动（可按 rewardId 过滤）
 *
 * 供宿主做「当前是否翻倍中」展示与规则集预览试算；`applyCampaign` 内部同源使用。
 *
 * @param {Array<Object>} campaignDefs - 活动定义列表
 *        `{ campaignId, startAt, endAt, multiplier, rewardIds? }`
 * @param {Date|string} occurredAt - 判定时刻（宿主提供，引擎不取当前时间）
 * @param {Object} [opts]
 * @param {string} [opts.rewardId] - 只返回作用于该奖励项的活动（不传则不按奖励过滤）
 * @returns {Array<Object>} 命中的活动（原始定义对象，按 campaignDefs 顺序）
 * @throws {Error} 活动定义非法 / 时刻非法
 */
function resolveActiveCampaigns(campaignDefs, occurredAt, { rewardId } = {}) {
  if (!Array.isArray(campaignDefs)) {
    throw new Error(`resolveActiveCampaigns：campaignDefs 必须是数组（收到 ${typeof campaignDefs}）`);
  }
  if (campaignDefs.length === 0) return [];
  // 时刻先解析一次：非法时刻必须抛错，绝不当作「没有活动」放行
  // （那会让加成静默失效，方向上是少发，但同样是配置错误被吞掉）。
  parseInstant("resolveActiveCampaigns 的 occurredAt", occurredAt);

  const hits = [];
  campaignDefs.forEach((def, i) => {
    const norm = _normalizeDef(def, i);
    if (rewardId !== undefined && norm.rewardIds && !norm.rewardIds.includes(String(rewardId))) {
      return;
    }
    if (isWithinWindow({ startAt: norm.startAt, endAt: norm.endAt }, occurredAt, `活动 "${norm.campaignId}" 的窗口`)) {
      hits.push(def);
    }
  });
  return hits;
}

/**
 * 按活动系数放大收益记录（通用纯计算，不修改入参记录）
 *
 * 必须排在 **CAP / OVER 之前**：加成后的金额才应受封顶与总预算约束。
 * 排在之后等于让活动金额绕过日限额（`Orchestrate.executePipeline` 会拦截这种顺序）。
 *
 * @param {Array<Object>} records - 收益记录（`{ rewardId, nodeId, amount, snapshot? }`）
 * @param {Array<Object>} campaignDefs - 活动定义列表；**空数组表示当前无活动**，
 *        原样返回记录（不抛错：活动结束后规则集仍保留 CAMPAIGN 阶段是正常运维状态）。
 *        非数组（漏传）抛错。
 * @param {Object} params
 * @param {Date|string} params.occurredAt - 事件发生时刻（宿主提供；引擎不取当前时间）
 * @returns {Object} { records, summary }
 *          records: 新数组；命中活动的记录是**新对象**（`amount` 已加成，
 *                   `snapshot.campaign` 带对账快照），未命中的记录原样透传。
 *          summary: { occurredAt, activeCampaignIds, boostedCount, untouchedCount,
 *                     totalBefore, totalAfter, byCampaign }
 * @throws {Error} 入参非法 / 活动定义非法 / 时刻缺失或非法 / 一条记录被多个活动命中 /
 *                 记录为负金额或冲正记录
 */
function applyCampaign(records, campaignDefs, { occurredAt } = {}) {
  if (!Array.isArray(records)) {
    throw new Error(`applyCampaign：records 必须是数组（收到 ${typeof records}）`);
  }
  if (!Array.isArray(campaignDefs)) {
    throw new Error(
      `applyCampaign：campaignDefs 必须是数组（收到 ${typeof campaignDefs}）` +
      " —— 当前无活动请传空数组，漏传会让加成静默失效"
    );
  }
  const out = [];
  let boostedCount = 0;
  let totalBefore = new Dec("0");
  let totalAfter = new Dec("0");
  const byCampaign = {};
  const activeIds = new Set();

  // 无活动定义：原样返回（不需要 occurredAt —— 没有窗口要判定）。
  const hasDefs = campaignDefs.length > 0;
  const occurredIso = hasDefs
    ? new Date(parseInstant("applyCampaign 的 occurredAt（事件发生时刻，须由宿主提供）", occurredAt)).toISOString()
    : null;
  // 活动定义先整体校验一遍：配错的活动即使当前不在窗口内也要当场暴露，
  // 否则等到活动开始那一刻才抛错（最不该出问题的时点）。
  const normalized = hasDefs ? campaignDefs.map((d, i) => _normalizeDef(d, i)) : [];

  records.forEach((rec, i) => {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      throw new Error(`applyCampaign：records[${i}] 必须是对象`);
    }
    // 加成只作用于发放侧：放大冲正记录等于多扣用户的钱。
    if (rec.direction === REVERSAL_DIRECTION) {
      throw new Error(
        `applyCampaign：records[${i}] 是冲正记录（direction="${REVERSAL_DIRECTION}"），不能参与活动加成` +
        " —— 那会放大追回金额（从用户账上多扣钱）。加成阶段只作用于发放记录。"
      );
    }
    let amount;
    try {
      amount = new Dec(rec.amount);
    } catch (e) {
      amount = new Dec(NaN);
    }
    if (amount.isNaN() || !amount.isFinite()) {
      throw new Error(`applyCampaign：records[${i}] 的 amount 不是合法数值（收到 ${JSON.stringify(rec.amount)}）`);
    }
    if (amount.lt(0)) {
      throw new Error(
        `applyCampaign：records[${i}] 金额为负 (${amount.toString()})，疑似把冲正记录混入发放批次` +
        " —— 对负金额加成会放大追回金额"
      );
    }
    totalBefore = totalBefore.plus(amount);

    if (!hasDefs) {
      totalAfter = totalAfter.plus(amount);
      out.push(rec);
      return;
    }

    // 命中判定：按记录的 rewardId 过滤 rewardIds 限定范围，再判窗口。
    const matched = normalized.filter((def) => {
      if (def.rewardIds && !def.rewardIds.includes(String(rec.rewardId))) return false;
      return isWithinWindow(
        { startAt: def.startAt, endAt: def.endAt },
        occurredAt,
        `活动 "${def.campaignId}" 的窗口`
      );
    });

    if (matched.length === 0) {
      totalAfter = totalAfter.plus(amount);
      out.push(rec);
      return;
    }
    // 多活动同时命中 → 抛错：相乘是数倍超发，静默取一条等于悄悄改变发放金额。
    if (matched.length > 1) {
      throw new Error(
        `applyCampaign：记录（rewardId=${rec.rewardId}, nodeId=${rec.nodeId}）在 ${occurredIso} 同时命中 ` +
        `${matched.length} 个活动（${matched.map((m) => `${m.campaignId}×${m.multiplier.toString()}`).join(", ")}）：` +
        "多个系数相乘会数倍超发，静默取其一等于悄悄改变发放金额。" +
        "请调整活动窗口或用 rewardIds 把加成范围拆开（配置期校验也会拦截静态重叠的窗口）。"
      );
    }

    const def = matched[0];
    // 加成后金额向下截断：宁可少发 0.0001，不可多发 0.0001。
    const boosted = amount.mul(def.multiplier).toDecimalPlaces(AMOUNT_DP, Dec.ROUND_DOWN);
    boostedCount += 1;
    activeIds.add(def.campaignId);
    totalAfter = totalAfter.plus(boosted);
    const agg = byCampaign[def.campaignId] || { count: 0, before: new Dec("0"), after: new Dec("0") };
    agg.count += 1;
    agg.before = agg.before.plus(amount);
    agg.after = agg.after.plus(boosted);
    byCampaign[def.campaignId] = agg;

    // 不修改入参记录：返回新对象（宿主可能持有原记录用于对比/日志）。
    out.push({
      ...rec,
      amount: boosted.toString(),
      snapshot: {
        ...(rec.snapshot || {}),
        campaign: {
          campaignId: def.campaignId,
          multiplier: def.multiplier.toString(),
          originalAmount: amount.toString(),
          boostedAmount: boosted.toString(),
          occurredAt: occurredIso,
          window: { startAt: String(def.startAt), endAt: String(def.endAt) },
          ...(def.rewardIds ? { rewardIds: def.rewardIds } : {}),
        },
      },
    });
  });

  const byCampaignOut = {};
  for (const [cid, agg] of Object.entries(byCampaign)) {
    byCampaignOut[cid] = {
      count: agg.count,
      totalBefore: agg.before.toDecimalPlaces(AMOUNT_DP, Dec.ROUND_DOWN).toString(),
      totalAfter: agg.after.toDecimalPlaces(AMOUNT_DP, Dec.ROUND_DOWN).toString(),
    };
  }
  return {
    records: out,
    summary: {
      occurredAt: occurredIso,
      activeCampaignIds: [...activeIds],
      boostedCount,
      untouchedCount: out.length - boostedCount,
      totalBefore: totalBefore.toDecimalPlaces(AMOUNT_DP, Dec.ROUND_DOWN).toString(),
      totalAfter: totalAfter.toDecimalPlaces(AMOUNT_DP, Dec.ROUND_DOWN).toString(),
      byCampaign: byCampaignOut,
    },
  };
}

module.exports = { applyCampaign, resolveActiveCampaigns, CAMPAIGN_MULTIPLIER_MAX };
