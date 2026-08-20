/**
 * @usethink/incentive-engine business-date 纯函数单元测试
 *
 * 覆盖 formatDateInTimezone / addBusinessDays / dateDiff 三个纯函数。
 * 不依赖任何外部服务，无需 mock。
 *
 * @version 1.0.0
 */

const { formatDateInTimezone, addBusinessDays, dateDiff } = require("../src/utils/business-date");

describe("business-date 纯函数（引擎 Utils）", () => {
  describe("formatDateInTimezone", () => {
    it("UTC 时间按上海时区格式化（跨日）", () => {
      expect(formatDateInTimezone(new Date("2026-07-06T18:30:00Z"), "Asia/Shanghai")).toBe("2026-07-07");
    });

    it("UTC 时间按上海时区格式化（同一天）", () => {
      expect(formatDateInTimezone("2026-07-06T10:00:00Z", "Asia/Shanghai")).toBe("2026-07-06");
    });

    it("接受字符串和 Date 对象输入", () => {
      const dateStr = "2026-07-06T18:30:00Z";
      const dateObj = new Date(dateStr);
      expect(formatDateInTimezone(dateStr, "Asia/Shanghai")).toBe(formatDateInTimezone(dateObj, "Asia/Shanghai"));
    });

    it("支持不同时区", () => {
      // 东京 UTC+9，比上海早 1 小时
      expect(formatDateInTimezone("2026-07-06T18:30:00Z", "Asia/Tokyo")).toBe("2026-07-07");
      // 纽约 UTC-5（夏令时），比上海晚 12/13 小时
      expect(formatDateInTimezone("2026-07-06T18:30:00Z", "America/New_York")).toBe("2026-07-06");
    });
  });

  describe("addBusinessDays", () => {
    it("正数天数", () => {
      expect(addBusinessDays("2026-07-06", 3)).toBe("2026-07-09");
    });

    it("负数天数", () => {
      expect(addBusinessDays("2026-07-06", -1)).toBe("2026-07-05");
    });

    it("零天不变", () => {
      expect(addBusinessDays("2026-07-06", 0)).toBe("2026-07-06");
    });

    it("跨月边界", () => {
      expect(addBusinessDays("2026-07-31", 2)).toBe("2026-08-02");
    });

    it("跨年边界", () => {
      expect(addBusinessDays("2026-12-31", 1)).toBe("2027-01-01");
    });

    it("跨时区一致性（P1-2）：DST 切换日不重复/不跳日", () => {
      // 2026-03-08 是 America/New_York 的 DST 开始日（本地时钟拨快 1 小时）。
      // 修复前：本地 setDate + toISOString 会把 03-08+1 拉回 03-08（重复产出），
      // 03-09 被跳过。修复后：纯 UTC 算术，任何时区结果一致。
      // 断言在默认时区下结果正确（跨时区断言由 CI 矩阵的 TZ 环境变量覆盖）。
      expect(addBusinessDays("2026-03-08", 1)).toBe("2026-03-09");
      expect(addBusinessDays("2026-03-07", 1)).toBe("2026-03-08");
      // 秋季 DST 结束日（2026-11-01，本地时钟拨慢 1 小时）同样不受影响
      expect(addBusinessDays("2026-11-01", 1)).toBe("2026-11-02");
    });

    it("跨时区一致性（P1-2）：dateDiff 在 DST 切换日跨日差为 1", () => {
      // 修复前：本地时区下 03-08 到 03-09 是 23 小时日，(b-a)/86400000 ≈ 0.958，
      // Math.round 会误判为 1（碰巧对），但 03-07 到 03-08 是 24 小时日。
      // 关键断言：DST 切换日前后相邻两天差必须精确为 1（纯 UTC 保证）。
      expect(dateDiff("2026-03-07", "2026-03-08")).toBe(1);
      expect(dateDiff("2026-03-08", "2026-03-09")).toBe(1);
      expect(dateDiff("2026-11-01", "2026-11-02")).toBe(1);
    });
  });

  describe("dateDiff", () => {
    it("正数差", () => {
      expect(dateDiff("2026-07-06", "2026-07-10")).toBe(4);
    });

    it("负数差", () => {
      expect(dateDiff("2026-07-10", "2026-07-06")).toBe(-4);
    });

    it("同一天为零", () => {
      expect(dateDiff("2026-07-06", "2026-07-06")).toBe(0);
    });

    it("相邻天", () => {
      expect(dateDiff("2026-07-06", "2026-07-07")).toBe(1);
    });

    it("跨月计算", () => {
      expect(dateDiff("2026-07-31", "2026-08-02")).toBe(2);
    });
  });
});