/**
 * @usethink/incentive-engine 资金不变量测试（P0-1 跨事件封顶）
 *
 * 覆盖报告 §六 第 0 阶段第 2 项：跨事件资金不变量。
 * 核心断言：N 个事件累计发放 ≤ 日限额。
 *
 * 使用真实引擎（executePipeline）+ mock 存储，通过 loadCapState/saveCapState
 * 钩子模拟「水位持久化」，验证平台日封顶在跨事件场景下真正生效。
 *
 * 修复前：GenericSettlementService 不传 context，每次结算水位从零开始，
 *          limit=100 三单各发 100，累计 300（封顶失效）。
 * 修复后：配置 loadCapState/saveCapState 后，三单累计必须 == 100。
 *
 * @version 1.0.0
 */

const { GenericSettlementService } = require("../src/services");
const { createMemoryModel } = require("../demo/mocks/memory-model");
const { createMemorySequelize } = require("../demo/mocks/memory-sequelize");
const { createMemoryRuleSetService } = require("../demo/mocks/memory-rule-set-service");

/** 构造一个带内存水位存储的结算服务（模拟真实持久化） */
function makeSettlementService({ rule, initialCapState = null } = {}) {
  // 内存水位存储：模拟数据库中的封顶水位表
  let storedCapState = initialCapState;

  const svc = new GenericSettlementService({
    name: "probe",
    ruleSetCode: "rs",
    model: createMemoryModel({ tableName: "t", uniqueKeys: [["orderNo"]] }),
    sequelize: createMemorySequelize(),
    ruleSetService: createMemoryRuleSetService({ rs: rule }),
    logger: { info() {}, warn() {}, error() {} },
    buildEvent: (e) => ({ sourceNodeId: e.userId, eventType: "order", eventValue: e.amount }),
    buildRecord: (e, r) => ({ orderNo: e.orderNo, userId: r.nodeId, amount: r.amount }),
    idempotency: {
      buildPreReadWhere: (e) => ({ orderNo: e.orderNo }),
      buildFallbackWhere: (e) => ({ orderNo: e.orderNo }),
    },
    // P0-1 修复：封顶水位读写钩子（成对配置后跨事件封顶生效）
    loadCapState: async () => storedCapState,
    saveCapState: async (capState) => {
      storedCapState = capState;
    },
  });

  return { svc, getStoredCapState: () => storedCapState };
}

describe("资金不变量：平台日封顶跨事件累计（P0-1）", () => {
  const RULE = {
    rewardDefs: [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" }],
    capDefs: [{ capId: "plat", scope: "PLATFORM_DAILY", limit: "100" }],
    pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] },
  };

  test("三单 × 100，limit=100，累计发放必须 == 100（封顶生效）", async () => {
    const { svc } = makeSettlementService({ rule: RULE });
    let total = 0;
    for (const orderNo of ["A", "B", "C"]) {
      const r = await svc.settle({ orderNo, userId: "u1", amount: "100" });
      const amounts = (r.data?.lines || []).map((l) => l.amount);
      total += amounts.reduce((s, a) => s + Number(a), 0);
    }
    // 资金不变量：累计发放 ≤ 日限额 100
    expect(total).toBe(100);
  });

  test("第一单 100 后，第二单起不再发放（水位已满）", async () => {
    const { svc } = makeSettlementService({ rule: RULE });
    const r1 = await svc.settle({ orderNo: "A", userId: "u1", amount: "100" });
    expect((r1.data.lines || []).map((l) => l.amount)).toEqual(["100"]);

    const r2 = await svc.settle({ orderNo: "B", userId: "u1", amount: "100" });
    // 水位已满，第二单应无落账记录（被 CAP 裁剪为 0 丢弃）
    expect((r2.data.lines || []).length).toBe(0);
  });

  test("水位跨批次持久化：saveCapState 后新服务实例仍能读到累计水位", async () => {
    // 第一批：A 单发 100，水位存到 100
    const first = makeSettlementService({ rule: RULE });
    await first.svc.settle({ orderNo: "A", userId: "u1", amount: "100" });
    const persisted = first.getStoredCapState();
    expect(persisted).not.toBeNull();
    // 平台水位应为 100
    expect(Number(persisted.platformPaid)).toBe(100);

    // 第二批：用持久化的水位初始化新服务实例（模拟重启/新请求）
    const second = makeSettlementService({ rule: RULE, initialCapState: persisted });
    const r = await second.svc.settle({ orderNo: "B", userId: "u1", amount: "100" });
    // 水位已满，B 单不应发放
    expect((r.data.lines || []).length).toBe(0);
  });

  test("未配置钩子时维持历史行为（封顶仅单事件内）—— 兼容性保障", async () => {
    // 不传 loadCapState/saveCapState，行为应与修复前一致（不破坏现有接入方）
    const svc = new GenericSettlementService({
      name: "probe",
      ruleSetCode: "rs",
      model: createMemoryModel({ tableName: "t", uniqueKeys: [["orderNo"]] }),
      sequelize: createMemorySequelize(),
      ruleSetService: createMemoryRuleSetService({ rs: RULE }),
      logger: { info() {}, warn() {}, error() {} },
      buildEvent: (e) => ({ sourceNodeId: e.userId, eventType: "order", eventValue: e.amount }),
      buildRecord: (e, r) => ({ orderNo: e.orderNo, userId: r.nodeId, amount: r.amount }),
      idempotency: {
        buildPreReadWhere: (e) => ({ orderNo: e.orderNo }),
        buildFallbackWhere: (e) => ({ orderNo: e.orderNo }),
      },
    });
    let total = 0;
    for (const orderNo of ["A", "B", "C"]) {
      const r = await svc.settle({ orderNo, userId: "u1", amount: "100" });
      total += (r.data?.lines || []).reduce((s, l) => s + Number(l.amount), 0);
    }
    // 未配置钩子：维持历史行为（每单 100，累计 300）—— 这是向后兼容的预期
    expect(total).toBe(300);
  });
});

describe("资金不变量：批量结算跨事件封顶（P0-1）", () => {
  const RULE = {
    rewardDefs: [{ rewardId: "self", type: "DIRECT", target: "SOURCE", rate: "100" }],
    capDefs: [{ capId: "plat", scope: "PLATFORM_DAILY", limit: "100" }],
    pipelineDef: { stages: [{ handler: "DISTRIBUTE" }, { handler: "CAP" }] },
  };

  test("batchSettle 三单 × 100，limit=100，累计发放必须 == 100", async () => {
    const { svc } = makeSettlementService({ rule: RULE });
    const result = await svc.batchSettle([
      { orderNo: "A", userId: "u1", amount: "100" },
      { orderNo: "B", userId: "u1", amount: "100" },
      { orderNo: "C", userId: "u1", amount: "100" },
    ]);
    expect(result.success).toBe(true);
    let total = 0;
    for (const res of result.data.results) {
      total += (res.lines || []).reduce((s, l) => s + Number(l.amount), 0);
    }
    expect(total).toBe(100);
  });
});
