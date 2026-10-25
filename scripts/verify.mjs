import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "python", "inspect_pkl.py");
const python = findPython();

if (!python) {
  console.error("找不到 Python，无法验证 pickle 解析。");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkl-preview-test-"));
const sample = path.join(dir, "sample.pkl");
const cycle = path.join(dir, "cycle.pkl");
const missing = path.join(dir, "missing.pkl");
const optimize = path.join(dir, "optimize.pkl");
const xpFile = path.join(dir, "xp.pkl");
const linop = path.join(dir, "linop.pkl");
let failed = 0;

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert(Array.isArray(pkg.extensionKind) && pkg.extensionKind.includes("ui"), "扩展应声明为只在本机运行");

  const created = spawnSync(
    python,
    [
      "-c",
      `
import pickle, math
data = {
  "name": "pkl-preview",
  "text": "你好",
  "nan": float("nan"),
  "flags": [True, False, None],
  "nums": list(range(20)),
  "nested": {"a": (1, 2), "blob": b"\\x00\\x01pickle"},
}
try:
    import numpy as np
    matrix = np.arange(12, dtype="float32").reshape(3, 4)
    matrix[0, 1] = np.nan
    data["matrix"] = matrix
except Exception:
    data["matrix"] = [[1.0, float("nan")], [3.0, 4.0]]
with open(r"""${sample}""", "wb") as handle:
    pickle.dump(data, handle, protocol=4)
items = []
items.append(items)
with open(r"""${cycle}""", "wb") as handle:
    pickle.dump(items, handle, protocol=4)
class Box:
    def __init__(self):
        self.x = [1, 2, 3]
with open(r"""${missing}""", "wb") as handle:
    pickle.dump(Box(), handle, protocol=4)
class OptimizeResult(dict):
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc
    __setattr__ = dict.__setitem__
result = OptimizeResult()
result["x"] = [0.1, 0.2, 0.3]
result["success"] = True
result["fun"] = 0.25
result["message"] = "ok"
with open(r"""${optimize}""", "wb") as handle:
    pickle.dump(result, handle, protocol=4)
import sys
sys.path.insert(0, r"""${path.join(root, "python")}""")
import sample_types
xp = sample_types.NeedsXp()
xp.shape = (3, 3)
xp.note = "kept"
with open(r"""${xpFile}""", "wb") as handle:
    pickle.dump({"op": xp}, handle, protocol=4)
try:
    import numpy as np
    from scipy.sparse.linalg._interface import LinearOperator
    op = object.__new__(LinearOperator)
    op.dtype = np.dtype("float64")
    op.shape = (4, 4)
    op.ndim = 2
    original = LinearOperator.__getstate__
    LinearOperator.__getstate__ = lambda self: {"dtype": self.dtype, "shape": self.shape, "ndim": self.ndim}
    try:
        with open(r"""${linop}""", "wb") as handle:
            pickle.dump({"hess_inv": op}, handle, protocol=4)
    finally:
        LinearOperator.__getstate__ = original
except Exception:
    pass
`,
    ],
    { encoding: "utf8" }
  );
  assert(created.status === 0, created.stderr || created.stdout || "生成样例失败");

  const collapsed = run(sample, ["--expand-arrays", "0", "--max-items", "10"]);
  const nums = child(collapsed.root, "nums");
  const nested = child(collapsed.root, "nested");
  const matrix = child(collapsed.root, "matrix");
  const text = child(collapsed.root, "text");
  assert(collapsed.root.kind === "dict", "根节点应该是 dict");
  assert(!nums.children, "关闭展开数组时，list 不应有子节点");
  assert(nums.preview && nums.preview[0] === "0" && nums.length === 20, "折叠的 list 应保留前几项预览");
  assert(nested.children && child(nested, "a"), "字典在折叠数组时仍然展开");
  assert(!matrix.children, "关闭展开数组时，数组不应有子节点");
  assert(child(collapsed.root, "nan").summary === "NaN", "应显示 NaN");
  assert(text.summary.includes("你好"), "应保留中文");

  const expanded = run(sample, ["--expand-arrays", "1", "--max-items", "10"]);
  const expandedNums = child(expanded.root, "nums");
  assert(expandedNums.children && expandedNums.children.length === 10, "展开数组时应按上限显示 10 项");
  assert(expandedNums.truncated === true, "超过上限应标记截断");
  assert(expandedNums.children[0].value.summary === "0", "展开后的第一项应是 0");
  const expandedMatrix = child(expanded.root, "matrix");
  assert(expandedMatrix.children && expandedMatrix.children.length >= 2, "展开后的矩阵应有行");

  const cycled = run(cycle, ["--expand-arrays", "1", "--max-items", "5"]);
  assert(cycled.ok === true, "循环引用不应导致解析失败");
  const stubbed = run(missing, ["--expand-arrays", "0"]);
  assert(stubbed.ok === true, "缺失的类应降级为占位对象");
  assert((stubbed.stubs || []).some((item) => item.includes("Box")), "应报告未能导入的类");
  const optimized = run(optimize, ["--expand-arrays", "0"]);
  assert((optimized.stubs || []).some((item) => item.includes("OptimizeResult")), "应报告未能导入 OptimizeResult");
  assert(child(optimized.root, "success").summary === "true", "应读出 OptimizeResult.success");
  assert(child(optimized.root, "fun").summary === "0.25", "应读出 OptimizeResult.fun");
  const solution = child(optimized.root, "x");
  assert(solution.kind === "list" && !solution.children, "OptimizeResult 里的数组在关闭展开时保持折叠");
  assert((solution.preview || []).includes("0.1"), "应预览 OptimizeResult.x");
  const restored = run(xpFile, ["--expand-arrays", "0"]);
  const operator = child(restored.root, "op");
  assert(child(operator, "note").summary.includes("kept"), "缺少 _xp 时仍应保留其他字段");
  assert((child(operator, "shape").preview || []).includes("3"), "缺少 _xp 时仍应保留 shape");
  if (fs.existsSync(linop)) {
    const loaded = run(linop, ["--expand-arrays", "0"]);
    const hess = child(loaded.root, "hess_inv");
    const hessShape = child(hess, "shape");
    const shown = [...(hessShape.preview || []), hessShape.summary || ""].join(" ");
    assert(shown.includes("4"), "旧 LinearOperator 应保留 shape");
  }

  const broken = spawnSync(python, ["-W", "ignore", script, path.join(dir, "nope.pkl")], { encoding: "utf8" });
  const brokenPayload = JSON.parse(broken.stdout);
  assert(brokenPayload.ok === false, "缺失文件应返回 ok:false");

  console.log("verify ok:", python);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  failed = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(failed);

function run(file, args) {
  const result = spawnSync(python, ["-W", "ignore", script, file, ...args], {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  if (!result.stdout.trim()) {
    throw new Error(result.stderr || "没有 JSON 输出");
  }
  const payload = JSON.parse(result.stdout);
  if (!payload.ok) {
    throw new Error(payload.error + (result.stderr ? "\n" + result.stderr : ""));
  }
  return payload;
}

function child(node, key) {
  const found = (node.children || []).find((item) => item.key === key);
  if (!found) {
    throw new Error("找不到键 " + key);
  }
  return found.value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function findPython() {
  const candidates = [
    process.env.PYTHON,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "python.exe"),
    "py",
    "python",
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true });
    const line = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
    if (result.status === 0 && line && !/windowsapps/i.test(line)) {
      return line;
    }
  }
  return "";
}
