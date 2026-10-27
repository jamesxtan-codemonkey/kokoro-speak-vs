"""Make the fp16 decoder compute in fp32 while still storing its weights in fp16.

For the Chrome extension. WebGPU (with shader-f16) runs an fp16 graph
genuinely in fp16, and the vocoder loses enough precision that some words
sound choppy. onnxruntime's CPU EP has few fp16 kernels and upcasts, which is
why the same decoder.onnx sounds right in the VS Code extension. Here every
fp16 weight gets a Cast to fp32 (constant-folded when the session loads, so
the file stays ~107 MB), and fp16 constants and casts become fp32. Measured
against native output, this brings WebGPU from 6.9-9.3 dB of log-spectral
distance down to 2.2-2.3 dB, the same as WASM.

    .venv-convert/bin/python tools/convert/upcast_decoder.py models/kokoro-speak/decoder.onnx models/kokoro-speak-web/decoder.onnx

chrome/build.mjs runs this when the web decoder is missing.
"""
import sys
import os
import tempfile

import onnx
from onnx import TensorProto, helper, numpy_helper

F16, F32 = TensorProto.FLOAT16, TensorProto.FLOAT


def to_f32(t):
    return numpy_helper.from_array(numpy_helper.to_array(t).astype("float32"), t.name)


def main(src, dst):
    m = onnx.load(src)
    g = m.graph
    counts = {"weights": 0, "constants": 0, "casts": 0}

    for n in g.node:
        for a in n.attribute:
            if n.op_type == "Cast" and a.name == "to" and a.i == F16:
                a.i = F32
                counts["casts"] += 1
            elif a.type == onnx.AttributeProto.TENSOR and a.t.data_type == F16:
                a.t.CopyFrom(to_f32(a.t))
                counts["constants"] += 1

    upcasts = []
    for init in g.initializer:
        if init.data_type == F16:
            name = init.name
            init.name = f"{name}__f16"
            upcasts.append(helper.make_node("Cast", [init.name], [name], to=F32, name=f"{name}__upcast"))
            counts["weights"] += 1
    nodes = upcasts + list(g.node)
    del g.node[:]
    g.node.extend(nodes)

    for v in list(g.value_info) + list(g.input) + list(g.output):
        if v.type.tensor_type.elem_type == F16:
            v.type.tensor_type.elem_type = F32

    onnx.checker.check_model(m)
    # Never leave a truncated file that the next build could reuse as a model.
    fd, tmp = tempfile.mkstemp(suffix=".onnx", dir=os.path.dirname(os.path.abspath(dst)))
    os.close(fd)
    try:
        onnx.save(m, tmp)
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print(f"upcast {counts} -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
