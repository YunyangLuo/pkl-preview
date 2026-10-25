# PKL Preview

在 Cursor / VS Code 里预览 Python pickle 文件（`.pkl`、`.pickle`、`.pck`）。扩展声明为 **UI 扩展**，只在你自己的电脑上运行。Remote SSH 打开服务器上的文件夹时，不用在服务器执行 Install on SSH。

预览是一棵只读树。工具栏上的 **展开数组** 决定 list、tuple、set、ndarray 和 tensor 要不要展开成子节点：

- 关闭：只显示长度、形状、dtype，以及前几项预览。大数组不会整表倒出来。
- 打开：按层展开元素。每一层最多显示多少项，用旁边的数字框调整。

字典会照常展开，不受这个开关影响。

## 安装

在本机窗口里安装，不要选 Install on SSH。如果之前已经装进了服务器，在远程窗口里把服务器上的那份卸掉。

```powershell
cd $env:USERPROFILE\Documents\Cursor\cursor-plugin\pkl-preview
npm install
npm run compile
npx @vscode/vsce package
cursor --install-extension pkl-preview-0.1.1.vsix
```

安装后执行 **Developer: Reload Window**。打开任意 `.pkl` 文件，或在资源管理器里右键选择 **用 PKL Preview 打开**。仓库里的 `samples/demo.pkl` 是一个小样例，里面有 list 和 ndarray。

远程文件经已经连上的 Cursor 连接读到本机，再用本机 Python 解析。WSL 里的文件如果本机 `\\wsl$\` 能看到，就直接读，不复制。服务器上只需要 Cursor 自己的 Remote Server，不需要这个扩展。

需要本机 Python 3.8 或更高版本。扩展会依次尝试 `pklPreview.pythonPath`、本机工作区 `.venv`、`py -3` 和 `python`。文件里如果有 numpy、pandas、torch 或自定义类，这些库要装在本机 Python 里。服务器上的解释器不会被使用。

## 设置

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `pklPreview.expandArrays` | `false` | 是否展开数组。预览工具栏里的开关会记住这个选择 |
| `pklPreview.maxItems` | `50` | 每一层最多显示多少项 |
| `pklPreview.maxDepth` | `12` | 最多展开多少层 |
| `pklPreview.pythonPath` | 空 | 本机 python.exe。留空则自动查找。远程解释器不会被使用 |
| `pklPreview.maxStringLength` | `400` | 字符串和 repr 的最大长度 |
| `pklPreview.timeoutSeconds` | `120` | 单个文件的解析时间上限 |

工具栏里的过滤框只筛选已经取回的内容，不会重新读文件。点 **刷新**，或保存该文件，会重新解析。

## 安全

pickle 反序列化会执行文件里的代码。请只打开可信文件。工作区处于受限模式时，这个预览不会加载文件。

缺失的类会显示成占位对象，并在预览顶部列出没能导入的模块。这种情况下数组内容可能不完整，换一个装了对应库的解释器即可。
