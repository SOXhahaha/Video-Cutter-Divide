"""
Batch OCR worker using RapidOCR.
Reads JSON from stdin: [{"path": "...", "timestamp": 0.0}, ...]
Writes JSON to stdout: [{"timestamp": 0.0, "text": "...", "confidence": 0.95}, ...]
Auto-selects GPU (DirectML/CUDA) if available, falls back to CPU.
"""
import sys
import json
import onnxruntime as ort
from rapidocr_onnxruntime import RapidOCR

def pick_providers():
    available = ort.get_available_providers()
    for p in ['DmlExecutionProvider', 'CUDAExecutionProvider']:
        if p in available:
            return [p, 'CPUExecutionProvider']
    return ['CPUExecutionProvider']

def main():
    raw = sys.stdin.read()
    items = json.loads(raw)

    providers = pick_providers()
    engine = RapidOCR(
        det_use_cuda='CUDAExecutionProvider' in providers,
        rec_use_cuda='CUDAExecutionProvider' in providers,
        cls_use_cuda='CUDAExecutionProvider' in providers,
        det_use_dml='DmlExecutionProvider' in providers,
        rec_use_dml='DmlExecutionProvider' in providers,
        cls_use_dml='DmlExecutionProvider' in providers,
    )
    results = []

    for item in items:
        path = item["path"]
        ts = item["timestamp"]
        try:
            result, _ = engine(path)
            if result:
                texts = [line[1] for line in result]
                confs = [line[2] for line in result]
                text = " ".join(texts)
                conf = sum(confs) / len(confs) if confs else 0.0
            else:
                text = ""
                conf = 0.0
        except Exception:
            text = ""
            conf = 0.0

        results.append({"timestamp": ts, "text": text, "confidence": conf})

    sys.stdout.write(json.dumps(results, ensure_ascii=False))

if __name__ == "__main__":
    main()
