import type { ChildProcess } from "child_process";
import path from "path";
import * as vscode from "vscode";
import { previewHtml } from "./html";
import { CancelledError, inspectPickle } from "./python";
import { formatSize, modeLabel, openPickleFile } from "./remoteFile";

interface PreviewSettings {
  pythonPath: string;
  interpreterPath: string;
  expandArrays: boolean;
  maxItems: number;
  maxDepth: number;
  maxString: number;
  timeoutSeconds: number;
}

export class PklPreviewEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = "pklPreview.file";

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(PklPreviewEditorProvider.viewType, new PklPreviewEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  private readonly log: vscode.OutputChannel;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel("PKL Preview");
    context.subscriptions.push(this.log);
  }

  async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    let disposed = false;
    let loadId = 0;
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscriptions: vscode.Disposable[] = [];

    const stop = () => {
      if (timer) {
        clearTimeout(timer);
      }
      child?.kill();
    };
    webviewPanel.onDidDispose(() => {
      disposed = true;
      loadId += 1;
      stop();
      subscriptions.forEach((item) => item.dispose());
    });

    const load = async () => {
      const id = ++loadId;
      child?.kill();
      child = undefined;
      if (disposed) {
        return;
      }
      const settings = readSettings();
      webview.postMessage({ type: "loading" });
      if (vscode.workspace.isTrusted === false) {
        webview.postMessage({
          type: "error",
          message: "当前工作区未受信任。Pickle 预览需要反序列化，可能执行文件里的代码。请先信任该工作区。",
        });
        return;
      }
      const started = Date.now();
      try {
        const opened = await openPickleFile(document.uri, path.join(this.context.globalStorageUri.fsPath, "cache"));
        if (id !== loadId || disposed) {
          return;
        }
        this.log.appendLine(
          `解析 ${document.uri.toString()}（${formatSize(opened.bytes)}，${modeLabel(opened.mode)}，展开数组=${settings.expandArrays}）`
        );
        const result = await inspectPickle(
          {
            extensionPath: this.context.extensionPath,
            filePath: opened.filePath,
            pythonPath: settings.pythonPath,
            interpreterPath: settings.interpreterPath,
            workspaceFolders: vscode.workspace.workspaceFolders,
            expandArrays: settings.expandArrays,
            maxItems: settings.maxItems,
            maxDepth: settings.maxDepth,
            maxString: settings.maxString,
            timeoutSeconds: settings.timeoutSeconds,
          },
          {
            onChild: (next) => {
              if (id === loadId) {
                child = next;
              } else {
                next.kill();
              }
            },
            isCancelled: () => id !== loadId || disposed,
          }
        );
        if (id !== loadId || disposed) {
          return;
        }
        this.log.appendLine(
          `完成 ${baseName(document.uri)}，${result.elapsedMs} ms，Python ${result.pythonPath}，格式 ${result.format}`
        );
        webview.postMessage({
          type: "result",
          fileName: baseName(document.uri),
          fileBytes: opened.bytes,
          modeLabel: modeLabel(opened.mode),
          expandArrays: settings.expandArrays,
          maxItems: settings.maxItems,
          elapsedMs: Math.max(result.elapsedMs, Date.now() - started),
          decodeMs: result.elapsedMs,
          format: result.format,
          root: result.root,
          stubs: result.stubs,
          objectCount: result.objectCount,
          nodeLimitHit: result.nodeLimitHit,
          pythonPath: result.pythonPath,
        });
      } catch (error) {
        if (error instanceof CancelledError || id !== loadId || disposed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.log.appendLine(message);
        webview.postMessage({ type: "error", message });
      }
    };

    subscriptions.push(
      webview.onDidReceiveMessage((message: { type?: string; value?: boolean | number }) => {
        if (message?.type === "ready" || message?.type === "refresh") {
          void load();
          return;
        }
        if (message?.type === "expandArrays") {
          void updateSetting("expandArrays", Boolean(message.value));
          return;
        }
        if (message?.type === "maxItems") {
          void updateSetting("maxItems", clamp(Number(message.value), 1, 5000));
        }
      })
    );
    subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pklPreview") || event.affectsConfiguration("python.defaultInterpreterPath")) {
          void load();
        }
      })
    );
    const slash = document.uri.path.lastIndexOf("/");
    const parent = document.uri.with({ path: slash > 0 ? document.uri.path.slice(0, slash) : "/" });
    const fileName = slash >= 0 ? document.uri.path.slice(slash + 1) : document.uri.path;
    if (fileName) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parent, fileName));
      const schedule = () => {
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          void load();
        }, 400);
      };
      subscriptions.push(watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher);
    }

    const initial = readSettings();
    webview.html = previewHtml(
      webview,
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "preview.css")),
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "preview.js")),
      {
        fileName: baseName(document.uri),
        expandArrays: initial.expandArrays,
        maxItems: initial.maxItems,
      }
    );
  }
}

function readSettings(): PreviewSettings {
  const config = vscode.workspace.getConfiguration("pklPreview");
  const pythonConfig = vscode.workspace.getConfiguration("python");
  return {
    pythonPath: config.get<string>("pythonPath") ?? "",
    interpreterPath: pythonConfig.get<string>("defaultInterpreterPath") ?? "",
    expandArrays: config.get<boolean>("expandArrays") ?? false,
    maxItems: clamp(config.get<number>("maxItems") ?? 50, 1, 5000),
    maxDepth: clamp(config.get<number>("maxDepth") ?? 12, 1, 40),
    maxString: clamp(config.get<number>("maxStringLength") ?? 400, 20, 5000),
    timeoutSeconds: clamp(config.get<number>("timeoutSeconds") ?? 120, 5, 3600),
  };
}

async function updateSetting(key: "expandArrays" | "maxItems", value: boolean | number): Promise<void> {
  const config = vscode.workspace.getConfiguration("pklPreview");
  const inspected = config.inspect(key);
  const target =
    inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  const current = config.get(key);
  if (current === value) {
    return;
  }
  await config.update(key, value, target);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function baseName(uri: vscode.Uri): string {
  const parts = uri.path.split("/");
  return parts[parts.length - 1] || uri.fsPath;
}
