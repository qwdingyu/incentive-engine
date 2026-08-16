/**
 * Demo 输出工具 — 统一 4 个场景的控制台打印格式
 */

/** 打印场景标题 */
function printHeader(title) {
  console.log(`\n========== ${title} ==========`);
}

/**
 * 打印收益记录（统一 [rewardId] nodeId: amount 元 格式）
 *
 * @param {Array<Object>} records - 引擎输出记录
 * @param {Object} [options]
 * @param {boolean} [options.showSnapshot] - 是否打印封顶快照
 */
function printRecords(records, { showSnapshot = false } = {}) {
  for (const rec of records) {
    const diff = rec.rewardType === "LEVEL" ? `（差率 ${rec.diffRate}%）` : "";
    console.log(`  [${rec.rewardId}] ${rec.nodeId}: ${rec.amount} 元${diff}`);
    if (showSnapshot && rec.snapshot?.payoutCaps) {
      console.log(`    → 封顶快照: ${JSON.stringify(rec.snapshot.payoutCaps)}`);
    }
  }
}

/** 打印拆分结果（SPLIT 阶段输出） */
function printSplits(splits) {
  for (const split of splits) {
    console.log(`  [${split.target}] ${split.amount} 元`);
  }
}

module.exports = { printHeader, printRecords, printSplits };
