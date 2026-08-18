/**
 * 封顶控制器 — 通用纯计算，无外部依赖
 *
 * 领域无关的多维封顶裁剪：capDefs 数组驱动，每个 capDef 声明
 * scope（PLATFORM_DAILY 平台日封顶 / PER_USER_DAILY 单用户日封顶）与 limit（上限），
 * 引擎遍历 capDefs 逐维裁剪。任意客户通过配置声明自己的封顶维度。
 * 松茸平台/会员日封顶适配见 src/adapters/songrong-reward-adapter.js。
 *
 * v2.2.0 新增：applyBudgetGuard — 总预算兜底保护，防止配错比例导致超发。
 *
 * @version 2.2.0
 */

const Decimal = require("../../decimal");

/**
 * 按封顶定义列表裁剪候选收益记录（通用纯计算）
 *
 * 注意：裁剪后直接推进水位 state，确保同一批次内后续订单不会超发。
 * state 是外部传入的可变对象，调用方需确保单线程内的水位一致性。
 *
 * @param {Array<Object>} records - 候选收益记录（含 nodeId/memberId、amount、snapshot?）
 * @param {Array<Object>} capDefs - 封顶定义
 *        [{ capId, scope: "PLATFORM_DAILY"|"PER_USER_DAILY", limit, onExceed? }]
 *        limit 为 decimal string；0 表示不限制；onExceed 一期仅支持 REJECT（丢弃超出）
 * @param {Object} state - 封顶水位状态（platformPaid + memberPaid Map）
 * @returns {Array<Object>} 裁剪后的收益记录（附加 snapshot.payoutCaps 快照）
 */
function applyCaps(records, capDefs = [], state = { platformPaid: "0", memberPaid: new Map() }) {
  const cappedRecords = [];

  // 预解析有效封顶：limit>0 才参与裁剪。
  const platformCap = capDefs.find((c) => c.scope === "PLATFORM_DAILY" && Decimal.gt(c.limit, "0"));
  const memberCap = capDefs.find((c) => c.scope === "PER_USER_DAILY" && Decimal.gt(c.limit, "0"));
  const dailyPlatformPayoutCap = platformCap ? String(platformCap.limit) : "0";
  const memberDailyYieldCap = memberCap ? String(memberCap.limit) : "0";
  // onExceed 语义：REJECT（默认）= 超出丢弃；ALERT_ONLY = 超出不裁剪、保留原金额，仅记录告警标记。
  // 此前 applyCaps 完全不读取 onExceed，ALERT_ONLY 配置被静默当作 REJECT 处理（资金行为错误）。
  const platformOnExceed = platformCap?.onExceed || "REJECT";
  const memberOnExceed = memberCap?.onExceed || "REJECT";

  for (const record of records) {
    let allowedAmount = record.amount;
    let alertOnly = false;

    // 平台日封顶先裁剪：平台水位代表当天所有接收人的累计发放额。
    if (Decimal.gt(dailyPlatformPayoutCap, "0")) {
      const platformRemaining = Decimal.sub(dailyPlatformPayoutCap, state.platformPaid || "0");
      if (Decimal.lt(allowedAmount, platformRemaining)) {
        // 未超限，正常
      } else if (platformOnExceed === "ALERT_ONLY") {
        // ALERT_ONLY：超限不裁剪，保留原金额，标记告警
        alertOnly = true;
      } else {
        // REJECT（默认）：裁剪到剩余额度
        allowedAmount = Decimal.min(allowedAmount, platformRemaining);
      }
    }

    // 单用户日封顶再裁剪：同一节点可同时拿多类收益，必须合并计算当天额度。
    if (Decimal.gt(memberDailyYieldCap, "0")) {
      const nodeId = record.nodeId ?? record.memberId;
      const memberPaid = state.memberPaid.get(nodeId) || "0";
      const memberRemaining = Decimal.sub(memberDailyYieldCap, memberPaid);
      if (Decimal.lt(allowedAmount, memberRemaining)) {
        // 未超限，正常
      } else if (memberOnExceed === "ALERT_ONLY") {
        // ALERT_ONLY：超限不裁剪，保留原金额，标记告警
        alertOnly = true;
      } else {
        // REJECT（默认）：裁剪到剩余额度
        allowedAmount = Decimal.min(allowedAmount, memberRemaining);
      }
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
        // ALERT_ONLY 超发告警标记：运营可据此识别"超发但保留"的记录
        ...(alertOnly ? { alertOnly: true, onExceed: "ALERT_ONLY" } : {}),
      },
    };
    cappedRecords.push(cappedRecord);

    // 裁剪后立即推进水位，保证同一批次内后续记录看到最新已发额度。
    state.platformPaid = Decimal.add(state.platformPaid || "0", allowedAmount);
    const nodeId = record.nodeId ?? record.memberId;
    const currentMemberPaid = state.memberPaid.get(nodeId) || "0";
    state.memberPaid.set(nodeId, Decimal.add(currentMemberPaid, allowedAmount));
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
    // 按比例缩减，保留相对比例关系
    const ratio = Decimal.div(budgetLimit, totalAmount);
    return records.map((r) => {
      const newAmount = Decimal.mul(r.amount || "0", ratio);
      return {
        ...r,
        amount: newAmount,
        snapshot: {
          ...(r.snapshot || {}),
          overBudget: {
            originalAmount: r.amount,
            cappedAmount: newAmount,
            totalAmount,
            budgetLimit,
            ratio: Decimal.round(Decimal.mul(ratio, "100"), 4) + "%",
          },
        },
      };
    });
  }

  // 未知 onExceed 值
  throw new Error(
    `applyBudgetGuard 未知 onExceed 值: "${onExceed}"（支持: CAP, WARN, REJECT）`
  );
}

module.exports = { applyCaps, applyBudgetGuard };
