import pickle
from pathlib import Path

import numpy as np

matrix = np.arange(12, dtype="float32").reshape(3, 4)
matrix[0, 1] = np.nan
data = {
    "name": "pkl-preview",
    "text": "你好",
    "flags": [True, False, None],
    "nums": list(range(20)),
    "nested": {"a": (1, 2), "blob": b"\x00\x01"},
    "matrix": matrix,
}
destination = Path(__file__).resolve().parents[1] / "samples" / "demo.pkl"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_bytes(pickle.dumps(data, protocol=4))
print(destination, destination.stat().st_size)
