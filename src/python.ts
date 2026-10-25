import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import * as vscode from "vscode";

export interface TreeNode {
  kind: string;
  summary?: string;
  length?: number;
  childCount?: number;
  truncated?: boolean;
  shape?: number[];
  dtype?: string;
  preview?: string[];
  columns?: string[];
  dtypes?: string[];
  rows?: string[][];
  columnCount?: number;
  children?: Array<{ key: string; value: TreeNode }>;
}

export interface InspectSuccess {
  ok: true;
  format: string;
  root: TreeNode;
  imports: string[];
  stubs: string[];
  objectCount: number;
  elapsedMs: number;
  nodeLimitHit: boolean;
  pythonPath: string;
}

export class CancelledError extends Error {
  constructor() {
    super("已取消");
    this.name = "CancelledError";
  }
}

export interface InspectHooks {
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
  isCancelled?: () => boolean;
}

interface InspectRequest {
  extensionPath: string;
  filePath: string;
  pythonPath: string;
  interpreterPath: string;
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  expandArrays: boolean;
  maxItems: number;
  maxDepth: number;
  maxString: number;
  timeoutSeconds: number;
}

const STDOUT_LIMIT = 32 * 1024 * 1024;

export async function inspectPickle(request: InspectRequest, hooks: InspectHooks = {}): Promise<InspectSuccess> {
  const python = await resolvePython(request.pythonPath, request.interpreterPath, request.workspaceFolders);
  const script = path.join(request.extensionPath, "python", "inspect_pkl.py");
  try {
    await fs.access(script);
  } catch {
    throw new Error(`找不到解析脚本：${script}`);
  }
  const args = [
    "-W",
    "ignore",
    script,
    request.filePath,
    "--expand-arrays",
    request.expandArrays ? "1" : "0",
    "--max-items",
    String(request.maxItems),
    "--max-depth",
    String(request.maxDepth),
    "--max-string",
    String(request.maxString),
    "--preview-items",
    String(Math.min(6, request.maxItems)),
  ];
  const payload = await runPython(python, args, request.timeoutSeconds, hooks);
  if (!payload || typeof payload !== "object") {
    throw new Error("Python 返回了无法识别的结果。");
  }
  const record = payload as { ok?: boolean; error?: string };
  if (!record.ok) {
    throw new Error(record.error || "解析 pickle 失败。");
  }
  const success = payload as InspectSuccess;
  success.pythonPath = python;
  return success;
}

export async function resolvePython(
  configured: string,
  interpreterPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined
): Promise<string> {
  const candidates: Array<{ command: string; args: string[] }> = [];
  const add = async (command: string, args: string[] = []) => {
    if (!command) {
      return;
    }
    candidates.push({ command, args });
  };

  if (configured.trim()) {
    await addExecutableOrDirectory(configured.trim(), add);
  }
  if (interpreterPath.trim() && interpreterPath.trim() !== configured.trim()) {
    await addExecutableOrDirectory(interpreterPath.trim(), add);
  }
  for (const folder of workspaceFolders ?? []) {
    const root = folder.uri.scheme === "file" ? folder.uri.fsPath : "";
    if (!root) {
      continue;
    }
    candidates.push(
      { command: path.join(root, ".venv", "Scripts", "python.exe"), args: [] },
      { command: path.join(root, "venv", "Scripts", "python.exe"), args: [] },
      { command: path.join(root, ".venv", "bin", "python"), args: [] },
      { command: path.join(root, "venv", "bin", "python"), args: [] }
    );
  }
  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3"] });
  }
  candidates.push({ command: "python3", args: [] }, { command: "python", args: [] });
  for (const discovered of await installedPythons()) {
    candidates.push({ command: discovered, args: [] });
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.command}\n${candidate.args.join(" ")}`;
    if (seen.has(key) || isRemotePath(candidate.command)) {
      continue;
    }
    seen.add(key);
    const found = await probe(candidate.command, candidate.args);
    if (found) {
      return found;
    }
  }
  throw new Error(
    "找不到可用的本机 Python。PKL Preview 只在本机运行，远程文件也会用本机 Python 解析，不会使用服务器上的解释器。请安装 Python 3.8 或更高版本，或在设置 pklPreview.pythonPath 里填写本机 python.exe 的完整路径。Windows 商店的 python.exe 占位程序不能用。"
  );
}

function isRemotePath(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  return command.startsWith("/") && !command.startsWith("//");
}

async function addExecutableOrDirectory(
  value: string,
  add: (command: string, args?: string[]) => Promise<void>
): Promise<void> {
  const stat = await fs.stat(value).catch(() => undefined);
  if (stat?.isDirectory()) {
    await add(path.join(value, "python.exe"));
    await add(path.join(value, "python"));
    await add(path.join(value, "bin", "python"));
    return;
  }
  await add(value);
}

async function installedPythons(): Promise<string[]> {
  const roots: string[] = [];
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, "Programs", "Python"));
  }
  if (process.env.ProgramFiles) {
    roots.push(path.join(process.env.ProgramFiles, "Python"));
  }
  const found: Array<{ version: number; file: string }> = [];
  for (const root of roots) {
    const entries = await fs.readdir(root).catch(() => []);
    for (const entry of entries) {
      const version = Number(/\d+/.exec(entry)?.[0] ?? 0);
      found.push({ version, file: path.join(root, entry, process.platform === "win32" ? "python.exe" : "python") });
    }
  }
  found.sort((a, b) => b.version - a.version);
  return found.map((item) => item.file);
}

function probe(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args, "-c", "import sys; print(sys.executable)"], {
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1" },
      });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 8000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
        .pop();
      if (code === 0 && line && !/windowsapps/i.test(line)) {
        resolve(line);
        return;
      }
      resolve(undefined);
    });
  });
}

function runPython(
  python: string,
  args: string[],
  timeoutSeconds: number,
  hooks: InspectHooks
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    hooks.onChild?.(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`解析超过 ${timeoutSeconds} 秒，已停止。可以把数组保持折叠，或调大 pklPreview.timeoutSeconds。`));
    }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > STDOUT_LIMIT) {
        child.kill();
        finish(new Error("解析结果太大。请关闭“展开数组”，或把每层最多项数调小。"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 100_000) {
        stderr = stderr.slice(-100_000);
      }
    });
    child.on("error", (error) => {
      finish(new Error(`无法启动 Python（${python}）：${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (hooks.isCancelled?.() || signal) {
        finish(new CancelledError());
        return;
      }
      const detail = stderr.trim();
      try {
        const payload = parseJson(stdout);
        if (payload && typeof payload === "object" && "ok" in payload && (payload as { ok?: boolean }).ok === false) {
          finish(new Error(String((payload as { error?: string }).error || "解析 pickle 失败。")));
          return;
        }
        if (code !== 0) {
          finish(new Error(detail ? `Python 退出码 ${code}。\n${detail.slice(-2000)}` : `Python 退出码 ${code}。`));
          return;
        }
        finish(undefined, payload);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        finish(new Error(detail ? `${reason}\n${detail.slice(-2000)}` : reason));
      }
    });
  });
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Python 没有返回结果。");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Python 没有返回 JSON。");
  }
}
