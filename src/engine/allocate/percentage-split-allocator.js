/**
 * 百分比拆分分配器 — 通用纯计算，无外部依赖
 *
 * 领域无关：把一笔金额按 targets 比例拆到任意科目（[{target, ratio}]），
 * 最后一项自动补差保证各分项之和恒等于总额。
 * 松茸 70/30 拆分适配见 src/adapters/songrong-reward-adapter.js。
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
 * @param {string} totalAmount - 待拆分总金额
 * @param {Array<Object>} targets - 分配目标 [{ target, ratio }]，ratio 为百分比整数
 * @returns {Object} { splits: [{target, amount}], snapshot: {target: ratio} }
 */
function splitByTargets(totalAmount, targets = []) {
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
