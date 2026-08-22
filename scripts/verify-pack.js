// 发布就绪自检：prepublishOnly 钩子入口。
// 目的：在真实 `npm publish` 前用 `npm pack --dry-run --json` 断言 tarball 必备文件齐全，
//       避免漏带 LICENSE/README/src 入口导致发版后元数据不完整（发版零阻塞防线）。
// 用法：node scripts/verify-pack.js
// 失败即 process.exit(1)，阻止 npm publish 继续。
const { execFileSync } = require("child_process");

// 必备文件清单（相对 tarball 根）；npm 会自动包含 LICENSE/README/package.json/main，
// 此处显式断言以兜底未来误改 files 白名单。
const REQUIRED_FILES = [
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "package.json",
  "src/index.js",
  "src/index.d.ts",
  // v4.1.0：./pure 子入口。exports 映射已把它列为公开子路径，
  // 漏带会让消费方 `import ... from "@usethink/incentive-engine/pure"` 直接解析失败。
  "src/pure.js",
  "src/pure.d.ts",
];

// 禁止进入 tarball 的目录前缀：内部审查报告、评估文档、Demo 与测试不应随包分发。
const FORBIDDEN_PREFIXES = ["docs/", "demo/", "tests/", "scripts/"];

/**
 * 运行 npm pack --dry-run --json 并断言必备文件齐全、禁发目录未混入。
 * 返回解析出的 tarball 文件名与文件总数，任何缺失/越界即抛错。
 */
function verifyPack() {
  let stdout;
  try {
    // --json 输出为 [{ filename, files:[{path,size,mode}] }]
    stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
    });
  } catch (e) {
    throw new Error("npm pack --dry-run 执行失败：" + (e.message || String(e)));
  }

  const parsed = JSON.parse(stdout);
  const meta = parsed && parsed[0];
  if (!meta || !Array.isArray(meta.files)) {
    throw new Error("无法解析 npm pack --json 输出，已中止发布");
  }

  const paths = meta.files.map((f) => f.path);
  const missing = REQUIRED_FILES.filter((p) => !paths.includes(p));
  if (missing.length > 0) {
    throw new Error("tarball 缺失必备文件：" + missing.join(", ") + "，请检查 files 白名单");
  }

  const leaked = paths.filter((p) => FORBIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix)));
  if (leaked.length > 0) {
    throw new Error(
      "tarball 混入了禁发路径（" + FORBIDDEN_PREFIXES.join(", ") + "）：" +
      leaked.slice(0, 10).join(", ") + (leaked.length > 10 ? ` 等 ${leaked.length} 项` : "") +
      "，请收敛 files 白名单"
    );
  }
  return { filename: meta.filename, total: meta.files.length };
}

let result;
try {
  result = verifyPack();
  // eslint-disable-next-line no-console
  console.log(
    `[verify-pack] ✓ 发布就绪校验通过：${result.filename}，共 ${result.total} 个文件，必备文件齐全（${REQUIRED_FILES.join(", ")}）`
  );
} catch (e) {
  // eslint-disable-next-line no-console
  console.error("[verify-pack] ✗ " + e.message);
  process.exit(1);
}