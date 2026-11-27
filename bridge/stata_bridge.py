"""JSON-lines bridge in front of Stata's own embedded engine (pystata + mp-64.dll).

The Node MCP server spawns this once and keeps it alive, so the Stata session
(loaded data, estimates, macros) survives across tool calls.

Two threads on purpose:
  * the reader thread owns stdin. It answers `status` from a cached snapshot and
    handles `break` by calling StataSO_SetBreak immediately -- a request that
    must not queue behind the command it is meant to interrupt.
  * the worker thread runs Stata, one command at a time, and replies when done.

Protocol: one JSON object per line on stdin, one per line on stdout.
  -> {"id": 1, "op": "status"}
  <- {"id": 1, "ok": true, "result": {...}}
  -> {"id": 2, "op": "run", "code": "sysuse auto", "cwd": "D:/work"}
  <- {"id": 2, "ok": true, "result": {"output": "...", "rc": 0, "interrupted": false}}
  -> {"id": 3, "op": "break"}
  <- {"id": 3, "ok": true, "result": {"requested": true}}
Never write anything else to stdout; diagnostics go to stderr.
"""

import ctypes
import io
import json
import os
import queue
import re
import sys
import tempfile
import threading
import traceback
from contextlib import redirect_stdout

STATA_HOME = os.environ.get("STATA_COPILOT_STATA_HOME", "D:/")
EDITION = os.environ.get("STATA_COPILOT_EDITION", "mp")

# Stata's embedded engine writes its transcript straight to file descriptor 1,
# not through Python's sys.stdout. Hand fd 1 to stderr and keep a private copy
# for the JSON frames, otherwise the first `display` would corrupt the stream.
_JSON_FD = os.dup(1)
os.dup2(2, 1)
JSON_OUT = os.fdopen(_JSON_FD, "w", buffering=1, encoding="utf-8", errors="replace")
sys.stdout = JSON_OUT

OUT_LOCK = threading.Lock()
BUSY = threading.Event()
STOP = threading.Event()
TASKS = queue.Queue()


def emit(payload):
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    with OUT_LOCK:
        JSON_OUT.write(line)
        JSON_OUT.flush()


def log(message):
    sys.stderr.write("[stata-bridge] %s\n" % message)
    sys.stderr.flush()


def _bootstrap():
    utilities = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if utilities not in sys.path:
        sys.path.append(utilities)
    from pystata import config

    config.init(EDITION, splash=False)
    from pystata import stata

    home = STATA_HOME.rstrip("/\\") or "/"
    lib_path = "%s/%s-64.dll" % (home, EDITION)
    if not os.path.isfile(lib_path):
        lib_path = "%s/%s.dll" % (home, EDITION)
    lib = ctypes.cdll.LoadLibrary(lib_path)
    lib.StataSO_SetBreak.argtypes = [ctypes.c_int]
    lib.StataSO_SetBreak.restype = None
    return config, stata, lib


CONFIG, STAT, STLIB = _bootstrap()


def _capture(code):
    """Run `code` with Stata's output redirected to a temp file; return (text, error)."""
    handle, path = tempfile.mkstemp(suffix=".log", prefix="stata-copilot-")
    os.close(handle)
    error = None
    try:
        CONFIG.set_output_file(path, replace=True)
        try:
            STAT.run(code, echo=True)
        except Exception as exc:
            error = exc
        finally:
            try:
                CONFIG.close_output_file()
            except Exception:
                pass
        with io.open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return text, error


def _last_line(text):
    for line in reversed(text.splitlines()):
        if line.strip():
            return line.strip()
    return None


def _snapshot():
    """Ask Stata who it is, once, while nothing else is running.

    Each value comes from its own capture: the log echoes the command first and
    leaves a blank line before the result, so parsing a combined transcript is
    guesswork.
    """
    info = {"stataHome": STATA_HOME, "edition": EDITION, "python": sys.version.split()[0]}
    for key, command in (
        ("version", "display c(version)"),
        ("editionName", "display c(edition)"),
        ("date", "display c(current_date)"),
    ):
        text, error = _capture(command)
        if error is None:
            info[key] = _last_line(text)

    # A throwaway dataset tells us whether the license is live.
    text, error = _capture("sysuse auto, clear\ndisplay _N")
    if error is None:
        info["license"] = True
        info["observations"] = _last_line(text)
    else:
        info["license"] = False
        info["licenseError"] = str(error).strip().splitlines()[0][:300]
    return info


STATUS = _snapshot()


def _return_code():
    text, _ = _capture("display _rc")
    for token in reversed(text.split()):
        if token.lstrip("-").isdigit():
            return int(token)
    return 1


def run_code(code, cwd):
    previous = os.getcwd()
    try:
        if cwd:
            os.chdir(cwd)
        output, error = _capture(code)
    finally:
        if cwd:
            os.chdir(previous)

    interrupted = "--Break--" in output
    rc = 0
    if error is not None:
        # pystata raises SystemError whose text ends in `r(NNN);` -- that is the
        # Stata return code, and it is more reliable than re-reading `_rc`.
        match = re.search(r"r\((\d+)\)", str(error))
        rc = int(match.group(1)) if match else _return_code()
    result = {
        "output": output,
        "rc": rc,
        "interrupted": bool(interrupted),
        "busy": False,
    }
    if error is not None:
        result["error"] = str(error).strip().splitlines()[0][:400]
    return result


def worker():
    while not STOP.is_set():
        request = TASKS.get()
        if request is None:
            break
        if request.get("cancelled"):
            continue
        BUSY.set()
        try:
            code = request.get("code") or ""
            cwd = request.get("cwd")
            if not code.strip():
                result = {"output": "", "rc": 0, "interrupted": False}
            else:
                result = run_code(code, cwd)
            emit({"id": request["id"], "ok": True, "result": result})
        except Exception:
            emit(
                {
                    "id": request.get("id"),
                    "ok": False,
                    "error": traceback.format_exc(limit=2).strip().splitlines()[-1],
                }
            )
        finally:
            BUSY.clear()
            TASKS.task_done()


def main():
    worker_thread = threading.Thread(target=worker, name="stata-worker", daemon=True)
    worker_thread.start()
    log("ready: Stata %s (%s) from %s" % (STATUS.get("version"), STATUS.get("editionName"), STATA_HOME))

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            request = json.loads(raw)
        except ValueError:
            emit({"id": None, "ok": False, "error": "bad json"})
            continue
        op = request.get("op")
        if op == "status":
            emit({"id": request.get("id"), "ok": True, "result": dict(STATUS, busy=BUSY.is_set())})
        elif op == "break":
            # Deliberately not queued: this is the one request that must overtake
            # the running command. Stata honours the flag at its next check point.
            STLIB.StataSO_SetBreak(1)
            emit({"id": request.get("id"), "ok": True, "result": {"requested": True, "busy": BUSY.is_set()}})
        elif op == "run":
            if BUSY.is_set() or not TASKS.empty():
                emit(
                    {
                        "id": request.get("id"),
                        "ok": False,
                        "error": "another command is already running; send break to interrupt it",
                        "code": "BUSY",
                    }
                )
                continue
            TASKS.put(request)
        elif op == "shutdown":
            emit({"id": request.get("id"), "ok": True, "result": {"bye": True}})
            break
        else:
            emit({"id": request.get("id"), "ok": False, "error": "unknown op: %s" % op})

    STOP.set()
    TASKS.put(None)
    worker_thread.join(timeout=5)


if __name__ == "__main__":
    main()
