#!/usr/bin/env python3
"""Pipeline 服务：把文本三步(视觉词典/镜头分镜/视听单元)包成 HTTP，供前端一键调用。
- POST /pipeline/<step>  body={"pid":"...","model":"glm-4.6"}  → {job_id}
- GET  /pipeline/jobs/<job_id>  → {status: running|done|error, log, error}
step ∈ visual-dict | shot-breakdown | unit-gen
纯标准库；作业串行(一次一个)，线程后台跑，stdout 收进 log。
启动：python pipeline_server.py  (默认 5280)
"""
from __future__ import annotations
import io, json, threading, uuid, contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import visual_dict, shot_breakdown, unit_gen, extract_setup

STEPS = {
    "extract-setup": extract_setup.run,
    "visual-dict": visual_dict.run,
    "shot-breakdown": shot_breakdown.run,
    "unit-gen": unit_gen.run,
}
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()  # 作业串行，避免并发 stdout 冲突


def _run(job_id: str, step: str, pid: str, model: str):
    with LOCK:
        job = JOBS[job_id]
        job["status"] = "running"
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                STEPS[step](pid, model)
            job["status"] = "done"
        except SystemExit as e:
            job["status"] = "error"; job["error"] = str(e)
        except Exception as e:  # noqa: BLE001
            job["status"] = "error"; job["error"] = f"{type(e).__name__}: {e}"
        finally:
            job["log"] = buf.getvalue()


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.startswith("/pipeline/jobs/"):
            jid = self.path.rsplit("/", 1)[-1]
            job = JOBS.get(jid)
            return self._send(200 if job else 404, job or {"error": "job not found"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/pipeline/"):
            return self._send(404, {"error": "not found"})
        step = self.path.split("/")[-1]
        if step not in STEPS:
            return self._send(400, {"error": f"unknown step {step}"})
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or "{}") if length else {}
        pid = body.get("pid")
        if not pid:
            return self._send(400, {"error": "pid required"})
        model = body.get("model", "glm-4.6")
        jid = uuid.uuid4().hex
        JOBS[jid] = {"status": "queued", "log": "", "error": "", "step": step, "pid": pid}
        threading.Thread(target=_run, args=(jid, step, pid, model), daemon=True).start()
        self._send(200, {"job_id": jid})

    def log_message(self, *a):  # 静音访问日志
        pass


if __name__ == "__main__":
    print("pipeline server on http://localhost:5280  (steps: %s)" % ", ".join(STEPS))
    ThreadingHTTPServer(("0.0.0.0", 5280), H).serve_forever()
