#!/usr/bin/env python3
"""Pipeline 服务：把文本步骤包成可查询、可取消的后台作业，供前端一键调用。
- POST /pipeline/<step>  body={"pid":"...","model":"glm-4.6"}  → {job_id}
- GET  /pipeline/jobs/<job_id>  → {status: queued|running|cancelling|cancelled|done|error, log, error}
- POST /pipeline/jobs/<job_id>/cancel → 请求终止作业
step ∈ visual-dict | shot-breakdown | unit-gen
纯标准库；作业串行(一次一个)，每项在独立子进程执行，以便真正终止运行中的任务。
启动：python pipeline_server.py  (默认 5280)
"""
from __future__ import annotations
import json, os, subprocess, sys, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
STEPS = {
    "extract-setup": [sys.executable, "-u", str(BRIDGE_DIR / "extract_setup.py")],
    "visual-dict": [sys.executable, "-u", str(BRIDGE_DIR / "visual_dict.py")],
    "shot-breakdown": [sys.executable, "-u", str(BRIDGE_DIR / "shot_breakdown.py")],
    "unit-gen": [sys.executable, "-u", str(BRIDGE_DIR / "unit_gen.py")],
}
JOBS: dict[str, dict] = {}
PROCESSES: dict[str, subprocess.Popen[str]] = {}
RUN_LOCK = threading.Lock()  # 保持原有串行语义，避免多项 pipeline 同时改写项目数据。
JOBS_LOCK = threading.Lock()


def _job_snapshot(job_id: str) -> dict | None:
    """返回可序列化的作业快照，避免 HTTP 线程直接读取正在变化的字典。"""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return dict(job) if job else None


def _run(job_id: str, step: str, pid: str, model: str):
    """在独立子进程中执行一步 pipeline；取消接口可安全终止该进程。"""
    with RUN_LOCK:
        with JOBS_LOCK:
            job = JOBS[job_id]
            if job.get("cancel_requested"):
                job["status"] = "cancelled"
                return
            job["status"] = "running"
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            process = subprocess.Popen(
                [*STEPS[step], pid, "--model", model],
                cwd=BRIDGE_DIR,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
            )
            with JOBS_LOCK:
                PROCESSES[job_id] = process
                cancel_now = bool(JOBS[job_id].get("cancel_requested"))
            if cancel_now:
                process.terminate()
            if process.stdout is not None:
                for line in process.stdout:
                    with JOBS_LOCK:
                        JOBS[job_id]["log"] += line
            return_code = process.wait()
            with JOBS_LOCK:
                job = JOBS[job_id]
                if job.get("cancel_requested"):
                    job["status"] = "cancelled"
                    job["error"] = "任务已取消"
                elif return_code == 0:
                    job["status"] = "done"
                else:
                    job["status"] = "error"
                    job["error"] = job["log"].strip().splitlines()[-1] if job["log"].strip() else f"子进程退出码 {return_code}"
        except Exception as e:  # noqa: BLE001
            with JOBS_LOCK:
                job = JOBS[job_id]
                if job.get("cancel_requested"):
                    job["status"] = "cancelled"
                    job["error"] = "任务已取消"
                else:
                    job["status"] = "error"
                    job["error"] = f"{type(e).__name__}: {e}"
        finally:
            with JOBS_LOCK:
                PROCESSES.pop(job_id, None)


def _cancel_job(job_id: str) -> dict | None:
    """登记取消请求；排队任务立即取消，运行任务终止对应子进程。"""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return None
        if job.get("status") in {"done", "error", "cancelled"}:
            return dict(job)
        job["cancel_requested"] = True
        process = PROCESSES.get(job_id)
        if process is None and job.get("status") == "queued":
            job["status"] = "cancelled"
            job["error"] = "任务已取消"
        elif process is not None:
            job["status"] = "cancelling"
        snapshot = dict(job)
    if process is not None and process.poll() is None:
        process.terminate()
    return snapshot


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
            job = _job_snapshot(jid)
            return self._send(200 if job else 404, job or {"error": "job not found"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/pipeline/jobs/") and self.path.endswith("/cancel"):
            jid = self.path.split("/")[-2]
            job = _cancel_job(jid)
            return self._send(200 if job else 404, job or {"error": "job not found"})
        if not self.path.startswith("/pipeline/"):
            return self._send(404, {"error": "not found"})
        step = self.path.split("/")[-1]
        if step not in STEPS:
            return self._send(400, {"error": f"unknown step {step}"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or "{}") if length else {}
        except (json.JSONDecodeError, ValueError):
            return self._send(400, {"error": "invalid JSON body"})
        pid = body.get("pid")
        if not pid:
            return self._send(400, {"error": "pid required"})
        model = body.get("model", "glm-4.6")
        jid = uuid.uuid4().hex
        with JOBS_LOCK:
            JOBS[jid] = {
                "status": "queued", "log": "", "error": "", "step": step, "pid": pid,
                "cancel_requested": False,
            }
        threading.Thread(target=_run, args=(jid, step, pid, model), daemon=True).start()
        self._send(200, {"job_id": jid})

    def log_message(self, *a):  # 静音访问日志
        pass


if __name__ == "__main__":
    print("pipeline server on http://127.0.0.1:5280  (steps: %s)" % ", ".join(STEPS))
    ThreadingHTTPServer(("127.0.0.1", 5280), H).serve_forever()
