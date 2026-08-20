/**
 * @usethink/incentive-engine GenericSettlementService 单元测试
 *
 * 通用结算服务（框架服务层）的单元测试，覆盖：
 * - 构造函数校验（必填项、依赖注入）
 * - _validateEvent 事件守卫
 * - settle 幂等快路径 / 完整流程 / 唯一约束兜底 / 异常上抛
 * - batchSettle 批量原子性（全部成功 / 部分失败全回滚）
 * - list 分页转发、getByWhere 空条件拒绝
 * - reverse 冲正（幂等键独立、事务内读原始记录、无可追回记录、唯一约束兜底）
 *
 * 所有测试使用 mock model + mock sequelize，不依赖真实数据库。
 * 引擎核心计算（executePipeline）在 engine-core.test.js 中独立覆盖。
 *
 * @version 1.0.0
 */

// ===================== Mock 引擎依赖 =====================

const mockExecutePipeline = jest.fn();
const mockBuildPipelineStages = jest.fn();
const mockNormalizePagination = jest.fn((p, ps) => {
  const page = Math.max(1, Math.floor(Number(p) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(ps) || 20)));
  return { page, pageSize, offset: (page - 1) * pageSize };
});

// 冲正计算器用真实实现（金额语义必须真跑），外层包一层 jest.fn 以便断言透传的入参
const mockReverseRecords = jest.fn((...args) =>
  jest.requireActual("../src/engine/reverse").reverseRecords(...args)
);

jest.mock("../src/engine", () => ({
  Orchestrate: { executePipeline: mockExecutePipeline },
  Reverse: { reverseRecords: mockReverseRecords },
}));

jest.mock("../src/adapters", () => ({
  buildPipelineStages: mockBuildPipelineStages,
}));

jest.mock("../src/utils", () => ({
  normalizePagination: mockNormalizePagination,
  // 生效期判定用真实实现：时区语义（左闭右开、必须带偏移量）必须真跑，mock 掉等于没测
  isWithinWindow: jest.requireActual("../src/utils/instant-window").isWithinWindow,
}));

// Mock sequelize（可选 peer）— 工厂内联定义，避免引用外部变量
jest.mock("sequelize", () => {
  const UCE = class UniqueConstraintError extends Error {
    constructor(msg) { super(msg); this.name = "SequelizeUniqueConstraintError"; }
  };
  return { UniqueConstraintError: UCE };
}, { virtual: true });

// ===================== 导入被测试模块 =====================

const {
  GenericSettlementService,
  REQUIRED_CONFIG_KEYS,
  REQUIRED_REVERSAL_KEYS,
} = require("../src/services/generic-settlement.service");
// sequelize 已被 jest.mock（返回 UCE），此处解构 mock 的 UniqueConstraintError 供测试内构造冲突异常
const { UniqueConstraintError } = require("sequelize");

// ===================== 辅助函数 =====================

/** 创建一个最小可用的 mock 客户配置 */
function makeMinimalConfig(overrides = {}) {
  return {
    name: "测试客户",
    ruleSetCode: "test_v1",
    model: {
      create: jest.fn(),
      bulkCreate: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      findAndCountAll: jest.fn(),
    },
    buildEvent: jest.fn((event) => ({
      sourceNodeId: event.buyerId,
      eventType: "purchase",
      eventValue: String(event.amount),
    })),
    buildRecord: jest.fn((businessEvent, engineRecord) => ({
      order_no: businessEvent.orderNo,
      reward_id: engineRecord.rewardId,
      amount: engineRecord.amount,
    })),
    idempotency: {
      buildPreReadWhere: jest.fn((event) => ({ order_no: event.orderNo })),
      buildFallbackWhere: jest.fn((event) => ({ order_no: event.orderNo })),
    },
    sequelize: {
      transaction: jest.fn(),
      LOCK: { UPDATE: "UPDATE" },
    },
    ruleSetService: {
      getActiveRuleSet: jest.fn(),
    },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

/** 创建 mock 事务对象 */
function makeMockTransaction() {
  return {
    LOCK: { UPDATE: "UPDATE" },
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
}

// ===================== 测试 =====================

describe("GenericSettlementService", () => {
  // ---------- 构造函数 ----------
  describe("构造函数", () => {
    test("必填项齐全时正常创建实例", () => {
      const svc = new GenericSettlementService(makeMinimalConfig());
      expect(svc.name).toBe("测试客户");
      expect(svc.ruleSetCode).toBe("test_v1");
    });

    test("缺少必填配置项时抛出", () => {
      expect(() => new GenericSettlementService({})).toThrow("GenericSettlement 配置缺少必填项");
    });

    test("缺少 sequelize 时抛出", () => {
      const cfg = makeMinimalConfig({ sequelize: undefined });
      expect(() => new GenericSettlementService(cfg)).toThrow("GenericSettlement 配置缺少必填项: sequelize");
    });

    test("缺少 ruleSetService 时抛出", () => {
      const cfg = makeMinimalConfig({ ruleSetService: undefined });
      expect(() => new GenericSettlementService(cfg)).toThrow("GenericSettlement 配置缺少必填项: ruleSetService");
    });

    test("缺失 buildEvent 抛出", () => {
      const cfg = makeMinimalConfig({ buildEvent: undefined });
      expect(() => new GenericSettlementService(cfg)).toThrow("buildEvent");
    });

    test("缺失 buildRecord 抛出", () => {
      const cfg = makeMinimalConfig({ buildRecord: undefined });
      expect(() => new GenericSettlementService(cfg)).toThrow("buildRecord");
    });

    test("缺失 idempotency 抛出", () => {
      const cfg = makeMinimalConfig({ idempotency: undefined });
      expect(() => new GenericSettlementService(cfg)).toThrow("idempotency");
    });

    test("REQUIRED_CONFIG_KEYS 导出常量内容正确", () => {
      expect(REQUIRED_CONFIG_KEYS).toEqual(expect.arrayContaining(["name", "ruleSetCode", "model", "buildEvent", "buildRecord", "idempotency"]));
    });

    test("缺省 buildDirectParent 和 buildAncestors 不报错", () => {
      const cfg = makeMinimalConfig();
      delete cfg.buildDirectParent;
      delete cfg.buildAncestors;
      const svc = new GenericSettlementService(cfg);
      expect(svc.buildDirectParent()).toBeNull();
      expect(svc.buildAncestors()).toEqual([]);
    });

    test("缺省 logger 使用 console", () => {
      const cfg = makeMinimalConfig({ logger: undefined });
      const svc = new GenericSettlementService(cfg);
      expect(svc.log).toBe(console);
    });
  });

  // ---------- _validateEvent ----------
  describe("_validateEvent", () => {
    test("缺少 event 时返回 { ok: false }", () => {
      const svc = new GenericSettlementService(makeMinimalConfig());
      const result = svc._validateEvent();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("业务事件");
    });

    test("缺少幂等键字段 order_no 时返回 { ok: false }", () => {
      const svc = new GenericSettlementService(makeMinimalConfig());
      const result = svc._validateEvent({ buyerId: "u1" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("order_no");
    });

    test("合法事件返回 { ok: true }", () => {
      const svc = new GenericSettlementService(makeMinimalConfig());
      const result = svc._validateEvent({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(result.ok).toBe(true);
    });

    test("空幂等键 where 返回 { ok: false }（防御 findAll 全表）", () => {
      // buildPreReadWhere 返回 {} 时，findAll({ where: {} }) 返回全表，
      // 所有新事件被误判为幂等命中而静默不落账（资金安全边界）。
      const svc = new GenericSettlementService(makeMinimalConfig({
        idempotency: {
          buildPreReadWhere: () => ({}),
          buildFallbackWhere: (e) => ({}),
        },
      }));
      const result = svc._validateEvent({ orderNo: "O001" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("不能为空");
    });
  });

  // ---------- settle ----------
  describe("settle", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test("幂等快路径：预读命中返回 idempotent=true", async () => {
      const existingRecord = { id: 1, order_no: "O001" };
      const cfg = makeMinimalConfig();
      cfg.model.findAll.mockResolvedValue([existingRecord]);
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(result).toEqual({ success: true, data: { lines: [existingRecord] }, idempotent: true });
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
    });

    test("完整流程：事务内计算 + 落账 + postProcess", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      cfg.model.findAll.mockResolvedValue([]);
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockResolvedValue({ id: 1, order_no: "O001", reward_id: "commission", amount: "100" });
      const postProcess = jest.fn().mockResolvedValue(undefined);
      const svc = new GenericSettlementService({ ...cfg, postProcess });
      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(result.success).toBe(true);
      expect(result.data.lines).toHaveLength(1);
      expect(result.idempotent).toBe(false);
      expect(tx.commit).toHaveBeenCalledTimes(1);
      expect(tx.rollback).not.toHaveBeenCalled();
      expect(postProcess).toHaveBeenCalledTimes(1);
      expect(postProcess.mock.calls[0][0].orderNo).toBe("O001");
      expect(postProcess.mock.calls[0][2]).toBe(tx);
    });

    test("业务事件额外字段注入 engineEvent.attrs（供 conditions 评估）", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      cfg.model.findAll.mockResolvedValue([]);
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockResolvedValue({ id: 1, order_no: "O001", reward_id: "commission", amount: "100" });
      const svc = new GenericSettlementService(cfg);

      // 业务事件含 orderAmount/vip 等额外字段（buildEvent 未使用）
      await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000", orderAmount: "2000", vip: "V3" });

      // buildPipelineStages 收到的 event 必须含 attrs（orderAmount/vip 注入）
      const stagesArg = mockBuildPipelineStages.mock.calls[0][1];
      expect(stagesArg.event.attrs).toBeDefined();
      expect(stagesArg.event.attrs.orderAmount).toBe("2000");
      expect(stagesArg.event.attrs.vip).toBe("V3");
      // 标准字段不注入 attrs
      expect(stagesArg.event.attrs.sourceNodeId).toBeUndefined();
      expect(stagesArg.event.attrs.eventValue).toBeUndefined();
      // 引擎标准字段保留在 event 顶层
      expect(stagesArg.event.sourceNodeId).toBe("u1");
      expect(stagesArg.event.eventValue).toBe("1000");
    });

    test("buildEvent 已显式设置 attrs 时保留不覆盖", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig({
        buildEvent: (event) => ({
          sourceNodeId: event.buyerId,
          eventType: "purchase",
          eventValue: String(event.amount),
          attrs: { custom: "preserved" },
        }),
      });
      cfg.model.findAll.mockResolvedValue([]);
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockResolvedValue({ id: 1, order_no: "O001", reward_id: "commission", amount: "100" });
      const svc = new GenericSettlementService(cfg);

      await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000", orderAmount: "2000" });

      const stagesArg = mockBuildPipelineStages.mock.calls[0][1];
      // 显式 attrs 保留
      expect(stagesArg.event.attrs.custom).toBe("preserved");
      // 额外字段仍注入（不覆盖显式 attrs 已有键）
      expect(stagesArg.event.attrs.orderAmount).toBe("2000");
    });

    test("UniqueConstraintError 兜底", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      const dupRecord = { id: 1, order_no: "O001" };
      cfg.model.findAll
        .mockResolvedValueOnce([])              // 幂等预读
        .mockResolvedValueOnce([dupRecord]);    // 兜底查询
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockRejectedValue(new UniqueConstraintError("重复键冲突"));
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(result).toEqual({ success: true, data: { lines: [dupRecord] }, idempotent: true });
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(tx.commit).not.toHaveBeenCalled();
    });

    test("UniqueConstraintError 但兜底查询条件为空 → 上抛（防御全表返回）", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig({
        idempotency: {
          buildPreReadWhere: (e) => ({ order_no: e.orderNo }),
          buildFallbackWhere: () => ({}), // 空兜底条件（配置错误）
        },
      });
      cfg.model.findAll.mockResolvedValue([]);
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockRejectedValue(new UniqueConstraintError("重复键冲突"));
      const svc = new GenericSettlementService(cfg);
      // 空兜底条件 → 不应把全表当成功返回，应上抛
      await expect(svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" })).rejects.toThrow("重复键冲突");
      expect(tx.rollback).toHaveBeenCalledTimes(1);
    });

    test("非 UniqueConstraint 异常上抛", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      cfg.model.findAll.mockResolvedValue([]);
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockRejectedValue(new Error("数据库连接超时"));
      const svc = new GenericSettlementService(cfg);
      await expect(svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" })).rejects.toThrow("数据库连接超时");
      expect(tx.rollback).toHaveBeenCalledTimes(1);
    });

    test("规则集未启用：计算阶段直接失败，不开启事务", async () => {
      const cfg = makeMinimalConfig();
      cfg.model.findAll.mockResolvedValue([]);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: false, message: "规则集未启用" });
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O002", buyerId: "u1", amount: "1000" });
      expect(result).toEqual({ success: false, message: "规则集加载失败: 规则集未启用" });
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
      expect(cfg.model.create).not.toHaveBeenCalled();
    });

    test("buildRecord 全部过滤：返回 skipped=true 且不开启事务", async () => {
      const cfg = makeMinimalConfig();
      cfg.model.findAll.mockResolvedValue([]);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.buildRecord.mockReturnValue(null); // buildRecord 全部过滤
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O003", buyerId: "u1", amount: "1000" });
      expect(result).toEqual({ success: true, data: { skipped: true, lines: [] }, idempotent: false });
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
      expect(cfg.model.create).not.toHaveBeenCalled();
    });

    test("注入 UniqueConstraintError 类：兜底读取已落账记录视为幂等成功（不依赖 sequelize 包解析）", async () => {
      const tx = makeMockTransaction();
      const dupRecord = { id: 1, order_no: "O004" };
      // 宿主自定义错误类（模拟 rbb 等宿主项目的 sequelize.UniqueConstraintError）
      class HostUniqueConstraintError extends Error {
        constructor(msg) { super(msg); this.name = "SequelizeUniqueConstraintError"; }
      }
      const cfg = makeMinimalConfig({ UniqueConstraintError: HostUniqueConstraintError });
      cfg.model.findAll
        .mockResolvedValueOnce([])              // 幂等预读
        .mockResolvedValueOnce([dupRecord]);    // 兜底查询
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockRejectedValue(new HostUniqueConstraintError("重复键冲突"));
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O004", buyerId: "u1", amount: "1000" });
      expect(result).toEqual({ success: true, data: { lines: [dupRecord] }, idempotent: true });
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(tx.commit).not.toHaveBeenCalled();
    });
  });

  // ---------- settleWithTransaction ----------
  describe("settleWithTransaction", () => {
    test("使用传入事务，不自行提交或回滚", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      cfg.model.findAll.mockResolvedValue([]);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [] } } });
      mockBuildPipelineStages.mockReturnValue([]);
      mockExecutePipeline.mockReturnValue({ results: {}, final: [], context: {} });
      cfg.model.create.mockResolvedValue({ id: 1, order_no: "O001" });
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settleWithTransaction({ orderNo: "O001", buyerId: "u1", amount: "1000" }, tx);
      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(false);
      expect(tx.commit).not.toHaveBeenCalled();
      expect(tx.rollback).not.toHaveBeenCalled();
    });

    test("传入事务内幂等预读命中：返回 idempotent=true 且不落账", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      const existing = [{ id: 9, order_no: "O001", amount: "100" }];
      cfg.model.findAll.mockResolvedValue(existing);
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settleWithTransaction({ orderNo: "O001", buyerId: "u1", amount: "1000" }, tx);
      expect(result).toEqual({ success: true, data: { lines: existing }, idempotent: true });
      // 预读使用传入事务
      expect(cfg.model.findAll).toHaveBeenCalledWith({ where: { order_no: "O001" }, transaction: tx });
      expect(cfg.model.create).not.toHaveBeenCalled();
    });
  });

  // ---------- batchSettle ----------
  describe("batchSettle", () => {
    let cfg, tx, svc;
    beforeEach(() => {
      jest.clearAllMocks();
      tx = makeMockTransaction();
      cfg = makeMinimalConfig();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [] } } });
      mockBuildPipelineStages.mockReturnValue([]);
      mockExecutePipeline.mockReturnValue({ results: {}, final: [], context: {} });
      svc = new GenericSettlementService(cfg);
    });

    test("全部成功，事务提交", async () => {
      cfg.model.findAll.mockResolvedValue([]);
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockResolvedValue({ id: 1 });
      const events = [
        { orderNo: "O001", buyerId: "u1", amount: "1000" },
        { orderNo: "O002", buyerId: "u2", amount: "2000" },
      ];
      const result = await svc.batchSettle(events);
      expect(result.success).toBe(true);
      expect(result.data.results).toHaveLength(2);
      expect(tx.commit).toHaveBeenCalledTimes(1);
      expect(tx.rollback).not.toHaveBeenCalled();
    });

    test("空数组：返回 success=true 且不开启事务", async () => {
      const result = await svc.batchSettle([]);
      expect(result).toEqual({ success: true, data: { results: [] } });
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
      expect(cfg.model.findAll).not.toHaveBeenCalled();
      expect(cfg.model.create).not.toHaveBeenCalled();
    });

    test("部分事件已幂等处理，仅处理未处理事件并保持顺序", async () => {
      // 模拟：O001 已处理，O002 未处理
      cfg.model.findAll
        .mockResolvedValueOnce([{ id: 1, orderNo: "O001", amount: "100" }])  // O001 预读命中
        .mockResolvedValueOnce([]);                                           // O002 预读未命中
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockResolvedValue({ id: 2, orderNo: "O002", amount: "200" });
      const events = [
        { orderNo: "O001", buyerId: "u1", amount: "1000" },
        { orderNo: "O002", buyerId: "u2", amount: "2000" },
      ];
      const result = await svc.batchSettle(events);
      expect(result.success).toBe(true);
      expect(result.data.results).toHaveLength(2);
      // O001 应为幂等结果
      expect(result.data.results[0].idempotent).toBe(true);
      expect(result.data.results[0].lines).toEqual([{ id: 1, orderNo: "O001", amount: "100" }]);
      // O002 应为新处理结果
      expect(result.data.results[1].idempotent).toBe(false);
      expect(result.data.results[1].lines).toEqual([{ id: 2, orderNo: "O002", amount: "200" }]);
      // 事务只处理了 O002
      expect(tx.commit).toHaveBeenCalledTimes(1);
      expect(tx.rollback).not.toHaveBeenCalled();
      // 只调用了 1 次 create（仅 O002 落账）
      expect(cfg.model.create).toHaveBeenCalledTimes(1);
    });

    test("部分失败全部回滚，并返回 { success: false }（不抛异常）", async () => {
      cfg.model.findAll.mockResolvedValue([]);
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: { distribute: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: {},
      });
      cfg.model.create.mockResolvedValueOnce({ id: 1 }).mockRejectedValueOnce(new Error("落账失败"));
      const events = [
        { orderNo: "O001", buyerId: "u1", amount: "1000" },
        { orderNo: "O002", buyerId: "u2", amount: "2000" },
      ];
      // P2 错误契约一致性：与 batchSettle 其他失败出口、以及 settle 对齐 ——
      // 统一返回 { success:false, message }，不再往外抛（调用方只查 success 就不会漏账）。
      const result = await svc.batchSettle(events);
      expect(result.success).toBe(false);
      expect(result.message).toContain("落账失败");
      expect(result.message).toContain("无部分落账");
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(tx.commit).not.toHaveBeenCalled();
    });
  });

  // ---------- useBulkCreate（P2 性能开关）----------
  describe("useBulkCreate 批量插入开关", () => {
    let cfg;
    let tx;

    beforeEach(() => {
      cfg = makeMinimalConfig();
      tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      cfg.model.findAll.mockResolvedValue([]);
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: {},
        final: [
          { rewardId: "r1", nodeId: "u1", amount: "100" },
          { rewardId: "r2", nodeId: "u2", amount: "50" },
        ],
        context: {},
      });
    });

    test("缺省不启用：逐条 create（保持历史行为）", async () => {
      cfg.model.create.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 2 });
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(result.success).toBe(true);
      expect(cfg.model.create).toHaveBeenCalledTimes(2);
      expect(cfg.model.bulkCreate).not.toHaveBeenCalled();
    });

    test("useBulkCreate: true 时改走 bulkCreate（N 次 round-trip → 1 次）", async () => {
      cfg.useBulkCreate = true;
      cfg.model.bulkCreate.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(result.success).toBe(true);
      expect(cfg.model.bulkCreate).toHaveBeenCalledTimes(1);
      expect(cfg.model.create).not.toHaveBeenCalled();
      // 落账记录仍按 data.lines 返回，条数不变
      expect(result.data.lines).toHaveLength(2);
      // 与逐条路径一致：在同一事务内插入
      expect(cfg.model.bulkCreate).toHaveBeenCalledWith(expect.any(Array), { transaction: tx });
    });

    test("model 未实现 bulkCreate 时安全回退到逐条 create", async () => {
      cfg.useBulkCreate = true;
      delete cfg.model.bulkCreate;
      cfg.model.create.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 2 });
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(result.success).toBe(true);
      expect(cfg.model.create).toHaveBeenCalledTimes(2);
    });
  });

  // ---------- ruleSetCode 告警（P2 日志噪音）----------
  describe("ruleSetCode 告警只在真有误用信号时触发", () => {
    let cfg;

    beforeEach(() => {
      cfg = makeMinimalConfig();
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({ success: true, data: { config_json: { rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }] } } });
      cfg.model.findAll.mockResolvedValue([]);
      cfg.model.create.mockResolvedValue({ id: 1 });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: {},
        final: [{ rewardId: "r1", nodeId: "u1", amount: "100" }],
        context: {},
      });
    });

    test("依赖构造默认规则集（事件内不带 ruleSetCode）不告警", async () => {
      const svc = new GenericSettlementService(cfg);
      await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(cfg.logger.warn).not.toHaveBeenCalled();
    });

    test("事件内 ruleSetCode 与生效规则集一致时不告警（无误用）", async () => {
      const svc = new GenericSettlementService(cfg);
      await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000", ruleSetCode: "test_v1" });
      expect(cfg.logger.warn).not.toHaveBeenCalled();
    });

    test("事件内 ruleSetCode 与生效规则集不一致时告警（意图覆盖但传错位置）", async () => {
      const svc = new GenericSettlementService(cfg);
      await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000", ruleSetCode: "promo_v2" });
      expect(cfg.logger.warn).toHaveBeenCalledTimes(1);
      expect(cfg.logger.warn.mock.calls[0][0]).toContain("promo_v2");
      expect(cfg.logger.warn.mock.calls[0][0]).toContain("options.ruleSetCode");
    });

    test("显式传 options.ruleSetCode 时不告警（即使事件内不同）", async () => {
      const svc = new GenericSettlementService(cfg);
      await svc.settle(
        { orderNo: "O001", buyerId: "u1", amount: "1000", ruleSetCode: "promo_v2" },
        { ruleSetCode: "promo_v2" }
      );
      expect(cfg.logger.warn).not.toHaveBeenCalled();
    });
  });

  // ---------- reverse（冲正） ----------
  describe("reverse", () => {
    /** 在最小配置上补一个可用的 reversal 块 */
    function makeReversalConfig(revOverrides = {}, cfgOverrides = {}) {
      const cfg = makeMinimalConfig(cfgOverrides);
      cfg.reversal = {
        loadOriginalRecords: jest.fn(async () => [
          { id: "rec1", member_id: "u1", amount: "100" },
          { id: "rec2", member_id: "u2", amount: "50" },
        ]),
        buildOriginalRecord: jest.fn((row) => ({
          recordId: row.id,
          nodeId: row.member_id,
          amount: row.amount,
          rewardId: "referral",
        })),
        resolveReversal: jest.fn(() => ({ ratio: "100" })),
        buildRecord: jest.fn((event, record) => ({
          refund_no: event.refundNo,
          member_id: record.nodeId,
          amount: record.amount,
          direction: record.direction,
        })),
        idempotency: {
          buildPreReadWhere: jest.fn((event) => ({ refund_no: event.refundNo })),
          buildFallbackWhere: jest.fn((event) => ({ refund_no: event.refundNo })),
        },
        ...revOverrides,
      };
      return cfg;
    }

    beforeEach(() => {
      mockReverseRecords.mockClear();
    });

    test("未配置 reversal 时 reverse 返回 success:false（不抛错）", async () => {
      const svc = new GenericSettlementService(makeMinimalConfig());
      const result = await svc.reverse({ refundNo: "RF001" });
      expect(result.success).toBe(false);
      expect(result.message).toContain("未配置 reversal");
    });

    test("reversal 块缺必填项时构造期抛错", () => {
      const cfg = makeReversalConfig();
      delete cfg.reversal.resolveReversal;
      expect(() => new GenericSettlementService(cfg)).toThrow(
        "GenericSettlement reversal 配置缺少必填项: resolveReversal"
      );
    });

    test("reversal.idempotency 缺函数时构造期抛错", () => {
      const cfg = makeReversalConfig({ idempotency: { buildPreReadWhere: () => ({ a: 1 }) } });
      expect(() => new GenericSettlementService(cfg)).toThrow(
        "reversal.idempotency 必须提供 buildPreReadWhere 与 buildFallbackWhere"
      );
    });

    test("REQUIRED_REVERSAL_KEYS 导出常量内容正确", () => {
      expect(REQUIRED_REVERSAL_KEYS).toEqual([
        "loadOriginalRecords",
        "buildOriginalRecord",
        "resolveReversal",
        "buildRecord",
        "idempotency",
      ]);
    });

    test("全额冲正：落负金额记录并提交事务", async () => {
      const cfg = makeReversalConfig();
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]); // 幂等预读未命中
      cfg.model.create.mockImplementation(async (r) => ({ ...r, id: 1 }));

      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({ refundNo: "RF001" });

      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(false);
      expect(result.data.lines).toHaveLength(2);
      expect(result.data.summary.recordCount).toBe(2);
      expect(cfg.model.create).toHaveBeenCalledTimes(2);
      expect(cfg.model.create.mock.calls[0][0]).toEqual(
        expect.objectContaining({ refund_no: "RF001", member_id: "u1", amount: "-100", direction: "REVERSAL" })
      );
      expect(tx.commit).toHaveBeenCalledTimes(1);
      expect(tx.rollback).not.toHaveBeenCalled();
    });

    test("原始记录在【事务内】读取（宿主可加行锁，避免并发超额追回）", async () => {
      const cfg = makeReversalConfig();
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);
      cfg.model.create.mockImplementation(async (r) => r);

      const svc = new GenericSettlementService(cfg);
      await svc.reverse({ refundNo: "RF001" }, { extra: 1 });

      expect(cfg.reversal.loadOriginalRecords).toHaveBeenCalledWith(
        { refundNo: "RF001" },
        expect.objectContaining({ transaction: tx, options: { extra: 1 } })
      );
    });

    test("幂等键用 reversal.idempotency（退款单号），不复用发放侧订单号", async () => {
      const cfg = makeReversalConfig();
      cfg.model.findAll.mockResolvedValue([{ id: 9, refund_no: "RF001" }]);

      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({ refundNo: "RF001" });

      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(true);
      expect(result.data.lines).toHaveLength(1);
      expect(cfg.model.findAll).toHaveBeenCalledWith({ where: { refund_no: "RF001" } });
      expect(cfg.idempotency.buildPreReadWhere).not.toHaveBeenCalled();
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
    });

    test("缺少冲正幂等键字段时返回 { success:false }，不开事务", async () => {
      const cfg = makeReversalConfig();
      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({});
      expect(result.success).toBe(false);
      expect(result.message).toContain("refund_no");
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
    });

    test("无可冲正的原始记录：skipped，不落账不报错", async () => {
      const cfg = makeReversalConfig({ loadOriginalRecords: jest.fn(async () => []) });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);

      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({ refundNo: "RF001" });

      expect(result.success).toBe(true);
      expect(result.data.skipped).toBe(true);
      expect(result.data.lines).toEqual([]);
      expect(cfg.model.create).not.toHaveBeenCalled();
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(tx.commit).not.toHaveBeenCalled();
    });

    test("loadOriginalRecords 返回非数组：抛错并回滚（不静默当作无可追回）", async () => {
      const cfg = makeReversalConfig({ loadOriginalRecords: jest.fn(async () => null) });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);

      const svc = new GenericSettlementService(cfg);
      await expect(svc.reverse({ refundNo: "RF001" })).rejects.toThrow(
        "reversal.loadOriginalRecords 必须返回数组"
      );
      expect(tx.rollback).toHaveBeenCalledTimes(1);
    });

    test("已全额冲正（loadReversedMap）：skipped，不产生第二条扣款", async () => {
      const cfg = makeReversalConfig({
        loadReversedMap: jest.fn(async () => new Map([["rec1", "100"], ["rec2", "50"]])),
      });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);

      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({ refundNo: "RF002" });

      expect(result.success).toBe(true);
      expect(result.data.skipped).toBe(true);
      expect(result.data.summary.skippedCount).toBe(2);
      expect(cfg.model.create).not.toHaveBeenCalled();
      expect(tx.rollback).toHaveBeenCalledTimes(1);
    });

    test("部分退款：reversalValue/originalEventValue 透传引擎，按比例追回", async () => {
      const cfg = makeReversalConfig({
        resolveReversal: jest.fn(() => ({ reversalValue: "300", originalEventValue: "1000" })),
      });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);
      cfg.model.create.mockImplementation(async (r) => r);

      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({ refundNo: "RF003" });

      expect(mockReverseRecords).toHaveBeenCalledWith(
        expect.objectContaining({ reversalValue: "300", originalEventValue: "1000", onExceed: "CLAMP" })
      );
      expect(result.data.summary.basis).toBe("EVENT_VALUE");
      expect(cfg.model.create.mock.calls[0][0].amount).toBe("-30");
      expect(cfg.model.create.mock.calls[1][0].amount).toBe("-15");
    });

    test("resolveReversal 未给比例：引擎抛错并回滚（不默认全额冲正）", async () => {
      const cfg = makeReversalConfig({ resolveReversal: jest.fn(() => ({})) });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);

      const svc = new GenericSettlementService(cfg);
      await expect(svc.reverse({ refundNo: "RF001" })).rejects.toThrow("必须提供冲正比例");
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(cfg.model.create).not.toHaveBeenCalled();
    });

    test("buildRecord 全部返回 null：skipped，不落账", async () => {
      const cfg = makeReversalConfig({ buildRecord: jest.fn(() => null) });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);

      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({ refundNo: "RF001" });

      expect(result.success).toBe(true);
      expect(result.data.skipped).toBe(true);
      expect(result.data.summary.recordCount).toBe(2);
      expect(tx.rollback).toHaveBeenCalledTimes(1);
    });

    test("唯一约束冲突走幂等兜底（并发同一笔退款）", async () => {
      const cfg = makeReversalConfig();
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll
        .mockResolvedValueOnce([])                       // 事务外预读未命中
        .mockResolvedValueOnce([{ id: 5, refund_no: "RF001" }]); // 兜底查询命中
      cfg.model.create.mockRejectedValue(new UniqueConstraintError("dup"));

      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({ refundNo: "RF001" });

      expect(result.success).toBe(true);
      expect(result.idempotent).toBe(true);
      expect(result.data.lines).toHaveLength(1);
      expect(cfg.reversal.idempotency.buildFallbackWhere).toHaveBeenCalledWith({ refundNo: "RF001" });
      expect(cfg.idempotency.buildFallbackWhere).not.toHaveBeenCalled();
      expect(tx.rollback).toHaveBeenCalledTimes(1);
    });

    test("useBulkCreate 时用 bulkCreate 一次插入", async () => {
      const cfg = makeReversalConfig({}, { useBulkCreate: true });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);
      cfg.model.bulkCreate.mockResolvedValue([{ id: 1 }, { id: 2 }]);

      const svc = new GenericSettlementService(cfg);
      const result = await svc.reverse({ refundNo: "RF001" });

      expect(cfg.model.bulkCreate).toHaveBeenCalledTimes(1);
      expect(cfg.model.create).not.toHaveBeenCalled();
      expect(result.data.lines).toHaveLength(2);
    });

    test("只调用 reversal.postProcess，不复用发放侧 postProcess（防重复计数）", async () => {
      const revPost = jest.fn(async () => {});
      const payoutPost = jest.fn(async () => {});
      const cfg = makeReversalConfig({ postProcess: revPost }, { postProcess: payoutPost });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);
      cfg.model.create.mockImplementation(async (r) => r);

      const svc = new GenericSettlementService(cfg);
      await svc.reverse({ refundNo: "RF001" });

      expect(revPost).toHaveBeenCalledTimes(1);
      expect(revPost).toHaveBeenCalledWith({ refundNo: "RF001" }, expect.any(Array), tx);
      expect(payoutPost).not.toHaveBeenCalled();
    });

    test("冲正不持久化封顶水位（不回退已用额度，防退款套利）", async () => {
      const saveCapState = jest.fn(async () => {});
      const cfg = makeReversalConfig({}, { saveCapState, loadCapState: jest.fn(async () => null) });
      const tx = makeMockTransaction();
      cfg.sequelize.transaction.mockResolvedValue(tx);
      cfg.model.findAll.mockResolvedValue([]);
      cfg.model.create.mockImplementation(async (r) => r);

      const svc = new GenericSettlementService(cfg);
      await svc.reverse({ refundNo: "RF001" });

      expect(saveCapState).not.toHaveBeenCalled();
      expect(cfg.loadCapState).not.toHaveBeenCalled();
    });
  });


  // ---------- 跨结算周期封顶（v4.0.0 §14：WEEKLY / MONTHLY / TOTAL）----------
  describe("跨周期封顶必须成对配置水位钩子", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    /**
     * 装配一个「含非 DAILY 周期封顶」的规则集与可落账的流水线产出。
     * @param {Object} cfg - makeMinimalConfig() 产物
     * @param {Array<Object>} capDefs - 封顶配置
     * @param {Object|null} capStateOut - 引擎推进后回传的水位（context.capState）
     */
    function mockCapRuleSet(cfg, capDefs, capStateOut = null) {
      cfg.model.findAll.mockResolvedValue([]);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({
        success: true,
        data: {
          config_json: {
            rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }],
            capDefs,
          },
        },
      });
      mockBuildPipelineStages.mockReturnValue([
        { id: "distribute", handler: "DISTRIBUTE", config: {} },
        { id: "cap", handler: "CAP", config: { capDefs } },
      ]);
      mockExecutePipeline.mockReturnValue({
        results: { cap: [{ rewardId: "commission", nodeId: "u0", amount: "100" }] },
        final: [{ rewardId: "commission", nodeId: "u0", amount: "100" }],
        context: capStateOut ? { capState: capStateOut } : {},
      });
      cfg.model.create.mockResolvedValue({ id: 1, order_no: "O001", reward_id: "commission", amount: "100" });
    }

    test("PLATFORM_MONTHLY 封顶但未配水位钩子：拒绝结算、不开事务、不落账", async () => {
      const cfg = makeMinimalConfig();
      mockCapRuleSet(cfg, [{ capId: "m", scope: "PLATFORM_MONTHLY", limit: "50000" }]);
      const svc = new GenericSettlementService(cfg);

      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/必须成对配置 loadCapState \/ saveCapState/);
      expect(result.message).toContain("PLATFORM_MONTHLY");
      // 水位每次从 0 起算会把「月封顶 5 万」退化成「单事件封顶 5 万」：必须在落账前拦下
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
      expect(cfg.model.create).not.toHaveBeenCalled();
    });

    test("只配了 loadCapState：仍拒绝并指名缺少的那一个钩子", async () => {
      const cfg = makeMinimalConfig();
      mockCapRuleSet(cfg, [{ capId: "w", scope: "PER_USER_WEEKLY", limit: "500" }]);
      const svc = new GenericSettlementService({ ...cfg, loadCapState: jest.fn() });

      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });

      expect(result.success).toBe(false);
      expect(result.message).toContain("PER_USER_WEEKLY");
      expect(result.message).toContain("saveCapState");
      expect(result.message).not.toContain("缺少 loadCapState");
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
    });

    test("成对配置后正常落账，含 periods 的水位在事务内交给 saveCapState", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      const loaded = {
        platformPaid: "0",
        memberPaid: new Map(),
        periods: { MONTHLY: { platformPaid: "1000", memberPaid: new Map([["u0", "1000"]]) } },
      };
      const advanced = {
        platformPaid: "100",
        memberPaid: new Map([["u0", "100"]]),
        periods: { MONTHLY: { platformPaid: "1100", memberPaid: new Map([["u0", "1100"]]) } },
      };
      mockCapRuleSet(cfg, [{ capId: "m", scope: "PLATFORM_MONTHLY", limit: "50000" }], advanced);
      cfg.sequelize.transaction.mockResolvedValue(tx);
      const loadCapState = jest.fn().mockResolvedValue(loaded);
      const saveCapState = jest.fn().mockResolvedValue(undefined);
      const svc = new GenericSettlementService({ ...cfg, loadCapState, saveCapState });

      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });

      expect(result.success).toBe(true);
      expect(loadCapState).toHaveBeenCalledTimes(1);
      // 读到的历史水位（含 periods）必须原样进引擎 context
      expect(mockExecutePipeline.mock.calls[0][0].context.capState).toBe(loaded);
      // 推进后的水位在同一事务内持久化：periods 一并交给宿主
      expect(saveCapState).toHaveBeenCalledTimes(1);
      expect(saveCapState.mock.calls[0][0]).toBe(advanced);
      expect(saveCapState.mock.calls[0][0].periods.MONTHLY.platformPaid).toBe("1100");
      expect(saveCapState.mock.calls[0][1]).toBe(tx);
      expect(tx.commit).toHaveBeenCalledTimes(1);
      expect(tx.rollback).not.toHaveBeenCalled();
    });

    test("只配日封顶时未配钩子仍按历史行为放行（向后兼容）", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      mockCapRuleSet(cfg, [
        { capId: "d", scope: "PLATFORM_DAILY", limit: "5000" },
        { capId: "u", scope: "PER_USER_DAILY", limit: "500" },
      ]);
      cfg.sequelize.transaction.mockResolvedValue(tx);
      const svc = new GenericSettlementService(cfg);

      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });

      expect(result.success).toBe(true);
      expect(result.data.lines).toHaveLength(1);
      expect(tx.commit).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- 规则集生效期 / 活动加成（时间维度，fail-closed）----------
  describe("时间维度：生效期与活动加成必须能取到事件发生时刻", () => {
    const CAMPAIGN = {
      campaignId: "dbl11",
      startAt: "2026-11-11T00:00:00+08:00",
      endAt: "2026-11-12T00:00:00+08:00",
      multiplier: "2",
    };
    const EFFECTIVE = { startAt: "2026-11-01T00:00:00+08:00", endAt: "2026-12-01T00:00:00+08:00" };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    /** 装配一个带时间维度的规则集与可落账的流水线产出。 */
    function mockTimeRuleSet(cfg, { effective = null, campaignDefs = [] } = {}) {
      cfg.model.findAll.mockResolvedValue([]);
      cfg.ruleSetService.getActiveRuleSet.mockResolvedValue({
        success: true,
        data: {
          config_json: {
            rewardDefs: [{ rewardId: "commission", type: "DIRECT", target: "PARENT", rate: "10" }],
            ...(effective ? { effective } : {}),
            ...(campaignDefs.length ? { campaignDefs } : {}),
          },
        },
      });
      mockBuildPipelineStages.mockReturnValue([{ id: "distribute", handler: "DISTRIBUTE", config: {} }]);
      mockExecutePipeline.mockReturnValue({
        results: {},
        final: [{ rewardId: "commission", nodeId: "u0", amount: "200" }],
        context: {},
      });
      cfg.model.create.mockResolvedValue({ id: 1, order_no: "O001", reward_id: "commission", amount: "200" });
    }

    test("事件落在生效期内：正常落账，occurredAt 与 campaignDefs 一并交给适配层", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      mockTimeRuleSet(cfg, { effective: EFFECTIVE, campaignDefs: [CAMPAIGN] });
      cfg.sequelize.transaction.mockResolvedValue(tx);
      const svc = new GenericSettlementService(cfg);

      const result = await svc.settle({
        orderNo: "O001",
        buyerId: "u1",
        amount: "1000",
        occurredAt: "2026-11-11T10:00:00+08:00",
      });

      expect(result.success).toBe(true);
      const [, opts] = mockBuildPipelineStages.mock.calls[0];
      expect(opts.occurredAt).toBe("2026-11-11T10:00:00+08:00");
      expect(mockBuildPipelineStages.mock.calls[0][0].campaignDefs).toEqual([CAMPAIGN]);
      expect(tx.commit).toHaveBeenCalledTimes(1);
    });

    test("事件在生效期之后：拒绝结算、不开事务、不落账（过期规则集不得继续发放）", async () => {
      const cfg = makeMinimalConfig();
      mockTimeRuleSet(cfg, { effective: EFFECTIVE });
      const svc = new GenericSettlementService(cfg);

      const result = await svc.settle({
        orderNo: "O001",
        buyerId: "u1",
        amount: "1000",
        occurredAt: "2026-12-05T10:00:00+08:00",
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/不在生效期内/);
      expect(result.message).toContain("左闭右开");
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
      expect(cfg.model.create).not.toHaveBeenCalled();
    });

    test("生效期右开：endAt 当刻的事件不发放", async () => {
      const cfg = makeMinimalConfig();
      mockTimeRuleSet(cfg, { effective: EFFECTIVE });
      const svc = new GenericSettlementService(cfg);

      const result = await svc.settle({
        orderNo: "O001",
        buyerId: "u1",
        amount: "1000",
        occurredAt: EFFECTIVE.endAt,
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/不在生效期内/);
    });

    test("配了活动加成但事件取不到发生时刻：拒绝结算并指名 buildOccurredAt（绝不用当前时间兜底）", async () => {
      const cfg = makeMinimalConfig();
      mockTimeRuleSet(cfg, { campaignDefs: [CAMPAIGN] });
      const svc = new GenericSettlementService(cfg);

      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });

      expect(result.success).toBe(false);
      expect(result.message).toContain("campaignDefs 活动加成");
      expect(result.message).toContain("buildOccurredAt");
      expect(result.message).toMatch(/不会用当前时间兜底/);
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
      expect(cfg.model.create).not.toHaveBeenCalled();
    });

    test("buildOccurredAt 钩子可指向宿主自己的时间字段（如 paid_at）", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      mockTimeRuleSet(cfg, { campaignDefs: [CAMPAIGN] });
      cfg.sequelize.transaction.mockResolvedValue(tx);
      const buildOccurredAt = jest.fn((event) => event.paid_at);
      const svc = new GenericSettlementService({ ...cfg, buildOccurredAt });

      const result = await svc.settle({
        orderNo: "O001",
        buyerId: "u1",
        amount: "1000",
        paid_at: "2026-11-11T23:59:59+08:00",
      });

      expect(result.success).toBe(true);
      expect(buildOccurredAt).toHaveBeenCalledTimes(1);
      expect(mockBuildPipelineStages.mock.calls[0][1].occurredAt).toBe("2026-11-11T23:59:59+08:00");
    });

    test("生效期或事件时刻没写时区偏移：拒绝结算（不猜「在」或「不在」窗口内）", async () => {
      const cfg = makeMinimalConfig();
      mockTimeRuleSet(cfg, { effective: { startAt: "2026-11-01", endAt: "2026-12-01" } });
      const svc = new GenericSettlementService(cfg);

      const result = await svc.settle({
        orderNo: "O001",
        buyerId: "u1",
        amount: "1000",
        occurredAt: "2026-11-11T10:00:00+08:00",
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/生效期或事件时刻非法/);
      expect(result.message).toMatch(/带偏移量的 ISO-8601/);
      expect(cfg.sequelize.transaction).not.toHaveBeenCalled();
    });

    test("无时间维度的规则集：不取时刻、occurredAt 传 null（既有接入方零影响）", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      mockTimeRuleSet(cfg, {});
      cfg.sequelize.transaction.mockResolvedValue(tx);
      const buildOccurredAt = jest.fn(() => "2026-11-11T10:00:00+08:00");
      const svc = new GenericSettlementService({ ...cfg, buildOccurredAt });

      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });

      expect(result.success).toBe(true);
      expect(buildOccurredAt).not.toHaveBeenCalled();
      expect(mockBuildPipelineStages.mock.calls[0][1].occurredAt).toBeNull();
    });

    test("缺省 buildOccurredAt 读事件的 occurredAt 字段，支持 Date 实例", async () => {
      const tx = makeMockTransaction();
      const cfg = makeMinimalConfig();
      mockTimeRuleSet(cfg, { effective: EFFECTIVE });
      cfg.sequelize.transaction.mockResolvedValue(tx);
      const svc = new GenericSettlementService(cfg);
      const at = new Date("2026-11-11T02:00:00Z");

      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000", occurredAt: at });

      expect(result.success).toBe(true);
      expect(mockBuildPipelineStages.mock.calls[0][1].occurredAt).toBe(at);
    });
  });

  // ---------- list ----------
  describe("list", () => {
    test("分页参数转发到 findAndCountAll", async () => {
      const cfg = makeMinimalConfig();
      cfg.model.findAndCountAll.mockResolvedValue({ rows: [{ id: 1 }], count: 1 });
      const svc = new GenericSettlementService(cfg);
      const result = await svc.list({ page: 2, pageSize: 10, where: { status: "settled" } });
      expect(result.list).toHaveLength(1);
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.total).toBe(1);
      expect(cfg.model.findAndCountAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 10 }));
    });

    test("缺省参数使用默认值", async () => {
      const cfg = makeMinimalConfig();
      cfg.model.findAndCountAll.mockResolvedValue({ rows: [], count: 0 });
      const svc = new GenericSettlementService(cfg);
      await svc.list();
      expect(cfg.model.findAndCountAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 20, offset: 0 }));
    });
  });

  // ---------- getByWhere ----------
  describe("getByWhere", () => {
    test("空条件抛出", async () => {
      const svc = new GenericSettlementService(makeMinimalConfig());
      await expect(svc.getByWhere({})).rejects.toThrow("必须提供非空查询条件");
      await expect(svc.getByWhere(null)).rejects.toThrow("必须提供非空查询条件");
      await expect(svc.getByWhere(undefined)).rejects.toThrow("必须提供非空查询条件");
    });

    test("合法查询返回结果", async () => {
      const cfg = makeMinimalConfig();
      cfg.model.findOne.mockResolvedValue({ id: 1, order_no: "O001" });
      const svc = new GenericSettlementService(cfg);
      const result = await svc.getByWhere({ order_no: "O001" });
      expect(result).toEqual({ id: 1, order_no: "O001" });
      expect(cfg.model.findOne).toHaveBeenCalledWith({ where: { order_no: "O001" } });
    });
  });
});