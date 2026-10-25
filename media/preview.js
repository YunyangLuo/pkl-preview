(function () {
  const vscode = acquireVsCodeApi();
  const fileName = document.getElementById("fileName");
  const meta = document.getElementById("meta");
  const status = document.getElementById("status");
  const stubs = document.getElementById("stubs");
  const tree = document.getElementById("tree");
  const expandInput = document.getElementById("expandArrays");
  const maxItemsInput = document.getElementById("maxItems");
  const filterInput = document.getElementById("filter");
  const refreshButton = document.getElementById("refresh");

  let payload = null;
  let query = "";
  const expanded = new Set();
  let itemsTimer = 0;

  expandInput.addEventListener("change", () => {
    vscode.postMessage({ type: "expandArrays", value: expandInput.checked });
  });

  maxItemsInput.addEventListener("change", postMaxItems);
  maxItemsInput.addEventListener("input", () => {
    window.clearTimeout(itemsTimer);
    itemsTimer = window.setTimeout(postMaxItems, 400);
  });

  filterInput.addEventListener("input", () => {
    query = filterInput.value.trim().toLowerCase();
    renderTree();
  });

  refreshButton.addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "loading") {
      status.className = "";
      status.textContent = payload ? "正在重新解析…" : "正在读取…";
      return;
    }
    if (message.type === "error") {
      status.className = "error";
      status.textContent = message.message || "解析失败。";
      return;
    }
    if (message.type === "result") {
      payload = message;
      if (document.activeElement !== expandInput) {
        expandInput.checked = Boolean(message.expandArrays);
      }
      if (document.activeElement !== maxItemsInput) {
        maxItemsInput.value = String(message.maxItems);
      }
      fileName.textContent = message.fileName || fileName.textContent;
      const bits = [formatSize(message.fileBytes), message.modeLabel, message.format || "pickle", message.objectCount + " 个对象", message.decodeMs + " ms"].filter(Boolean);
      meta.textContent = bits.join(" · ");
      meta.title = message.pythonPath || "";
      showStubs(message.stubs || [], Boolean(message.nodeLimitHit));
      status.className = "";
      status.textContent = "";
      resetExpanded(message.root);
      renderTree();
    }
  });

  vscode.postMessage({ type: "ready" });

  function postMaxItems() {
    const value = Number(maxItemsInput.value);
    if (!Number.isFinite(value)) {
      return;
    }
    vscode.postMessage({ type: "maxItems", value: Math.min(5000, Math.max(1, Math.trunc(value))) });
  }

  function showStubs(items, nodeLimitHit) {
    const lines = [];
    if (items.length) {
      lines.push("这些类型没能导入，下面是占位结果。请换一个已经安装对应库的 Python（设置 pklPreview.pythonPath）：");
      lines.push(items.join("\n"));
    }
    if (nodeLimitHit) {
      lines.push("节点太多，树被截断了。可以关闭展开数组，或减小每层项数。");
    }
    if (!lines.length) {
      stubs.hidden = true;
      stubs.textContent = "";
      return;
    }
    stubs.hidden = false;
    stubs.textContent = lines.join("\n");
  }

  function resetExpanded(node) {
    expanded.clear();
    walkDefaults(node, "", 0);
  }

  function walkDefaults(node, path, depth) {
    if (!node || !node.children || !node.children.length || depth >= 2) {
      return;
    }
    expanded.add(path);
    node.children.forEach((child) => {
      walkDefaults(child.value, path + "/" + child.key, depth + 1);
    });
  }

  function renderTree() {
    tree.replaceChildren();
    if (!payload || !payload.root) {
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "tree";
    const item = renderItem(payload.root, null, "", 0);
    if (item) {
      ul.append(item);
      if (!status.classList.contains("error")) {
        status.textContent = "";
      }
    } else if (!status.classList.contains("error")) {
      status.textContent = query ? "没有匹配。" : "";
    }
    tree.append(ul);
  }

  function renderItem(node, key, path, depth) {
    if (query && !anyMatch(node, key)) {
      return null;
    }
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    const children = node.children || [];
    const childPath = path;
    const forceOpen = Boolean(query) && children.some((child) => anyMatch(child.value, child.key));
    const open = forceOpen || expanded.has(childPath);

    if (children.length) {
      const twist = document.createElement("button");
      twist.type = "button";
      twist.className = "twist";
      twist.textContent = open ? "▾" : "▸";
      twist.addEventListener("click", () => {
        const childList = li.querySelector(":scope > ul");
        if (!childList) {
          return;
        }
        const willOpen = childList.hasAttribute("hidden");
        twist.textContent = willOpen ? "▾" : "▸";
        if (willOpen) {
          childList.removeAttribute("hidden");
          expanded.add(childPath);
        } else {
          childList.setAttribute("hidden", "");
          expanded.delete(childPath);
        }
      });
      row.append(twist);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      row.append(spacer);
    }

    if (key !== null && key !== undefined) {
      const keyEl = document.createElement("span");
      keyEl.className = "key";
      keyEl.textContent = key;
      row.append(keyEl);
    }
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = node.kind || "value";
    row.append(kind);
    if (node.summary) {
      const summary = document.createElement("span");
      summary.className = "summary";
      summary.textContent = node.summary;
      row.append(summary);
    }
    const preview = previewText(node);
    if (preview) {
      const previewEl = document.createElement("span");
      previewEl.className = "preview";
      previewEl.textContent = preview;
      row.append(previewEl);
    }
    li.append(row);

    if (node.kind === "dataframe" && node.columns && node.rows) {
      li.append(renderTable(node));
    }

    if (children.length) {
      const list = document.createElement("ul");
      if (!open) {
        list.setAttribute("hidden", "");
      }
      children.forEach((child) => {
        const childItem = renderItem(child.value, child.key, childPath + "/" + child.key, depth + 1);
        if (childItem) {
          list.append(childItem);
        }
      });
      if (node.truncated) {
        const more = document.createElement("li");
        more.className = "more";
        const total = node.childCount ?? node.length;
        const hidden = typeof total === "number" ? total - children.length : 0;
        more.textContent = hidden > 0 ? "还有 " + hidden + " 项未显示" : "还有更多项未显示";
        list.append(more);
      }
      li.append(list);
    }
    return li;
  }

  function renderTable(node) {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    const head = document.createElement("tr");
    node.columns.forEach((column, index) => {
      const cell = document.createElement("th");
      cell.textContent = column;
      if (node.dtypes && node.dtypes[index]) {
        cell.title = node.dtypes[index];
      }
      head.append(cell);
    });
    const thead = document.createElement("thead");
    thead.append(head);
    const tbody = document.createElement("tbody");
    node.rows.forEach((row) => {
      const tr = document.createElement("tr");
      row.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        tr.append(cell);
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    if (node.truncated) {
      const note = document.createElement("div");
      note.className = "more";
      const rows = node.rows.length;
      const cols = node.columns.length;
      note.textContent = "表中显示 " + rows + " 行 × " + cols + " 列，完整大小是 " + (node.summary || "");
      wrap.append(note);
    }
    return wrap;
  }

  function previewText(node) {
    if (!node.preview || !node.preview.length) {
      return "";
    }
    if (node.kind === "bytes" || node.kind === "object" || node.kind === "error" || node.kind === "ref") {
      return node.preview.join(" ");
    }
    const total = node.childCount ?? node.length;
    const more = typeof total === "number" && total > node.preview.length;
    return "[" + node.preview.join(", ") + (more ? ", …" : "") + "]";
  }

  function anyMatch(node, key) {
    if (!node) {
      return false;
    }
    if (matches(node, key)) {
      return true;
    }
    if (node.rows) {
      for (const row of node.rows) {
        if (row.join(" ").toLowerCase().includes(query)) {
          return true;
        }
      }
    }
    for (const child of node.children || []) {
      if (anyMatch(child.value, child.key)) {
        return true;
      }
    }
    return false;
  }

  function matches(node, key) {
    if (!query) {
      return true;
    }
    const parts = [key, node.kind, node.summary, node.dtype];
    if (node.preview) {
      parts.push(node.preview.join(" "));
    }
    if (node.columns) {
      parts.push(node.columns.join(" "));
    }
    return parts
      .filter((part) => part !== undefined && part !== null)
      .join(" ")
      .toLowerCase()
      .includes(query);
  }

  function formatSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) {
      return size + " B";
    }
    if (size < 1024 * 1024) {
      return (size / 1024).toFixed(1) + " KB";
    }
    if (size < 1024 * 1024 * 1024) {
      return (size / 1024 / 1024).toFixed(1) + " MB";
    }
    return (size / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }
})();
