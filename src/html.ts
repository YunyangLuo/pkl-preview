import * as vscode from "vscode";

export interface PreviewPage {
  fileName: string;
  expandArrays: boolean;
  maxItems: number;
}

export function previewHtml(webview: vscode.Webview, styleUri: vscode.Uri, scriptUri: vscode.Uri, page: PreviewPage): string {
  const nonce = randomNonce();
  const csp = webview.cspSource;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" nonce="${nonce}" href="${styleUri}" />
  <title>PKL Preview</title>
</head>
<body>
  <header>
    <div class="titles">
      <strong id="fileName">${escapeHtml(page.fileName)}</strong>
      <span id="meta"></span>
    </div>
    <label class="switch" title="勾选后把 list、tuple、set、ndarray 和 tensor 的元素展开成树。取消则只显示长度、形状和前几项。">
      <input type="checkbox" id="expandArrays" ${page.expandArrays ? "checked" : ""} />
      <span>展开数组</span>
    </label>
    <label class="limit">每层最多
      <input type="number" id="maxItems" min="1" max="5000" step="1" value="${page.maxItems}" />
      项
    </label>
    <input type="search" id="filter" placeholder="过滤键或值" />
    <button type="button" id="refresh">刷新</button>
  </header>
  <p class="warn">只打开可信文件。读取 pickle 会反序列化，并可能执行其中的代码。</p>
  <div id="stubs" hidden></div>
  <div id="status">正在读取…</div>
  <div id="tree"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += chars[Math.floor(Math.random() * chars.length)];
  }
  return nonce;
}
