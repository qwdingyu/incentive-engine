// 顶层加载冒烟脚本：模拟消费方 `require` 引擎入口，验证能安全加载且核心导出齐全。
// 守卫目标：防止未来误将 optional peer（joi/sequelize）提升到顶层 require，
//           导致缺装的消费方一 require 即崩。改动入口后请运行 `npm run smoke`。
// 用法：node scripts/smoke-require.js
const engine = require("../src/index.js");

// 消费方契约要求的导出键（与 src/index.js module.exports 一一对应）
const REQUIRED_EXPORTS = [
  "Distribute",
  "Evaluate",
  "Allocate",
  "Orchestrate",
  "Model",
  "Adapters",
  "Decimal",
  "Services",
  "Validation",
  "Utils",
];

const missing = REQUIRED_EXPORTS.filter((k) => !(k in engine));
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error("[smoke] ✗ 入口缺少导出键: " + missing.join(", "));
  process.exit(1);
}

if (!engine.Services || !engine.Services.GenericSettlementService) {
  // eslint-disable-next-line no-console
  console.error("[smoke] ✗ 缺少 Services.GenericSettlementService");
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log("[smoke] ✓ 引擎入口顶层加载 OK, 导出键:", Object.keys(engine).join(","));