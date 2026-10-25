"""Turn a pickle file into a JSON tree for the PKL Preview editor.

stdout is a single JSON object. Diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import pickle
import sys
import time
import traceback
import warnings

warnings.filterwarnings("ignore")

MAX_NODES = 20000


class Budget:
    def __init__(self, limit: int) -> None:
        self.left = limit

    def take(self) -> bool:
        if self.left <= 0:
            return False
        self.left -= 1
        return True


class TolerantUnpickler(pickle._Unpickler):
    dispatch = pickle._Unpickler.dispatch.copy()

    def __init__(self, file, **kwargs) -> None:
        super().__init__(file, **kwargs)
        self.imports: set[str] = set()
        self.stubs: set[str] = set()

    def find_class(self, module, name):
        qual = f"{module}.{name}"
        self.imports.add(qual)
        try:
            return super().find_class(module, name)
        except Exception:
            self.stubs.add(qual)
            return make_stub(module, name)

    def persistent_load(self, pid):
        return {"__persistent__": safe_repr(pid, 200)}

    def load_setitem(self):
        value = self.stack.pop()
        key = self.stack.pop()
        assign_item(self.stack[-1], key, value)

    dispatch[pickle.SETITEM[0]] = load_setitem

    def load_setitems(self):
        items = self.pop_mark()
        target = self.stack[-1]
        for index in range(0, len(items), 2):
            assign_item(target, items[index], items[index + 1])

    dispatch[pickle.SETITEMS[0]] = load_setitems


def assign_item(target, key, value) -> None:
    try:
        target[key] = value
    except Exception:
        try:
            bag = object.__getattribute__(target, "_pkl_preview_items")
        except Exception:
            bag = None
        if not isinstance(bag, dict):
            bag = {}
            try:
                object.__setattr__(target, "_pkl_preview_items", bag)
            except Exception:
                return
        bag[key] = value


def make_stub(module: str, name: str):
    class Stub(dict):
        def __new__(cls, *args, **kwargs):
            obj = dict.__new__(cls)
            object.__setattr__(obj, "_module", module)
            object.__setattr__(obj, "_name", name)
            object.__setattr__(obj, "_args", args)
            object.__setattr__(obj, "_kwargs", kwargs)
            object.__setattr__(obj, "_list_items", [])
            return obj

        def __init__(self, *args, **kwargs) -> None:
            if len(args) == 1 and isinstance(args[0], dict) and not kwargs:
                self.update(args[0])
            elif kwargs and not args:
                self.update(kwargs)

        def __setstate__(self, state) -> None:
            object.__setattr__(self, "_state", state)
            if isinstance(state, dict):
                self.update(state)
            elif isinstance(state, tuple) and state and isinstance(state[0], dict):
                self.update(state[0])

        def append(self, item) -> None:
            object.__getattribute__(self, "_list_items").append(item)

        def extend(self, items) -> None:
            object.__getattribute__(self, "_list_items").extend(items)

        def add(self, item) -> None:
            object.__getattribute__(self, "_list_items").append(item)

        def __call__(self, *args, **kwargs):
            return make_stub(module, name)(*args, **kwargs)

        def __repr__(self) -> str:
            return f"<{module}.{name} stub>"

    Stub.__name__ = name
    Stub.__module__ = module
    Stub.__qualname__ = name
    Stub._pkl_preview_stub = True
    return Stub


class Inspector:
    def __init__(self, expand_arrays: bool, max_items: int, max_depth: int, max_string: int, preview_items: int) -> None:
        self.expand_arrays = expand_arrays
        self.max_items = max(1, max_items)
        self.max_depth = max(1, max_depth)
        self.max_string = max(20, max_string)
        self.preview_items = max(0, preview_items)
        self.budget = Budget(MAX_NODES)
        self.visiting: set[int] = set()

    def build(self, objs: list) -> dict:
        if len(objs) == 1:
            root = self.convert(objs[0], 0)
        else:
            children = []
            for index, obj in enumerate(objs):
                if index >= self.max_items:
                    break
                children.append({"key": f"#{index}", "value": self.convert(obj, 1)})
            root = {
                "kind": "pickle",
                "summary": f"{len(objs)} 个对象",
                "length": len(objs),
                "childCount": len(objs),
                "children": children,
                "truncated": len(objs) > len(children),
            }
        return root

    def convert(self, obj, depth: int) -> dict:
        simple = unwrap_scalar(obj)
        if is_simple(simple):
            return scalar_node(simple, self.max_string)
        marker = id(obj)
        if marker in self.visiting:
            return {"kind": "ref", "summary": "循环引用 " + short_type(obj)}
        if not self.budget.take():
            return {"kind": "truncated", "summary": "已达到节点上限"}
        self.visiting.add(marker)
        try:
            return self.convert_inner(obj, depth)
        except Exception as exc:
            return {"kind": "error", "summary": f"{short_type(obj)}: {exc}"}
        finally:
            self.visiting.discard(marker)

    def convert_inner(self, obj, depth: int) -> dict:
        if isinstance(obj, memoryview):
            obj = obj.tobytes()
        if isinstance(obj, (bytes, bytearray)):
            return bytes_node(bytes(obj), self.max_string)
        if is_dataframe(obj):
            return self.dataframe_node(obj)
        if is_series(obj):
            return self.series_node(obj, depth)
        if is_array(obj):
            return self.array_node(obj, depth)
        if isinstance(obj, dict):
            node = self.dict_node(obj, depth)
            if type(obj) is not dict:
                saved = node["summary"]
                node["kind"] = "object"
                node["summary"] = short_type(obj)
                if node.get("truncated") and "已达最大深度" in saved:
                    node["summary"] += " · 已达最大深度"
            return node
        extra = preview_items(obj)
        if extra:
            node = self.dict_node(extra, depth)
            node["kind"] = "object"
            node["summary"] = short_type(obj)
            return node
        if isinstance(obj, (list, tuple, set, frozenset)):
            return self.sequence_node(obj, depth)
        return self.object_node(obj, depth)

    def dict_node(self, obj: dict, depth: int) -> dict:
        total = len(obj)
        node: dict = {"kind": "dict", "summary": f"{total} 项", "length": total, "childCount": total}
        if depth >= self.max_depth:
            node["truncated"] = True
            node["summary"] = f"{total} 项 · 已达最大深度"
            return node
        children = []
        for index, (key, value) in enumerate(obj.items()):
            if index >= self.max_items:
                break
            children.append({"key": format_key(key, self.max_string), "value": self.convert(value, depth + 1)})
        node["children"] = children
        node["truncated"] = total > len(children)
        return node

    def sequence_node(self, obj, depth: int) -> dict:
        kind = type(obj).__name__
        total = len(obj)
        node: dict = {"kind": kind, "summary": f"{total} 项", "length": total, "childCount": total}
        preview_count = min(self.preview_items, total)
        taken = take(obj, preview_count)
        if taken:
            node["preview"] = [self.preview_of(item) for item in taken]
        if self.expand_arrays and depth < self.max_depth:
            count = min(total, self.max_items)
            items = take(obj, count)
            node["children"] = [
                {"key": f"[{index}]", "value": self.convert(item, depth + 1)} for index, item in enumerate(items)
            ]
            node["truncated"] = total > len(node["children"])
        elif depth >= self.max_depth and self.expand_arrays:
            node["truncated"] = True
            node["summary"] = f"{total} 项 · 已达最大深度"
        return node

    def array_node(self, obj, depth: int) -> dict:
        shape = tuple(int(x) for x in obj.shape)
        dtype = str(getattr(obj, "dtype", "?"))
        if dtype.startswith("torch."):
            dtype = dtype[len("torch.") :]
        kind = array_kind(obj)
        total = numel(shape)
        node: dict = {
            "kind": kind,
            "summary": f"shape={shape} dtype={dtype}",
            "shape": list(shape),
            "dtype": dtype,
            "length": total,
        }
        preview = []
        for index in range(min(self.preview_items, total)):
            try:
                preview.append(format_scalar(flat_at(obj, index), self.max_string))
            except Exception as exc:
                preview.append(f"无法读取: {exc}")
                break
        if preview:
            node["preview"] = preview
        if self.expand_arrays and depth < self.max_depth and shape:
            axis = shape[0]
            count = min(axis, self.max_items)
            children = []
            for index in range(count):
                try:
                    child = obj[index]
                except Exception as exc:
                    child_node = {"kind": "error", "summary": str(exc)}
                else:
                    child_node = self.convert(child, depth + 1)
                children.append({"key": f"[{index}]", "value": child_node})
            node["children"] = children
            node["childCount"] = axis
            node["truncated"] = axis > len(children)
        elif self.expand_arrays and depth >= self.max_depth:
            node["truncated"] = True
            node["summary"] += " · 已达最大深度"
        return node

    def dataframe_node(self, obj) -> dict:
        rows_n = int(obj.shape[0])
        cols_n = int(obj.shape[1])
        col_limit = min(cols_n, 40 if self.expand_arrays else 8)
        row_limit = min(rows_n, self.max_items if self.expand_arrays else min(self.preview_items, self.max_items))
        columns = [format_key(obj.columns[index], self.max_string) for index in range(col_limit)]
        dtypes: list[str] = []
        try:
            for index in range(col_limit):
                dtypes.append(str(obj.dtypes.iloc[index]))
        except Exception:
            dtypes = []
        rows = []
        for row_index in range(row_limit):
            row = []
            for col_index in range(col_limit):
                try:
                    row.append(self.preview_of(obj.iloc[row_index, col_index]))
                except Exception as exc:
                    row.append(f"无法读取: {exc}")
            rows.append(row)
        return {
            "kind": "dataframe",
            "summary": f"{rows_n}×{cols_n}",
            "columns": columns,
            "dtypes": dtypes,
            "rows": rows,
            "length": rows_n,
            "childCount": rows_n,
            "columnCount": cols_n,
            "truncated": rows_n > row_limit or cols_n > col_limit,
        }

    def series_node(self, obj, depth: int) -> dict:
        total = int(obj.shape[0])
        dtype = str(getattr(obj, "dtype", ""))
        node: dict = {"kind": "series", "summary": f"{total} 项 dtype={dtype}", "length": total, "dtype": dtype}
        count = min(total, self.max_items if self.expand_arrays else min(self.preview_items, self.max_items))
        if self.expand_arrays and depth < self.max_depth:
            children = []
            for index in range(count):
                try:
                    label = format_key(obj.index[index], self.max_string)
                    value = self.convert(obj.iloc[index], depth + 1)
                except Exception as exc:
                    label = f"[{index}]"
                    value = {"kind": "error", "summary": str(exc)}
                children.append({"key": label, "value": value})
            node["children"] = children
            node["childCount"] = total
            node["truncated"] = total > len(children)
        else:
            preview = []
            for index in range(count):
                try:
                    preview.append(self.preview_of(obj.iloc[index]))
                except Exception as exc:
                    preview.append(f"无法读取: {exc}")
                    break
            if preview:
                node["preview"] = preview
            if not self.expand_arrays:
                node["childCount"] = total
        return node

    def object_node(self, obj, depth: int) -> dict:
        node: dict = {"kind": "object", "summary": short_type(obj)}
        state = getattr(obj, "_state", None)
        if state is None:
            raw = getattr(obj, "__dict__", None)
            if isinstance(raw, dict):
                fields = {
                    key: value
                    for key, value in raw.items()
                    if key not in {"_module", "_name", "_args", "_kwargs", "_state"}
                }
                state = fields or None
        if isinstance(state, dict) and depth < self.max_depth:
            built = self.dict_node(state, depth)
            node["children"] = built.get("children", [])
            node["length"] = built.get("length", 0)
            node["childCount"] = built.get("childCount", 0)
            if built.get("truncated"):
                node["truncated"] = True
            return node
        if state is not None and depth < self.max_depth:
            node["children"] = [{"key": "state", "value": self.convert(state, depth + 1)}]
            return node
        args = getattr(obj, "_args", None)
        if args:
            node["preview"] = [safe_repr(args, self.max_string)]
            return node
        text = safe_repr(obj, self.max_string)
        if text and text != node["summary"]:
            node["preview"] = [text]
        return node

    def preview_of(self, obj) -> str:
        simple = unwrap_scalar(obj)
        if is_simple(simple):
            return format_scalar(simple, self.max_string)
        if is_array(obj):
            shape = tuple(int(x) for x in obj.shape)
            return f"{array_kind(obj)}{shape}"
        if is_dataframe(obj):
            return f"DataFrame {int(obj.shape[0])}×{int(obj.shape[1])}"
        if is_series(obj):
            return f"Series[{int(obj.shape[0])}]"
        if isinstance(obj, dict):
            return f"dict[{len(obj)}]"
        if isinstance(obj, (list, tuple, set, frozenset)):
            return f"{type(obj).__name__}[{len(obj)}]"
        if isinstance(obj, (bytes, bytearray)):
            return f"bytes[{len(obj)}]"
        return short_type(obj)


def scalar_node(obj, max_string: int) -> dict:
    if isinstance(obj, str):
        kind = "str"
    elif isinstance(obj, bool):
        kind = "bool"
    elif isinstance(obj, int):
        kind = "int"
    elif isinstance(obj, float):
        kind = "float"
    elif isinstance(obj, complex):
        kind = "complex"
    elif isinstance(obj, dt.datetime):
        kind = "datetime"
    elif isinstance(obj, dt.date):
        kind = "date"
    elif isinstance(obj, dt.time):
        kind = "time"
    elif isinstance(obj, dt.timedelta):
        kind = "timedelta"
    elif obj is None:
        kind = "none"
    else:
        kind = type(obj).__name__
    return {"kind": kind, "summary": format_scalar(obj, max_string)}


def bytes_node(payload: bytes, max_string: int) -> dict:
    shown = payload[:16]
    text = " ".join(f"{item:02x}" for item in shown)
    if len(payload) > len(shown):
        text += " …"
    node: dict = {"kind": "bytes", "summary": f"{len(payload)} 字节", "length": len(payload)}
    if text:
        node["preview"] = [text[:max_string]]
    return node


def preview_items(obj) -> dict | None:
    try:
        bag = object.__getattribute__(obj, "_pkl_preview_items")
    except Exception:
        return None
    if isinstance(bag, dict) and bag:
        return bag
    return None


def is_simple(obj) -> bool:
    return obj is None or isinstance(obj, (bool, int, float, complex, str, dt.datetime, dt.date, dt.time, dt.timedelta))


def unwrap_scalar(obj):
    if isinstance(obj, (str, bytes, bytearray, list, tuple, dict, set, frozenset)):
        return obj
    item = getattr(obj, "item", None)
    shape = getattr(obj, "shape", None)
    module = type(obj).__module__
    if callable(item) and module.startswith(("numpy", "torch")) and (shape is None or shape == ()):
        try:
            value = item()
        except Exception:
            return obj
        if value is not obj:
            return unwrap_scalar(value)
    return obj


def is_dataframe(obj) -> bool:
    kind = type(obj)
    return kind.__name__ == "DataFrame" and kind.__module__.startswith("pandas")


def is_series(obj) -> bool:
    kind = type(obj)
    return kind.__name__ == "Series" and kind.__module__.startswith("pandas")


def is_array(obj) -> bool:
    if isinstance(obj, (str, bytes, bytearray, list, tuple, dict, set, frozenset)):
        return False
    shape = getattr(obj, "shape", None)
    if not isinstance(shape, tuple) or len(shape) < 1:
        return False
    try:
        values = [int(item) for item in shape]
    except Exception:
        return False
    if any(item < 0 for item in values):
        return False
    module = type(obj).__module__
    if module.startswith(("numpy", "torch")):
        return True
    return hasattr(obj, "dtype") and hasattr(obj, "reshape")


def array_kind(obj) -> str:
    module = type(obj).__module__
    if module.startswith("numpy"):
        return "ndarray"
    if module.startswith("torch"):
        return "tensor"
    return "array"


def numel(shape: tuple[int, ...]) -> int:
    total = 1
    for item in shape:
        total *= item
    return total


def flat_at(obj, index: int):
    if hasattr(obj, "reshape"):
        return obj.reshape(-1)[index]
    return obj[index]


def take(obj, count: int) -> list:
    if count <= 0:
        return []
    if isinstance(obj, (list, tuple)):
        return list(obj[:count])
    items = []
    for item in obj:
        items.append(item)
        if len(items) >= count:
            break
    return items


def format_scalar(obj, max_string: int) -> str:
    obj = unwrap_scalar(obj)
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, float):
        if math.isnan(obj):
            return "NaN"
        if math.isinf(obj):
            return "Infinity" if obj > 0 else "-Infinity"
        return repr(obj)
    if isinstance(obj, complex):
        return str(obj)
    if isinstance(obj, str):
        text = obj if len(obj) <= max_string else obj[:max_string] + "…"
        return json.dumps(text, ensure_ascii=False)
    if isinstance(obj, (dt.datetime, dt.date, dt.time)):
        return obj.isoformat()
    if isinstance(obj, dt.timedelta):
        return str(obj)
    return short_type(obj)


def format_key(key, max_string: int) -> str:
    key = unwrap_scalar(key)
    if isinstance(key, str):
        return key if len(key) <= max_string else key[:max_string] + "…"
    if is_simple(key):
        return format_scalar(key, max_string)
    return safe_repr(key, max_string)


def short_type(obj) -> str:
    kind = type(obj)
    if kind.__module__ in ("builtins", "__builtin__"):
        return kind.__name__
    return f"{kind.__module__}.{kind.__name__}"


def safe_repr(obj, max_string: int) -> str:
    try:
        text = repr(obj)
    except Exception as exc:
        return f"<repr 失败: {exc}>"
    if len(text) > max_string:
        return text[:max_string] + "…"
    return text


def is_zip(path: str) -> bool:
    with open(path, "rb") as handle:
        return handle.read(2) == b"PK"


def load_pickle(path: str) -> tuple[list, TolerantUnpickler]:
    errors: list[str] = []
    for encoding in ("ASCII", "latin1"):
        try:
            with open(path, "rb") as handle:
                unpickler = TolerantUnpickler(handle, encoding=encoding)
                objs: list = []
                while True:
                    try:
                        objs.append(unpickler.load())
                    except EOFError:
                        break
            if objs:
                return objs, unpickler
            errors.append(f"{encoding}: 文件里没有 pickle 对象")
        except Exception as exc:
            errors.append(f"{encoding}: {type(exc).__name__}: {exc}")
    raise RuntimeError("无法解析 pickle。\n" + "\n".join(errors))


def load_torch(path: str) -> list:
    try:
        import torch
    except Exception as exc:
        raise RuntimeError("这是 zip 打包的 pickle（常见于 torch.save）。当前 Python 没有安装 torch，所以还不能预览。") from exc
    try:
        return [torch.load(path, map_location="cpu", weights_only=False)]
    except TypeError:
        return [torch.load(path, map_location="cpu")]


def load_objects(path: str) -> tuple[list, TolerantUnpickler | None, str]:
    if is_zip(path):
        return load_torch(path), None, "torch"
    try:
        objs, unpickler = load_pickle(path)
        return objs, unpickler, "pickle"
    except Exception as pickle_error:
        try:
            import joblib
        except Exception:
            raise pickle_error
        try:
            return [joblib.load(path)], None, "joblib"
        except Exception:
            raise pickle_error


def inspect_file(path: str, expand_arrays: bool, max_items: int, max_depth: int, max_string: int, preview_items: int) -> dict:
    started = time.perf_counter()
    objs, unpickler, source = load_objects(path)
    inspector = Inspector(expand_arrays, max_items, max_depth, max_string, preview_items)
    root = inspector.build(objs)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return {
        "ok": True,
        "format": source,
        "root": root,
        "imports": sorted(unpickler.imports)[:100] if unpickler else [],
        "stubs": sorted(unpickler.stubs)[:100] if unpickler else [],
        "objectCount": len(objs),
        "elapsedMs": elapsed_ms,
        "nodeLimitHit": inspector.budget.left <= 0,
    }


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def write_json(payload: dict) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, allow_nan=False)
    sys.stdout.write("\n")


def main(argv: list[str]) -> int:
    configure_stdio()
    if sys.version_info < (3, 8):
        write_json({"ok": False, "error": "需要 Python 3.8 或更高版本。"})
        return 1
    parser = argparse.ArgumentParser(description="Inspect a pickle file for PKL Preview.")
    parser.add_argument("path")
    parser.add_argument("--expand-arrays", type=int, default=0)
    parser.add_argument("--max-items", type=int, default=50)
    parser.add_argument("--max-depth", type=int, default=12)
    parser.add_argument("--max-string", type=int, default=400)
    parser.add_argument("--preview-items", type=int, default=6)
    args = parser.parse_args(argv)
    try:
        payload = inspect_file(
            args.path,
            bool(args.expand_arrays),
            args.max_items,
            args.max_depth,
            args.max_string,
            args.preview_items,
        )
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        write_json({"ok": False, "error": str(exc)})
        return 1
    write_json(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
