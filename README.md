# PKL Preview

在 Cursor / VS Code 里预览 Python pickle 文件（`.pkl`、`.pickle`、`.pck`）。

预览是一棵只读树。工具栏上的 **展开数组** 决定 list、tuple、set、ndarray 和 tensor 要不要展开成子节点：

- 关闭：只显示长度、形状、dtype，以及前几项预览。大数组不会整表倒出来。
- 打开：按层展开元素。每一层最多显示多少项，用旁边的数字框调整。

字典会照常展开，不受这个开关影响。

## 安装

在本机 Cursor 里安装：

```powershell
cd $env:USERPROFILE\Documents\Cursor\cursor-plugin\pkl-preview
npm install
npm run compile
npx @vscode/vsce package
cursor --install-extension pkl-preview-0.1.0.vsix
```

安装后执行 **Developer: Reload Window**。打开任意 `.pkl` 文件，或在资源管理器里右键选择 **用 PKL Preview 打开**。仓库里的 `samples/demo.pkl` 是一个小样例，里面有 list 和 ndarray。

需要 Python 3.8 或更高版本。扩展会依次尝试 `pklPreview.pythonPath`、Python 扩展选中的解释器、工作区 `.venv`、`py -3` 和 `python`。文件里如果有 numpy、pandas、torch 或自定义类，这个 Python 里也要能导入它们。

## 设置

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `pklPreview.expandArrays` | `false` | 是否展开数组。预览工具栏里的开关会记住这个选择 |
| `pklPreview.maxItems` | `50` | 每一层最多显示多少项 |
| `pklPreview.maxDepth` | `12` | 最多展开多少层 |
| `pklPreview.pythonPath` | 空 | 指定 python.exe。留空则自动查找 |
| `pklPreview.maxStringLength` | `400` | 字符串和 repr 的最大长度 |
| `pklPreview.timeoutSeconds` | `120` | 单个文件的解析时间上限 |

工具栏里的过滤框只筛选已经取回的内容，不会重新读文件。点 **刷新**，或保存该文件，会重新解析。

## 安全

pickle 反序列化会执行文件里的代码。请只打开可信文件。工作区处于受限模式时，这个预览不会加载文件。

缺失的类会显示成占位对象，并在预览顶部列出没能导入的模块。这种情况下数组内容可能不完整，换一个装了对应库的解释器即可。
