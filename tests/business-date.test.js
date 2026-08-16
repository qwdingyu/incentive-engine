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