import * as vscode from "vscode";
import { PklPreviewEditorProvider } from "./editor";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(PklPreviewEditorProvider.register(context));
  context.subscriptions.push(
    vscode.commands.registerCommand("pklPreview.open", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target || !/\.(pkl|pickle|pck)$/i.test(target.path)) {
        void vscode.window.showWarningMessage("请选择 .pkl、.pickle 或 .pck 文件。");
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, PklPreviewEditorProvider.viewType);
    })
  );
}

export function deactivate(): void {}
