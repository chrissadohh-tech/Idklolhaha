#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
studio_mcp_host.py - ORscript's Studio MCP host (no compiler required).

Exactly the trick ZeroScript uses: their bridge is Python, so it never has to be
built. This is a tiny stdlib-only MCP *proxy* that sits between or-agent.exe and
Roblox Studio's own StudioMCP.exe:

    or-agent.exe  <--stdio MCP-->  studio_mcp_host.py  <--stdio MCP-->  StudioMCP.exe

Two jobs.

1. FIND STUDIO. %LOCALAPPDATA%\\Roblox\\mcp.bat hard-codes one Studio version
   folder, so it breaks after every Studio update. This discovers the newest
   StudioMCP.exe instead, preferring version folders that still contain
   RobloxStudioBeta.exe / RobloxStudio.exe (an update leaves "zombie" folders
   whose StudioMCP.exe launches but attaches to nothing), then falls back to
   mcp.bat. Same discovery as launch_studio_mcp.py - override with
   OR_STUDIO_MCP_PATH.

2. KEEP THE PICTURE. Studio answers screen_capture with an MCP *image* content
   item and (almost) no text. or-agent.exe 1.18.0 forwards text items only, so
   the picture was dropped inside the binary and the tool came back as an empty
   string. Every image item is rewritten here into a text item

       <<OR_IMAGE mimeType="image/png" bytes=12345>>
       <base64>
       <<OR_END>>

   which the extension decodes back into an image and attaches to the chat. Same
   destination as the rebuilt agent produces natively - no toolchain needed.

3. READ FILES BACK. Blender hands ORscript a PNG on disk and the extension reads
   it back through the agent's read_file_base64 - also a 1.18.1 tool. The host
   adds or_host_read_image for that: same PC, same bytes, image item -> marker.

Everything else is forwarded byte-for-byte, so all 27 Studio tools behave
exactly as before.

CLI:
    python studio_mcp_host.py --check      show which StudioMCP.exe would be used
    python studio_mcp_host.py --selftest   fake Studio, assert the image round-trip
"""

import base64
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, "studio_mcp_host.log")
LOG_MAX = 256 * 1024
MARK = "<<OR_IMAGE"
END = "<<OR_END>>"
INIT_TIMEOUT = 30.0
LIST_TIMEOUT = 30.0
CALL_TIMEOUT = 120.0
CREATE_NO_WINDOW = 0x08000000


def log(msg):
    """Diagnostics go to a file: our stdout IS the MCP channel."""
    try:
        if os.path.isfile(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX:
            with open(LOG_PATH, "rb") as fh:
                tail = fh.read()[-LOG_MAX // 2:]
            with open(LOG_PATH, "wb") as fh:
                fh.write(b"...(truncated)\n" + tail)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("%s  %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def say(msg):
    """Console output for --check / --selftest only (ASCII, so cp1252 consoles
    cannot raise UnicodeEncodeError)."""
    try:
        sys.stdout.write(msg + "\n")
        sys.stdout.flush()
    except Exception:
        pass


# ── discovery ───────────────────────────────────────────────────────────────

def _version_roots():
    roots = []
    local = os.environ.get("LOCALAPPDATA")
    if local:
        roots.append(os.path.join(local, "Roblox", "Versions"))
        roots.append(os.path.join(local, "Roblox", "Versions", "RobloxStudio"))
    for key in ("ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"):
        base = os.environ.get(key)
        if base:
            roots.append(os.path.join(base, "Roblox", "Versions"))
    # macOS app bundles (harmless on Windows)
    roots.append("/Applications/RobloxStudio.app/Contents/MacOS")
    roots.append(os.path.expanduser("~/Applications/RobloxStudio.app/Contents/MacOS"))
    return roots


def _studio_mcp_in(folder):
    for name in ("StudioMCP.exe", "StudioMCP", "studio_mcp.exe", "StudioMCPServer.exe"):
        p = os.path.join(folder, name)
        if os.path.isfile(p):
            return p
    return None


def find_studio_mcp():
    """(path, how) - newest StudioMCP.exe, live Studio folders beating zombies."""
    for var in ("OR_STUDIO_MCP_PATH", "ZS_STUDIO_MCP_PATH"):
        raw = os.environ.get(var)
        if raw and os.path.exists(raw):
            return os.path.abspath(raw), var
    best = []
    for root in _version_roots():
        if not os.path.isdir(root):
            continue
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for name in names:
            folder = os.path.join(root, name)
            if not os.path.isdir(folder):
                continue
            exe = _studio_mcp_in(folder)
            if not exe:
                continue
            paired = any(
                os.path.isfile(os.path.join(folder, s))
                for s in ("RobloxStudioBeta.exe", "RobloxStudio.exe")
            )
            try:
                stamp = os.path.getmtime(exe)
            except OSError:
                stamp = 0
            best.append((0 if paired else 1, -stamp, exe))
    if best:
        best.sort()
        return best[0][2], ("discovered (paired)" if best[0][0] == 0 else "discovered (orphan)")
    local = os.environ.get("LOCALAPPDATA")
    if local:
        bat = os.path.join(local, "Roblox", "mcp.bat")
        if os.path.isfile(bat):
            return bat, "mcp.bat fallback"
    return None, "not found"


def child_command(path):
    """How to run whatever discovery returned (.py stubs are used by --selftest)."""
    low = path.lower()
    if low.endswith(".py"):
        return [sys.executable, path]
    if low.endswith((".bat", ".cmd")):
        return [os.environ.get("COMSPEC", "cmd.exe"), "/C", path]
    return [path]


# ── leftover StudioMCP.exe cleanup (ZeroScript's live-diagnosed fix) ────────
# A StudioMCP.exe left over from an earlier session keeps LISTENING on Studio's
# MCP port, and any StudioMCP started afterwards only talks to that zombie:
# Studio never re-registers and calls come back empty. Their bridge goes out of
# its way to clean these up, so the host does too. Only unambiguously stale ones
# are killed: a leftover while no Studio is running at all, or one holding
# Studio's MCP port that is not our own child.

STUDIO_MCP_PORT = 13469
STUDIO_IMAGES = ("RobloxStudioBeta.exe", "RobloxStudio.exe")


def _run(args, timeout=8):
    kwargs = {"capture_output": True, "text": True, "encoding": "utf-8",
              "errors": "replace", "timeout": timeout}
    if os.name == "nt":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    return subprocess.run(args, **kwargs)


def _tasklist_has(image):
    """True / False, or None when it cannot be determined."""
    if os.name != "nt":
        return False
    try:
        return image in _run(["tasklist", "/FI", "IMAGENAME eq " + image]).stdout
    except Exception:
        return None


def studio_app_running():
    """Roblox Studio itself - never StudioMCP.exe."""
    unknown = False
    for image in STUDIO_IMAGES:
        got = _tasklist_has(image)
        if got:
            return True
        if got is None:
            unknown = True
    return None if unknown else False


def port_owner_pid(port):
    if os.name != "nt":
        return None
    try:
        out = _run(["netstat", "-ano", "-p", "TCP"]).stdout
    except Exception:
        return None
    needle = ":%d" % port
    for line in out.splitlines():
        parts = line.split()
        if (len(parts) >= 5 and parts[0].upper() == "TCP"
                and parts[3].upper() == "LISTENING" and parts[1].endswith(needle)):
            try:
                return int(parts[4])
            except ValueError:
                return None
    return None


def _pid_is_studio_mcp(pid):
    if os.name != "nt":
        return False
    try:
        return "StudioMCP.exe" in _run(["tasklist", "/FI", "PID eq %d" % pid]).stdout
    except Exception:
        return False


def clean_leftovers(our_child_pid=None):
    """Returns the PIDs it closed (for --check and the log)."""
    if os.name != "nt":
        return []
    killed = []
    owner = port_owner_pid(STUDIO_MCP_PORT)
    if owner and owner != our_child_pid and _pid_is_studio_mcp(owner):
        try:
            _run(["taskkill", "/F", "/PID", str(owner)])
            killed.append(owner)
            log("killed leftover StudioMCP.exe pid %d - it held Studio's MCP port %d, "
                "so a fresh one could never take it" % (owner, STUDIO_MCP_PORT))
        except Exception as exc:
            log("could not kill StudioMCP pid %d: %r" % (owner, exc))
    if studio_app_running() is False and _tasklist_has("StudioMCP.exe"):
        log("no Roblox Studio is running - cleaning up leftover StudioMCP.exe processes")
        try:
            _run(["taskkill", "/F", "/IM", "StudioMCP.exe"])
        except Exception as exc:
            log("could not clean up leftover StudioMCP.exe: %r" % (exc,))
    return killed


# ── the host's own tools ────────────────────────────────────────────────────
# Blender hands ORscript a PNG on disk and the extension reads it back through
# the agent's read_file_base64 - a 1.18.1 tool. On an older exe that call does
# not exist, so the picture was lost. The host runs on the same PC and can read
# the file itself; the image rides back as a marker like any Studio capture.

HOST_IMAGE_MAX = 24 * 1024 * 1024
IMAGE_MIMES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
}
HOST_TOOLS = [{
    "name": "or_host_read_image",
    "description": (
        "Read a local image file (PNG/JPG/WEBP) and return it as an image the chat "
        "can attach. ORscript uses this for Blender viewport captures when or-agent "
        "is older than 1.18.1 and has no read_file_base64."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {"path": {"type": "string", "description": "Absolute path to the image file."}},
        "required": ["path"],
    },
}]
HOST_TOOL_NAMES = set(t["name"] for t in HOST_TOOLS)


def host_result_error(message):
    return {"content": [{"type": "text", "text": message}], "isError": True}


def host_read_image(args):
    """or_host_read_image: file bytes -> image item -> <<OR_IMAGE>> on the way out."""
    path = str((args or {}).get("path") or "").strip().strip('"')
    if not path:
        return host_result_error("or_host_read_image needs a path.")
    ext = os.path.splitext(path)[1].lower()
    if ext not in IMAGE_MIMES:
        return host_result_error("%s is not an image file - refusing to inline it." % path)
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        return host_result_error("cannot read %s: %s" % (path, exc))
    if size > HOST_IMAGE_MAX:
        return host_result_error(
            "%s is %.1f MB - over the %d MB cap." % (path, size / 1048576.0, HOST_IMAGE_MAX // 1048576))
    try:
        with open(path, "rb") as fh:
            data = base64.b64encode(fh.read()).decode("ascii")
    except OSError as exc:
        return host_result_error("cannot read %s: %s" % (path, exc))
    return {"content": [
        {"type": "text", "text": "Read %s (%d bytes) from %s." % (os.path.basename(path), size, path)},
        {"type": "image", "mimeType": IMAGE_MIMES[ext], "data": data},
    ]}


# ── the Studio child process ────────────────────────────────────────────────

class Studio(object):
    def __init__(self):
        self.proc = None
        self.buf = None
        self.q = queue.Queue()
        self.path = None
        self.how = ""
        self._pid = None
        self.last_killed = []

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        path, how = find_studio_mcp()
        if not path:
            raise RuntimeError(
                "StudioMCP.exe not found. Open Studio once (or set OR_STUDIO_MCP_PATH "
                "to StudioMCP.exe) - in Studio: Assistant -> ... -> Manage MCP Servers "
                "-> Enable Studio as MCP Server."
            )
        cmd = child_command(path)
        # Before spawning: a stale StudioMCP.exe holding the port would make this
        # one useless, so clear it out first.
        self.last_killed = clean_leftovers(self._pid)
        kwargs = {}
        if os.name == "nt":
            si = subprocess.STARTUPINFO()
            si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            kwargs["startupinfo"] = si
            kwargs["creationflags"] = CREATE_NO_WINDOW
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, **kwargs
        )
        self.buf = self.proc.stdin
        self.path, self.how = path, how
        self._pid = self.proc.pid
        threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()
        log("StudioMCP started (%s): %s" % (how, path))

    def _pump(self, proc):
        try:
            for line in proc.stdout:
                self.q.put(line)
        except Exception as exc:  # pragma: no cover
            log("pump error: %r" % (exc,))
        self.q.put(None)  # EOF sentinel

    def stop(self):
        try:
            if self.buf:
                self.buf.close()
        except Exception:
            pass
        if self.proc is not None:
            try:
                self.proc.terminate()
            except Exception:
                pass
        self.proc = None
        self.buf = None
        while not self.q.empty():
            try:
                self.q.get_nowait()
            except Exception:
                break

    def ensure(self):
        if not self.alive():
            if self.proc is not None:
                log("StudioMCP is gone - restarting it")
            self.stop()
            self.start()

    def send(self, line):
        try:
            self.buf.write(line if line.endswith(b"\n") else line + b"\n")
            self.buf.flush()
        except Exception as exc:
            raise RuntimeError("could not talk to StudioMCP: %r" % (exc,))

    def read_reply(self, req_id, timeout):
        """The child's answer to req_id; anything else it says is passed through."""
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                return None
            try:
                line = self.q.get(timeout=remain)
            except queue.Empty:
                return None
            if line is None:
                raise RuntimeError("StudioMCP closed its output")
            try:
                msg = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                emit_raw(line)
                continue
            if msg.get("id") == req_id:
                return msg
            emit_raw(line)  # notification / unexpected id: the agent ignores it
        # unreachable


# ── image passthrough ───────────────────────────────────────────────────────

def rewrite_images(msg):
    """image content items -> <<OR_IMAGE>> text items the extension can decode."""
    result = msg.get("result")
    if not isinstance(result, dict):
        return msg, 0
    content = result.get("content")
    if not isinstance(content, list):
        return msg, 0
    out, converted = [], 0
    for item in content:
        if isinstance(item, dict) and item.get("type") == "image" and item.get("data"):
            mime = item.get("mimeType") or item.get("mime_type") or "image/png"
            data = item["data"]
            out.append({
                "type": "text",
                "text": '%s mimeType="%s" bytes=%d>>\n%s\n%s' % (MARK, mime, len(data), data, END),
            })
            converted += 1
        else:
            out.append(item)
    if converted:
        new = dict(msg)
        res = dict(result)
        res["content"] = out
        new["result"] = res
        return new, converted
    return msg, 0


def emit_raw(line):
    try:
        sys.stdout.buffer.write(line if line.endswith(b"\n") else line + b"\n")
        sys.stdout.buffer.flush()
    except Exception:
        raise SystemExit(0)


def emit(msg):
    emit_raw(json.dumps(msg, ensure_ascii=True).encode("utf-8"))


def error_reply(req_id, message):
    emit({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32000, "message": message}})


def serve():
    studio = Studio()
    stdin = sys.stdin.buffer
    log("host started (pid %d, cwd %s)" % (os.getpid(), os.getcwd()))
    for raw in stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        method = msg.get("method") or ""
        req_id = msg.get("id")
        params = msg.get("params") or {}
        # Our own tool: something Studio knows nothing about, so it is answered
        # here and never forwarded.
        if method == "tools/call" and params.get("name") in HOST_TOOL_NAMES:
            result = host_read_image(params.get("arguments"))
            # It goes out through the same marker rewrite as a Studio capture, so
            # the extension needs no special case for it.
            host_reply, converted = rewrite_images(
                {"jsonrpc": "2.0", "id": req_id, "result": result})
            log("tools/call %s -> handled by the host (%d image(s) kept)"
                % (params.get("name"), converted))
            if req_id is not None:
                emit(host_reply)
            continue
        timeout = CALL_TIMEOUT if method == "tools/call" else (
            LIST_TIMEOUT if method == "tools/list" else INIT_TIMEOUT)
        try:
            studio.ensure()
            studio.send(line)
        except Exception as exc:
            log("%s -> child error: %s" % (method, exc))
            if req_id is not None:
                error_reply(req_id, str(exc))
            continue
        if req_id is None:
            continue
        try:
            reply = studio.read_reply(req_id, timeout)
        except Exception as exc:
            log("%s -> %s" % (method, exc))
            error_reply(req_id, str(exc))
            studio.stop()
            continue
        if reply is None:
            log("%s -> timed out after %.0fs" % (method, timeout))
            error_reply(req_id, "Studio did not answer %s within %.0fs" % (method, timeout))
            continue
        if reply.get("error"):
            log("%s -> StudioMCP error: %s" % (method, json.dumps(reply.get("error"))[:300]))
            emit(reply)
            continue
        if method == "tools/list":
            # Studio's own tools, plus the host's (read_file_base64 replacement).
            known = set(t.get("name") for t in ((reply.get("result") or {}).get("tools") or []))
            extra = [t for t in HOST_TOOLS if t["name"] not in known]
            if extra:
                res = dict(reply.get("result") or {})
                res["tools"] = list(res.get("tools") or []) + extra
                reply = dict(reply)
                reply["result"] = res
        reply, converted = rewrite_images(reply)
        name = ((msg.get("params") or {}).get("name") or "") if method == "tools/call" else ""
        log("%s %s%s" % (method, name, " -> %d image(s) kept" % converted if converted else ""))
        emit(reply)
    studio.stop()
    log("host exiting (stdin closed)")


# ── self-test ───────────────────────────────────────────────────────────────

SELFTEST_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4z8AAAAMBAQD3A0FDAAAAAElFTkSuQmCC"
STUB = r'''
import json, sys
PNG = "@PNG@"
for raw in sys.stdin.buffer:
    try:
        msg = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        continue
    mid, method = msg.get("id"), msg.get("method")
    if mid is None:
        continue
    if method == "initialize":
        res = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
               "serverInfo": {"name": "stub-studio", "version": "0"}}
    elif method == "tools/list":
        res = {"tools": [{"name": "screen_capture", "description": "stub",
                          "inputSchema": {"type": "object"}}]}
    elif method == "tools/call":
        res = {"content": [{"type": "image", "mimeType": "image/png", "data": PNG}]}
    else:
        res = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": res}) + "\n")
    sys.stdout.flush()
'''


def selftest():
    """Drive a real host process against a fake Studio and check the round-trip."""
    tmp = tempfile.mkdtemp(prefix="or_studio_selftest_")
    stub = os.path.join(tmp, "stub_studio_mcp.py")
    with open(stub, "w", encoding="utf-8") as fh:
        fh.write(STUB.replace("@PNG@", SELFTEST_PNG_B64))
    env = dict(os.environ)
    env["OR_STUDIO_MCP_PATH"] = stub
    env["OR_MCP_CONFIG"] = os.path.join(tmp, "none.json")
    proc = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
    )

    def ask(obj, wait=20.0):
        proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        proc.stdin.flush()
        deadline = time.time() + wait
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("host closed stdout")
            msg = json.loads(line.decode("utf-8", "replace"))
            if msg.get("id") == obj.get("id"):
                return msg
        raise RuntimeError("no answer to %s" % obj.get("method"))

    fails = []
    try:
        init = ask({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {}}})
        if init.get("result", {}).get("serverInfo", {}).get("name") != "stub-studio":
            fails.append("initialize was not forwarded")

        tools = ask({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        names = [t.get("name") for t in tools.get("result", {}).get("tools", [])]
        if "screen_capture" not in names:
            fails.append("tools/list was not forwarded (%r)" % (names,))
        if "or_host_read_image" not in names:
            fails.append("the host's own tool is missing from tools/list")

        call = ask({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                    "params": {"name": "screen_capture", "arguments": {}}})
        content = call.get("result", {}).get("content") or []
        text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
        if MARK not in text or END not in text:
            fails.append("image item did not become an <<OR_IMAGE>> text item")
        else:
            body = text.split(">>\n", 1)[-1].rsplit("\n" + END, 1)[0].strip()
            if not body.startswith("iVBORw0KGgo"):
                fails.append("marker does not carry the PNG base64")
            if any(c.get("type") == "image" for c in content):
                fails.append("raw image item was left in the payload")

        png = os.path.join(tmp, "shot.png")
        with open(png, "wb") as fh:
            fh.write(base64.b64decode(SELFTEST_PNG_B64))
        read = ask({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                    "params": {"name": "or_host_read_image", "arguments": {"path": png}}})
        rtext = "".join(c.get("text", "") for c in (read.get("result", {}).get("content") or [])
                        if c.get("type") == "text")
        if MARK not in rtext or "iVBORw0KGgo" not in rtext:
            fails.append("or_host_read_image did not hand back the file as an image")
        bad = ask({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                   "params": {"name": "or_host_read_image", "arguments": {"path": os.path.abspath(__file__)}}})
        if not (bad.get("result") or {}).get("isError"):
            fails.append("or_host_read_image inlined a non-image file")
    except Exception as exc:
        fails.append("crash: %r" % (exc,))
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

    if fails:
        say("SELFTEST FAIL")
        for f in fails:
            say("  - " + f)
        return 1
    say("SELFTEST PASS  (initialize -> tools + or_host_read_image -> capture image -> marker,"
        " non-image refused)")
    return 0


def check():
    path, how = find_studio_mcp()
    say("Studio MCP host check")
    say("  python      : %s" % sys.version.split()[0])
    app = studio_app_running()
    say("  Studio app  : %s" % {True: "running", False: "not running",
                               None: "unknown"}[app])
    if os.name == "nt":
        owner = port_owner_pid(STUDIO_MCP_PORT)
        if owner:
            kind = "StudioMCP.exe" if _pid_is_studio_mcp(owner) else "another program"
            say("  port %-6d : held by pid %d (%s)" % (STUDIO_MCP_PORT, owner, kind))
            if kind == "StudioMCP.exe":
                say("                a leftover from an earlier session - the host closes it")
        else:
            say("  port %-6d : free" % STUDIO_MCP_PORT)
    if path:
        say("  StudioMCP   : %s" % path)
        say("  found by    : %s" % how)
        say("  spawn as    : %s" % " ".join(child_command(path)))
        say("  OK - captures will arrive as images.")
        return 0
    say("  StudioMCP   : NOT FOUND")
    say("  Open Studio once so its version folder exists, or set OR_STUDIO_MCP_PATH")
    say("  to StudioMCP.exe (Assistant -> ... -> Manage MCP Servers -> Enable Studio).")
    return 1


if __name__ == "__main__":
    args = set(a.lower() for a in sys.argv[1:])
    if "--selftest" in args:
        sys.exit(selftest())
    if "--check" in args:
        sys.exit(check())
    try:
        serve()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        pass
