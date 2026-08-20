/**
 * 冲正计算器 — 通用纯计算，无外部依赖
 *
 * 领域无关的「已发放收益反向追回」原语：输入宿主从自己库里还原的**原始收益记录**
 * 与本次冲正比例，输出对应的冲正记录（负金额）。引擎不查库、不认识订单/退款/佣金，
 * 「哪些记录属于这笔退款」「已冲正多少」全部由宿主以入参提供。
 *
 * 为什么必须由引擎提供而不是宿主自己反向记账：
 * 退款/撤单场景下「按比例追回」涉及金额精度、累计不超额、重复冲正幂等三类资金约束，
 * 宿主各自实现必然出现口径分叉（部分退款按订单比例还是按剩余额度、四舍五入方向、
 * 重复回调是否二次扣款），而这些错误的方向是**超额扣款**——直接从用户账上多扣钱。
 *
 * 资金安全（fail-closed，本模块的方向与发放侧相反但同源）：
 * - 发放侧「宁可少发，不可超发」；冲正侧「宁可少追回，不可超额追回」——
 *   超额追回等于凭空扣款，比少追回严重得多。因此金额一律 **ROUND_DOWN**（截断到 4 位）。
 * - 冲正比例**没有缺省值**：不传 ratio 也不传 reversalValue 直接抛错，绝不默认 100%
 *   （默认全额追回是「多扣」方向）。
 * - 累计冲正额**永不超过原始发放额**：`onExceed:"CLAMP"`（缺省）裁剪到剩余可冲正额度
 *   并在 snapshot 标记 `clamped`；`onExceed:"REJECT"` 抛错。
 * - 已全额冲正的记录**不再产出第二条**（重复冲正幂等的计算侧保障）。
 * - 传入负金额 / `direction:"REVERSAL"` 的记录直接抛错 —— 冲正一条冲正记录会得到
 *   正金额「反向发钱」，那是最危险的一类静默错误。
 *
 * @version 1.0.0
 */

const Dec = require("decimal.js");

/** 冲正记录的方向标记：CAP/OVER 阶段据此拒绝负金额记录流入（防止反向推进封顶水位）。 */
const REVERSAL_DIRECTION = "REVERSAL";
/** 金额精度：与 src/decimal.js 包装层一致（4 位小数）。 */
const AMOUNT_DP = 4;
/** 超额冲正处理策略。 */
const VALID_ON_EXCEED = ["CLAMP", "REJECT"];

/**
 * 把入参转为 decimal.js 实例，非法值抛错（不静默按 0 处理）。
 * @param {string} label - 字段名（错误信息定位用）
 * @param {*} value - 待转换值
 * @returns {Dec} decimal 实例
 */
function _toDec(label, value) {
  let d;
  try {
    d = new Dec(value);
  } catch (e) {
    throw new Error(`reverseRecords：${label} 不是合法数值（收到 ${JSON.stringify(value)}）`);
  }
  if (d.isNaN() || !d.isFinite()) {
    throw new Error(`reverseRecords：${label} 不是合法数值（收到 ${JSON.stringify(value)}）`);
  }
  return d;
}

/**
 * 解析冲正比例：ratio 与 (reversalValue + originalEventValue) 二选一，且必须恰好一种。
 *
 * @param {Object} params - 见 reverseRecords
 * @returns {Object} { ratio: Dec（0~1 的小数）, ratioPct: string（百分比）, basis, reversalValue?, originalEventValue? }
 */
function _resolveRatio({ ratio, reversalValue, originalEventValue }) {
  const hasRatio = ratio !== undefined && ratio !== null && ratio !== "";
  const hasValue = reversalValue !== undefined && reversalValue !== null && reversalValue !== "";

  // 两种口径并存 → 抛错：静默择一等于悄悄改变追回金额。
  if (hasRatio && hasValue) {
    throw new Error(
      "reverseRecords：ratio 与 reversalValue 互斥，只能提供一种冲正比例口径" +
      "（ratio 直接给百分比；reversalValue + originalEventValue 按金额占比推导）"
    );
  }
  // 都不提供 → 抛错：绝不默认 100% 全额冲正（那是「多扣」方向的兜底）。
  if (!hasRatio && !hasValue) {
    throw new Error(
      "reverseRecords：必须提供冲正比例 —— ratio（百分比，如 \"100\" 全额、\"30\" 部分）" +
      "或 reversalValue + originalEventValue（按金额占比推导）。" +
      "引擎不提供缺省值：默认全额冲正属于「超额追回」方向，配漏了等于凭空多扣款。"
    );
  }

  if (hasRatio) {
    const r = _toDec("ratio", ratio);
    if (!r.gt(0) || r.gt(100)) {
      throw new Error(`reverseRecords：ratio 必须是 0 < ratio <= 100 的百分比（收到 ${JSON.stringify(ratio)}）`);
    }
    return { ratio: r.div(100), ratioPct: r.toString(), basis: "RATIO" };
  }

  const rv = _toDec("reversalValue", reversalValue);
  const ov = _toDec("originalEventValue", originalEventValue);
  if (!rv.gt(0)) {
    throw new Error(`reverseRecords：reversalValue 必须大于 0（收到 ${JSON.stringify(reversalValue)}）`);
  }
  if (!ov.gt(0)) {
    throw new Error(
      `reverseRecords：originalEventValue 必须大于 0（收到 ${JSON.stringify(originalEventValue)}）` +
      " —— 按金额占比冲正必须提供原始事件金额作为分母"
    );
  }
  // 冲正金额大于原始事件金额 → 比例 > 100%，会追回超过已发放额度：数据错误，抛错。
  if (rv.gt(ov)) {
    throw new Error(
      `reverseRecords：reversalValue (${rv.toString()}) 大于 originalEventValue (${ov.toString()})，` +
      "冲正比例会超过 100% 导致超额追回"
    );
  }
  const exact = rv.div(ov);
  return {
    ratio: exact,
    // 百分比展示值截断到 10 位（仅供对账阅读，实际计算用全精度 ratio）
    ratioPct: exact.mul(100).toDecimalPlaces(10, Dec.ROUND_DOWN).toString(),
    basis: "EVENT_VALUE",
    reversalValue: rv.toString(),
    originalEventValue: ov.toString(),
  };
}

/**
 * 从「已冲正累计」映射里取某条原始记录的已冲正金额（支持 Map 与普通对象）。
 * @param {Map|Object|null} reversedMap - recordId → 已冲正累计金额（正数）
 * @param {string} recordId - 原始记录标识
 * @returns {*} 已冲正金额（未命中返回 "0"）
 */
function _getAlreadyReversed(reversedMap, recordId) {
  if (!reversedMap) return "0";
  if (typeof reversedMap.get === "function") {
    return reversedMap.get(recordId) ?? "0";
  }
  return reversedMap[recordId] ?? "0";
}

/**
 * 按比例冲正一批已发放收益记录（通用纯计算）
 *
 * @param {Object} params
 * @param {Array<Object>} params.originalRecords - 宿主从自己库里还原的原始收益记录。
 *        每条必须含 `recordId`（或 `id`，落库主键，冲正累计与对账的唯一键）、
 *        `nodeId`（或 `memberId`，从谁那里追回）、`amount`（原始发放金额，非负）。
 *        `rewardId` / `rewardType` 会原样透传到冲正记录。
 *        **空数组返回空结果不抛错**（订单本来就没发过佣金是正常运行期情况）；
 *        但非数组（漏传）抛错 —— 静默返回空等于「所有退款都不追回」。
 * @param {string|number} [params.ratio] - 冲正比例（百分比，0 < ratio <= 100）。与 reversalValue 互斥。
 * @param {string|number} [params.reversalValue] - 本次冲正的事件金额（如退款 300）。需与 originalEventValue 配对。
 * @param {string|number} [params.originalEventValue] - 原始事件金额（如订单 1000），作为比例分母。
 * @param {Map|Object} [params.reversedMap] - recordId → 已冲正累计金额（正数）。
 *        **不传视为全部未冲正**：多次部分冲正场景下不传会导致累计追回超过原始发放额，
 *        必须由宿主提供（见 README「冲正」小节）。
 * @param {string} [params.onExceed="CLAMP"] - 本次冲正额超过剩余可冲正额度时：
 *        "CLAMP"（缺省）裁剪到剩余额度并标记 snapshot.reversal.clamped；"REJECT" 抛错。
 * @param {string} [params.reasonCode] - 冲正原因码（透传到 snapshot，便于对账）。
 * @returns {Object} { records, summary }
 *          records: 冲正记录数组，`amount` 为**负数** decimal string（SUM(amount) 即净发放），
 *                   `reversedAmount` 为正数绝对值，`direction: "REVERSAL"`。
 *          summary: { ratio, basis, recordCount, skippedCount, clampedCount, totalOriginal, totalReversed }
 * @throws {Error} 入参非法 / 冲正比例缺失或冲突 / 原始记录缺关键字段 / onExceed=REJECT 且超额
 */
function reverseRecords({
  originalRecords,
  ratio,
  reversalValue,
  originalEventValue,
  reversedMap = null,
  onExceed = "CLAMP",
  reasonCode = null,
} = {}) {
  // 漏传 originalRecords 是集成错误：静默返回空 = 所有退款都不追回（资金损失且无告警）。
  if (!Array.isArray(originalRecords)) {
    throw new Error(
      `reverseRecords：originalRecords 必须是数组（收到 ${typeof originalRecords}）` +
      " —— 原始收益记录由宿主从自己库里还原后传入，引擎不查库"
    );
  }
  if (!VALID_ON_EXCEED.includes(onExceed)) {
    throw new Error(`reverseRecords：未知 onExceed "${onExceed}"（支持: ${VALID_ON_EXCEED.join(", ")}）`);
  }

  const { ratio: ratioDec, ratioPct, basis, ...basisExtra } = _resolveRatio({
    ratio,
    reversalValue,
    originalEventValue,
  });

  const records = [];
  let skippedCount = 0;
  let clampedCount = 0;
  let totalOriginal = new Dec("0");
  let totalReversed = new Dec("0");

  originalRecords.forEach((rec, i) => {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      throw new Error(`reverseRecords：originalRecords[${i}] 必须是对象`);
    }
    // 冲正记录不可再被冲正：负金额 × 比例 = 正金额，会变成「反向发钱」。
    if (rec.direction === REVERSAL_DIRECTION) {
      throw new Error(
        `reverseRecords：originalRecords[${i}] 已是冲正记录（direction="${REVERSAL_DIRECTION}"），` +
        "不能对冲正记录再冲正（那会产出正金额，等于凭空发钱）。请只传入原始发放记录。"
      );
    }
    // recordId 必填：它是「已冲正累计」的查找键，缺失会让累计不超额约束静默失效。
    const recordId = rec.recordId ?? rec.id;
    if (recordId === undefined || recordId === null || recordId === "") {
      throw new Error(
        `reverseRecords：originalRecords[${i}] 缺少 recordId（或 id）` +
        " —— 它是「已冲正累计」的查找键与对账主键，缺失会让「累计冲正不超过原额」的约束失效"
      );
    }
    const nodeId = rec.nodeId ?? rec.memberId;
    if (nodeId === undefined || nodeId === null || nodeId === "") {
      throw new Error(`reverseRecords：originalRecords[${i}]（recordId=${recordId}）缺少 nodeId（从谁那里追回）`);
    }

    const originalAmount = _toDec(`originalRecords[${i}].amount`, rec.amount);
    if (originalAmount.lt(0)) {
      throw new Error(
        `reverseRecords：originalRecords[${i}]（recordId=${recordId}）金额为负 (${originalAmount.toString()})，` +
        "疑似把冲正记录当作原始发放记录传入 —— 对负金额冲正会产出正金额（反向发钱）"
      );
    }
    totalOriginal = totalOriginal.plus(originalAmount);

    // 原额为 0 的记录无可追回（引擎本身不产出 0 元记录，此处防御宿主数据）。
    if (originalAmount.isZero()) {
      skippedCount += 1;
      return;
    }

    const already = _toDec(`reversedMap["${recordId}"]`, _getAlreadyReversed(reversedMap, recordId));
    if (already.lt(0)) {
      throw new Error(`reverseRecords：reversedMap["${recordId}"] 已冲正金额不能为负（收到 ${already.toString()}）`);
    }
    const remaining = originalAmount.minus(already);
    // 已全额（或超额）冲正 → 不再产出记录：重复冲正幂等的计算侧保障。
    if (remaining.lte(0)) {
      skippedCount += 1;
      return;
    }

    // 追回金额一律向下截断（ROUND_DOWN）：宁可少追回 0.0001，不可多扣 0.0001。
    let want = originalAmount.mul(ratioDec).toDecimalPlaces(AMOUNT_DP, Dec.ROUND_DOWN);
    let clamped = false;
    if (want.gt(remaining)) {
      if (onExceed === "REJECT") {
        throw new Error(
          `reverseRecords：recordId=${recordId} 本次冲正 ${want.toString()} 超过剩余可冲正额度 ` +
          `${remaining.toString()}（原额 ${originalAmount.toString()} − 已冲正 ${already.toString()}），` +
          "onExceed=\"REJECT\" 拒绝超额追回"
        );
      }
      want = remaining;
      clamped = true;
      clampedCount += 1;
    }
    // 比例过小导致截断为 0 → 不写 0 元流水（与 applyCaps 丢弃 0 元记录同口径）。
    if (want.lte(0)) {
      skippedCount += 1;
      return;
    }

    totalReversed = totalReversed.plus(want);
    records.push({
      nodeId,
      rewardId: rec.rewardId,
      rewardType: rec.rewardType,
      // 负金额：宿主 SUM(amount) 即净发放额，无需 CASE WHEN。
      amount: want.neg().toString(),
      // 正数绝对值：偏好「正数金额 + 方向列」记账的宿主直接用这个字段。
      reversedAmount: want.toString(),
      direction: REVERSAL_DIRECTION,
      originalRecordId: recordId,
      snapshot: {
        reversal: {
          originalRecordId: recordId,
          originalAmount: originalAmount.toString(),
          alreadyReversed: already.toString(),
          remainingBefore: remaining.toString(),
          ratio: ratioPct,
          basis,
          ...basisExtra,
          ...(clamped ? { clamped: true } : {}),
          ...(reasonCode ? { reasonCode } : {}),
        },
      },
    });
  });

  return {
    records,
    summary: {
      ratio: ratioPct,
      basis,
      recordCount: records.length,
      skippedCount,
      clampedCount,
      totalOriginal: totalOriginal.toDecimalPlaces(AMOUNT_DP, Dec.ROUND_DOWN).toString(),
      totalReversed: totalReversed.toDecimalPlaces(AMOUNT_DP, Dec.ROUND_DOWN).toString(),
    },
  };
}

module.exports = { reverseRecords, REVERSAL_DIRECTION };
