/**
 * Demo 4: 完整落账 — GenericSettlementService（内存 mock DB + 幂等全路径）
 *
 * 场景：某跨境电商平台接入引擎，实现「订单支付 → 佣金计算 → 幂等落账」全流程。
 *
 * 演示内容：
 * 1. 客户配置（buildEvent/buildDirectParent/buildAncestors/buildRecord/idempotency）
 * 2. 内存 mock Model / sequelize / ruleSetService（demo/mocks 共享模块）
 * 3. 幂等三层防护：
 *    a. settle() 事务外预读（快路径）
 *    b. settleWithTransaction 事务内预读（委托模式）
 *    c. 唯一约束兜底（模拟并发下 DB 唯一索引拦截 → 回读幂等返回）
 * 4. 边界行为：规则集不存在 / buildRecord 全过滤 / batchSettle 空数组
 *
 * 运行：node scenarios/04-full-settle.js
 */
const assert = require("node:assert");
const { GenericSettlementService } = require("@usethink/incentive-engine").Services;
const { validateCustomerConfig } = require("@usethink/incentive-engine").Validation;
const { createMemoryModel } = require("../mocks/memory-model");
const { createMemorySequelize } = require("../mocks/memory-sequelize");
const { createMemoryRuleSetService } = require("../mocks/memory-rule-set-service");
const { ECOMMERCE_RULES } = require("../shared/ecommerce-rules");
const { printHeader } = require("../utils/print");

// ⚠️ 生产必填：注入宿主 sequelize 的 UniqueConstraintError 类。
// 引擎包内 require("sequelize") 解析不到宿主 node_modules（可选 peer），
// 必须由宿主注入错误类才能识别唯一约束冲突并走幂等兜底。
const UniqueConstraintError = class MockUniqueConstraintError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "SequelizeUniqueConstraintError";
  }
};

// ========== 1. 内存 mock 基础设施（真实项目替换为真实实现） ==========
// 落账表：order_id + member_id + reward_id 组成唯一约束（真实表需建唯一索引）
const model = createMemoryModel({
  tableName: "commission_records",
  uniqueKeys: [["order_id", "member_id", "reward_id"]],
  UniqueConstraintError,
});
const sequelize = createMemorySequelize();

const ruleSetService = createMemoryRuleSetService({
  ECOMMERCE_REFERRAL: {
    ...ECOMMERCE_RULES,
    pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] },
  },
});

// ========== 2. 客户配置对象（业务定制部分） ==========
const customerConfig = {
  name: "ecommerce-referral",
  ruleSetCode: "ECOMMERCE_REFERRAL",
  model,
  sequelize,
  ruleSetService,
  UniqueConstraintError,

  buildEvent: (order) => ({
    sourceNodeId: order.buyerId,
    eventValue: order.amount,
    eventType: "ORDER_PAID",
  }),
  buildDirectParent: (order) => order.promoter ? { id: order.promoter.id, rankRate: order.promoter.rankRate } : null,
  buildAncestors: (order) => (order.ancestors || []).map((a) => ({ id: a.id, rankRate: a.rankRate })),
  buildRecord: (order, rec) => ({
    order_id: order.orderNo,
    member_id: rec.nodeId,
    reward_id: rec.rewardId,
    amount: rec.amount,
    status: "SETTLED",
    // 渠道标记：预读条件用它区分"本服务已落账"与"竞态对方落账"（见 4c）
    source: "ONLINE",
  }),
  idempotency: {
    // 预读条件：本服务（ONLINE 渠道）已处理过该订单
    buildPreReadWhere: (order) => ({ order_id: order.orderNo, source: "ONLINE" }),
    // 兜底回读：订单下所有已落账记录（含竞态对方写入的）
    buildFallbackWhere: (order) => ({ order_id: order.orderNo }),
  },
};

// ========== 3. 校验客户配置（可选） ==========
const validation = validateCustomerConfig(customerConfig);
if (!validation.valid) {
  console.error("客户配置校验失败:", validation.errors);
  process.exit(1);
}

// ========== 4. 执行 ==========
async function main() {
  printHeader("完整落账 Demo（GenericSettlementService）");
  const service = new GenericSettlementService(customerConfig);

  // ---- 4a. 正常结算 + 事务外预读幂等 ----
  const order1 = {
    orderNo: "ORD-20250101-001",
    buyerId: "buyer_1001",
    amount: "1000",
    promoter: { id: "promoter_501", rankRate: "8" },
    ancestors: [
      { id: "promoter_501", rankRate: "8" },
      { id: "promoter_205", rankRate: "11" },
    ],
  };
  const r1 = await service.settle(order1);
  console.log("\n-- 订单 1 结算 --");
  console.log("success:", r1.success, "| idempotent:", r1.idempotent);
  for (const line of r1.data.lines) {
    console.log(`  [${line.member_id}] ${line.reward_id}: ${line.amount} 元`);
  }
  assert.strictEqual(r1.idempotent, false);
  assert.strictEqual(r1.data.lines.length, 4);  // 自购返现 + 一级直推 + 链式两级

  // 同一订单重复提交 → 预读快路径命中
  const r2 = await service.settle(order1);
  console.log("\n-- 订单 1 重复提交（事务外预读命中）--");
  console.log("success:", r2.success, "| idempotent:", r2.idempotent, "| 返回条数:", r2.data.lines.length);
  assert.strictEqual(r2.idempotent, true);
  assert.strictEqual(r2.data.lines.length, 4);

  // ---- 4b. settleWithTransaction 事务内预读（委托模式） ----
  const order2 = {
    orderNo: "ORD-20250101-002",
    buyerId: "buyer_1002",
    amount: "2000",
    promoter: { id: "promoter_501", rankRate: "8" },
    ancestors: [{ id: "promoter_501", rankRate: "8" }],
  };
  const t1 = await sequelize.transaction();
  const rT1 = await service.settleWithTransaction(order2, t1);
  await t1.commit();
  const t2 = await sequelize.transaction();
  const rT2 = await service.settleWithTransaction(order2, t2);  // 事务内预读命中
  await t2.commit();
  console.log("\n-- settleWithTransaction（事务内预读）--");
  console.log("首次落账 idempotent:", rT1.idempotent, "| 再次处理 idempotent:", rT2.idempotent);
  assert.strictEqual(rT1.idempotent, false);
  assert.strictEqual(rT2.idempotent, true);

  // ---- 4c. 唯一约束兜底（模拟并发竞态） ----
  // 模拟：并发下两个请求都通过了预读（对方落账时本进程尚未提交，MVCC 不可见）。
  // 这里直接向内存表写入"竞态对方已落账"记录，且 source=SETTLED 与预读条件错开，
  // 使本服务预读查不到它；但落账时唯一键 order_id+member_id+reward_id 冲突 → 兜底回读。
  await model.create({
    order_id: "ORD-RACE-001",
    member_id: "buyer_race",
    reward_id: "self_cashback",
    amount: "100",
    status: "SETTLED",
    source: "SETTLED",   // 竞态对方渠道，本服务预读（source=ONLINE）查不到
  });
  const raceOrder = { orderNo: "ORD-RACE-001", buyerId: "buyer_race", amount: "100", promoter: null, ancestors: [] };
  const rRace = await service.settle(raceOrder);
  console.log("\n-- 唯一约束兜底（并发竞态：预读未拦住 → DB 唯一索引拦截）--");
  console.log("success:", rRace.success, "| idempotent:", rRace.idempotent, "| 返回条数:", rRace.data.lines.length);
  assert.strictEqual(rRace.success, true);
  assert.strictEqual(rRace.idempotent, true);
  assert.strictEqual(rRace.data.lines.length, 1);

  // ---- 4d. 边界行为 ----
  // 规则集不存在 → 计算阶段直接失败，不开启事务
  const badService = new GenericSettlementService({ ...customerConfig, ruleSetCode: "NOT_EXISTS" });
  const rBad = await badService.settle({ orderNo: "ORD-BAD-001", buyerId: "buyer_bad", amount: "10" });
  console.log("\n-- 规则集不存在 --");
  console.log("success:", rBad.success, "| message:", rBad.message);
  assert.strictEqual(rBad.success, false);

  // buildRecord 全过滤 → 无落账记录，返回 skipped
  const skipService = new GenericSettlementService({
    ...customerConfig,
    buildRecord: () => null,   // 业务上全部过滤（如不满足发奖条件）
  });
  const rSkip = await skipService.settle({ orderNo: "ORD-SKIP-001", buyerId: "buyer_skip", amount: "10" });
  console.log("\n-- buildRecord 全过滤（无落账记录）--");
  console.log("success:", rSkip.success, "| skipped:", rSkip.data?.skipped, "| lines:", rSkip.data?.lines?.length);
  assert.strictEqual(rSkip.success, true);
  assert.strictEqual(rSkip.data.skipped, true);

  // batchSettle 空数组 → 合法空批次
  const rEmpty = await service.batchSettle([]);
  console.log("\n-- batchSettle 空数组 --");
  console.log("success:", rEmpty.success, "| results:", rEmpty.data.results.length);
  assert.strictEqual(rEmpty.success, true);
  assert.deepStrictEqual(rEmpty.data.results, []);

  // ---- 4e. 分页查询 ----
  const list = await service.list({ page: 1, pageSize: 10 });
  console.log("\n-- 流水查询 --");
  console.log("total:", list.pagination.total, "条");
  for (const row of list.list) {
    console.log(`  ${row.order_id} | ${row.member_id} | ${row.reward_id} | ${row.amount} 元`);
  }
  console.log("✅ 断言通过：预读幂等 / 事务内预读 / 唯一约束兜底 / 边界行为");
}

main().catch((err) => {
  console.error("Demo 运行失败:", err);
  process.exit(1);
});
