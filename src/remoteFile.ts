import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import * as vscode from "vscode";

const MAX_BYTES = 1536 * 1024 * 1024;

export type ReadMode = "local" | "wsl" | "remote";

export interface OpenedPickle {
  filePath: string;
  mode: ReadMode;
  bytes: number;
}

export function modeLabel(mode: ReadMode): string {
  switch (mode) {
    case "local":
      return "本机文件";
    case "wsl":
      return "WSL 文件，本机直接读取";
    case "remote":
      return "远程文件，本机解析，服务器无需安装扩展";
  }
}

export async function openPickleFile(uri: vscode.Uri, cacheDir: string): Promise<OpenedPickle> {
  if (uri.scheme === "file") {
    const stat = await fs.stat(uri.fsPath);
    assertSize(stat.size);
    return { filePath: uri.fsPath, mode: "local", bytes: stat.size };
  }

  for (const unc of wslUncPaths(uri)) {
    try {
      const stat = await fs.stat(unc);
      assertSize(stat.size);
      return { filePath: unc, mode: "wsl", bytes: stat.size };
    } catch {
      // This UNC path is not visible locally. Try the next candidate.
    }
  }

  const stat = await vscode.workspace.fs.stat(uri);
  assertSize(stat.size);
  const filePath = await cacheRemoteFile(uri, stat, cacheDir);
  return { filePath, mode: "remote", bytes: stat.size };
}

function assertSize(size: number): void {
  if (size > MAX_BYTES) {
    throw new Error(`文件有 ${formatSize(size)}，超过 1.5 GB，已停止预览。`);
  }
}

async function cacheRemoteFile(uri: vscode.Uri, stat: vscode.FileStat, cacheDir: string): Promise<string> {
  await fs.mkdir(cacheDir, { recursive: true });
  const id = crypto.createHash("sha256").update(uri.toString()).digest("hex");
  const destination = path.join(cacheDir, `${id}.pkl`);
  const metaPath = `${destination}.meta`;
  const stamp = `${stat.mtime}:${stat.size}`;
  try {
    const [meta, existing] = await Promise.all([fs.readFile(metaPath, "utf8"), fs.stat(destination)]);
    if (meta.trim() === stamp && existing.size === stat.size) {
      return destination;
    }
  } catch {
    // Cache miss or a previous download was interrupted.
  }

  const data = await vscode.workspace.fs.readFile(uri);
  const partial = `${destination}.part`;
  await fs.writeFile(partial, data);
  await fs.rename(partial, destination);
  await fs.writeFile(metaPath, stamp, "utf8");
  return destination;
}

function wslUncPaths(uri: vscode.Uri): string[] {
  if (process.platform !== "win32" || uri.scheme !== "vscode-remote" || !uri.authority.startsWith("wsl+")) {
    return [];
  }
  const distro = decodeURIComponent(uri.authority.slice("wsl+".length));
  if (!distro || /[\\/]/.test(distro)) {
    return [];
  }
  const rest = uri.path.replace(/\//g, "\\");
  return [`\\\\wsl$\\${distro}${rest}`, `\\\\wsl.localhost\\${distro}${rest}`];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
