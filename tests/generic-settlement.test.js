/**
 * @usethink/incentive-engine GenericSettlementService 单元测试
 *
 * 通用结算服务（框架服务层）的单元测试，覆盖：
 * - 构造函数校验（必填项、依赖注入）
 * - _validateEvent 事件守卫
 * - settle 幂等快路径 / 完整流程 / 唯一约束兜底 / 异常上抛
 * - batchSettle 批量原子性（全部成功 / 部分失败全回滚）
 * - list 分页转发、getByWhere 空条件拒绝
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

jest.mock("../src/engine", () => ({
  Orchestrate: { executePipeline: mockExecutePipeline },
}));

jest.mock("../src/adapters", () => ({
  buildPipelineStages: mockBuildPipelineStages,
}));

jest.mock("../src/utils", () => ({
  normalizePagination: mockNormalizePagination,
}));

// Mock sequelize（可选 peer）— 工厂内联定义，避免引用外部变量
jest.mock("sequelize", () => {
  const UCE = class UniqueConstraintError extends Error {
    constructor(msg) { super(msg); this.name = "SequelizeUniqueConstraintError"; }
  };
  return { UniqueConstraintError: UCE };
}, { virtual: true });

// ===================== 导入被测试模块 =====================

const { GenericSettlementService, REQUIRED_CONFIG_KEYS } = require("../src/services/generic-settlement.service");

// ===================== 辅助函数 =====================

/** 创建一个最小可用的 mock 客户配置 */
function makeMinimalConfig(overrides = {}) {
  return {
    name: "测试客户",
    ruleSetCode: "test_v1",
    model: {
      create: jest.fn(),
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
      const { UniqueConstraintError } = require("sequelize");
      cfg.model.create.mockRejectedValue(new UniqueConstraintError("重复键冲突"));
      const svc = new GenericSettlementService(cfg);
      const result = await svc.settle({ orderNo: "O001", buyerId: "u1", amount: "1000" });
      expect(result).toEqual({ success: true, data: { lines: [dupRecord] }, idempotent: true });
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(tx.commit).not.toHaveBeenCalled();
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

    test("部分失败全部回滚", async () => {
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
      await expect(svc.batchSettle(events)).rejects.toThrow("落账失败");
      expect(tx.rollback).toHaveBeenCalledTimes(1);
      expect(tx.commit).not.toHaveBeenCalled();
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