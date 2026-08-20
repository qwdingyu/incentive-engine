/**
 * @usethink/incentive-engine pagination 分页归一化测试
 *
 * 覆盖 normalizePagination 的收敛规则与边界：
 * - 合法输入幂等
 * - page/pageSize 非法值回退
 * - pageSize 封顶 maxPageSize
 * - offset 基于收敛后的 pageSize（防翻页错位）
 * - 自定义 maxPageSize / defaultPageSize
 *
 * @version 1.0.0
 */

const { normalizePagination } = require("../src/utils/pagination");

describe("normalizePagination", () => {
  test("合法输入幂等（可安全重复调用）", () => {
    expect(normalizePagination(2, 30)).toEqual({ page: 2, pageSize: 30, offset: 30 });
  });

  test("缺省值：page=1, pageSize=20", () => {
    expect(normalizePagination()).toEqual({ page: 1, pageSize: 20, offset: 0 });
  });

  test("page 非法值回退 1", () => {
    expect(normalizePagination(0, 20).page).toBe(1);
    expect(normalizePagination(-5, 20).page).toBe(1);
    expect(normalizePagination("abc", 20).page).toBe(1);
    expect(normalizePagination(NaN, 20).page).toBe(1);
    expect(normalizePagination(undefined, 20).page).toBe(1);
  });

  test("page 向下取整", () => {
    expect(normalizePagination(2.9, 20).page).toBe(2);
  });

  test("pageSize 非法值回退 defaultPageSize(20)", () => {
    expect(normalizePagination(1, 0).pageSize).toBe(20);
    expect(normalizePagination(1, -3).pageSize).toBe(20);
    expect(normalizePagination(1, "abc").pageSize).toBe(20);
    expect(normalizePagination(1, NaN).pageSize).toBe(20);
  });

  test("pageSize 封顶 maxPageSize(100)", () => {
    expect(normalizePagination(1, 500).pageSize).toBe(100);
    expect(normalizePagination(1, 100).pageSize).toBe(100);
  });

  test("pageSize 向下取整", () => {
    expect(normalizePagination(1, 25.7).pageSize).toBe(25);
  });

  test("offset 基于收敛后的 pageSize（防翻页错位）", () => {
    // pageSize 500 被收敛到 100，offset 必须用 100 而非 500
    expect(normalizePagination(3, 500)).toEqual({ page: 3, pageSize: 100, offset: 200 });
  });

  test("自定义 maxPageSize", () => {
    expect(normalizePagination(1, 50, { maxPageSize: 30 }).pageSize).toBe(30);
    expect(normalizePagination(1, 10, { maxPageSize: 30 }).pageSize).toBe(10);
  });

  test("自定义 defaultPageSize（非法时回退）", () => {
    expect(normalizePagination(1, 0, { defaultPageSize: 50 }).pageSize).toBe(50);
  });

  test("defaultPageSize 不超过 maxPageSize", () => {
    expect(normalizePagination(1, 0, { maxPageSize: 10, defaultPageSize: 50 }).pageSize).toBe(10);
  });

  test("maxPageSize 非法值回退 100", () => {
    expect(normalizePagination(1, 500, { maxPageSize: "abc" }).pageSize).toBe(100);
  });
});
