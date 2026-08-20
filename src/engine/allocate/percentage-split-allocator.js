/**
 * 百分比拆分分配器 — 通用纯计算，无外部依赖
 *
 * 领域无关：把一笔金额按 targets 比例拆到任意科目（[{target, ratio}]），
 * 最后一项自动补差保证各分项之和恒等于总额。
 * 具体拆分口径（如 70/30）由上层以 targets 配置声明，引擎不内置任何业务比例。
 *
 * @version 2.1.0
 */

const Decimal = require("../../decimal");

/**
 * 按目标列表拆分金额（通用纯计算）
 *
 * 拆分规则：前 n-1 个目标按 ratio（百分比整数，70=70%）计算，最后一个目标补差，
 * 避免比例小数导致各分项相加不等于 totalAmount。
 *
 * 资金安全（P0-3）：在拆分前校验 ratio 之和必须精确等于 100，否则抛错拒绝执行。
 * 「最后一项补差」的设计动机（消除尾差）是正确的，但前提是比例之和已确认为 100，
 * 否则补差会变成吞掉全部剩余 —— 例如 A:30,B:20，B 声明 20% 实得 70%，直接资金错分。
 *
 * @param {string} totalAmount - 待拆分总金额
 * @param {Array<Object>} targets - 分配目标 [{ target, ratio }]，ratio 为百分比整数
 * @returns {Object} { splits: [{target, amount}], snapshot: {target: ratio} }
 * @throws {Error} 当 targets 为空、ratio 之和不为 100 时
 */
function splitByTargets(totalAmount, targets = []) {
  // 输入校验：空 target 列表无意义
  if (targets.length === 0) {
    throw new Error("splitByTargets：targets 不能为空，无法拆分");
  }

  // 资金安全（P0-3）：校验 ratio 之和精确等于 100。
  // 使用整数求和（避免浮点误差），ratio 为百分比整数（如 70 表示 70%）。
  const ratioSum = targets.reduce((s, t) => s + Number(t.ratio), 0);
  if (ratioSum !== 100) {
    throw new Error(
      `splitByTargets：targets ratio 之和必须为 100，当前=${ratioSum}（targets=${JSON.stringify(targets.map((t) => ({ target: t.target, ratio: t.ratio })))})`
    );
  }
  const splits = [];
  let remaining = totalAmount;

  targets.forEach(({ target, ratio }, index) => {
    if (index === targets.length - 1) {
      // 最后一个目标补差，保证 splits 金额之和恒等于 totalAmount。
      splits.push({ target, amount: remaining });
    } else {
      const amount = Decimal.pct(totalAmount, ratio);
      splits.push({ target, amount });
      remaining = Decimal.sub(remaining, amount);
    }
  });

  const snapshot = {};
  for (const t of targets) snapshot[t.target] = t.ratio;
  return { splits, snapshot };
}

module.exports = { splitByTargets };
