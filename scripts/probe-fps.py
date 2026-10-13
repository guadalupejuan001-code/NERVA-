#!/usr/bin/env python3
"""Validate FPS controls using real Chromium pointer/keyboard events and WebGPU.

Optional development helper requiring preinstalled Python Playwright and Chromium.
The validation quality preset reduces software rendering cost. Adapter details
are preserved; SwiftShader results do not establish physical GPU performance.
"""

import argparse
import functools
from http.server import ThreadingHTTPServer
import importlib.util
import math
from pathlib import Path
import sys
import threading
from urllib.parse import urlparse


def load_probe():
    # Keep this optional helper from creating untracked Python cache files.
    sys.dont_write_bytecode = True
    path = Path(__file__).with_name("probe-webgpu.py")
    spec = importlib.util.spec_from_file_location("nerva_webgpu_probe", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--page", default="examples/fps/index.html")
    parser.add_argument("--out", default="private/fps/controls-report.json")
    parser.add_argument("--screenshot", help="Optional PNG screenshot destination")
    parser.add_argument("--adapter", choices=("software", "auto"), default="software")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--timeout-ms", type=int, default=120000)
    args = parser.parse_args()
    probe = load_probe()
    chromium_args = probe.BASE_CHROMIUM_ARGS + (probe.SOFTWARE_CHROMIUM_ARGS if args.adapter == "software" else [])
    report = {"adapterMode": args.adapter, "chromiumArgs": chromium_args,
              "inputSource": "Playwright browser mouse and keyboard events", "tests": {}}
    server = None
    try:
        from playwright.sync_api import sync_playwright

        root = Path(args.root).resolve()
        harness = (root / urlparse(args.page).path).resolve()
        if not root.is_dir() or not harness.is_relative_to(root) or not harness.is_file():
            raise ValueError("Harness must be an existing file inside --root")
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(probe.LocalHandler, directory=str(root)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{server.server_address[1]}"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=chromium_args)
            page = None
            page_errors = []
            try:
                report["browser"] = browser.version
                page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
                page.set_default_timeout(args.timeout_ms)
                page.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname in
                           ("127.0.0.1", "localhost") else route.abort())
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                report["stage"] = "webgpu-probe"
                page.goto(origin + "/__nerva_webgpu_probe__.html")
                report["probe"] = page.evaluate(probe.PROBE)
                separator = "&" if "?" in args.page else "?"
                report["stage"] = "initialize-fps"
                page.goto(origin + "/" + args.page.lstrip("/") + separator + "quality=validation", wait_until="load")
                page.wait_for_function("typeof window.getFpsState === 'function' && !!window.fpsReady")
                page.evaluate("async timeoutMs => { let timeout; try { await Promise.race([window.fpsReady, "
                              "new Promise((_, reject) => { timeout = setTimeout(() => "
                              "reject(new Error('FPS initialization timed out')), timeoutMs); })]); } "
                              "finally { clearTimeout(timeout); } }", args.timeout_ms)
                initial = page.evaluate("window.getFpsState()")
                report["initialState"] = initial
                report["stage"] = "pointer-lock"
                page.locator("#enter").click()
                page.wait_for_function("document.pointerLockElement === document.querySelector('#scene')")
                report["stage"] = "start-render-loop"
                page.wait_for_function("start => window.getFpsState().frameCount >= start + 2",
                                       arg=initial["frameCount"])
                locked = page.evaluate("window.getFpsState()")
                assert locked["pointerLocked"] is True and locked["playing"] is True, "FPS must play with pointer lock"
                report["tests"]["realPointerLock"] = True
                before_move = locked
                report["stage"] = "forward-movement"
                page.keyboard.down("KeyW")
                try:
                    page.wait_for_function("'KeyW' === window.getFpsState().keys.find(k => k === 'KeyW')")
                    page.wait_for_function("before => { const s = window.getFpsState(); return "
                                           "s.frameCount >= before.frameCount + 3 && "
                                           "Math.hypot(...s.position.map((n,i) => n-before.position[i])) > 0.0001; }",
                                           arg=before_move)
                    moved = page.evaluate("window.getFpsState()")
                finally:
                    page.keyboard.up("KeyW")
                report["states"] = {"locked": locked, "afterForward": moved}
                distance = math.dist(before_move["position"], moved["position"])
                assert distance > 0.0001, "KeyW must move the first-person camera"
                report["tests"]["realKeyWMovement"] = True
                report["forwardDistance"] = distance
                before_look = page.evaluate("window.getFpsState()")
                report["stage"] = "mouse-look"
                page.mouse.move(740, 390)
                page.wait_for_function("before => { const s = window.getFpsState(); return "
                                       "Math.abs(s.yaw-before.yaw) > 0.0001 && Math.abs(s.pitch-before.pitch) > 0.0001; }",
                                       arg=before_look)
                looked = page.evaluate("window.getFpsState()")
                report["states"]["afterMouse"] = looked
                report["tests"]["realMouseLook"] = True
                before_jump = page.evaluate("window.getFpsState()")
                report["stage"] = "jump"
                page.keyboard.down("Space")
                try:
                    page.wait_for_function("before => window.getFpsState().position[1] > before.position[1] + 0.005",
                                           arg=before_jump)
                    jumped = page.evaluate("window.getFpsState()")
                finally:
                    page.keyboard.up("Space")
                report["states"]["afterJump"] = jumped
                report["tests"]["realSpaceJump"] = True
                # Leave a movement key down while unlocking: input must be cleared.
                report["stage"] = "unlock"
                page.keyboard.down("KeyD")
                page.keyboard.press("Escape")
                page.wait_for_function("!document.pointerLockElement && !window.getFpsState().pointerLocked && "
                                       "window.getFpsState().keys.length === 0")
                page.keyboard.up("KeyD")
                final = page.evaluate("window.getFpsState()")
                report["finalState"] = final
                report["tests"]["escapeUnlocksAndClearsKeys"] = True
                npc_available = page.evaluate("typeof window.getNpcState === 'function' && "
                                              "typeof window.inspectCharacter === 'function'")
                report["npcChecksAvailable"] = npc_available
                if npc_available:
                    report["states"]["originalControlsFinal"] = final
                    report["stage"] = "npc-live-animation"
                    idle = page.evaluate("window.getNpcState()")
                    assert idle["jointCount"] == 23, "Iria must expose her 23-joint skin"
                    page.locator("#enter").click()
                    page.wait_for_function("document.pointerLockElement === document.querySelector('#scene')")
                    page.wait_for_function("() => { const npc = window.getNpcState(); return "
                                           "npc.state === 'walking' && npc.animation === 'walk' && "
                                           "npc.boneUploadBytesLastFrame > 0; }")
                    walking = page.evaluate("window.getNpcState()")
                    report["npcStates"] = {"initial": idle, "walking": walking}
                    report["tests"]["npcLiveWalkUploadsBones"] = True
                    page.keyboard.press("Escape")
                    page.wait_for_function("!window.getFpsState().pointerLocked && !window.getFpsState().playing")
                    page.evaluate("async () => await window.inspectCharacter()")
                    page.wait_for_function("window.getFpsState().pendingUIActions === 0")
                    near = page.evaluate("({fps: window.getFpsState(), npc: window.getNpcState()})")
                    report["npcStates"]["near"] = near
                    report["stage"] = "npc-body-collision"
                    page.locator("#enter").click()
                    page.wait_for_function("window.getFpsState().pointerLocked && window.getFpsState().playing")
                    page.keyboard.down("KeyW")
                    try:
                        page.wait_for_function("() => { const s = window.getFpsState(), n = window.getNpcState(); "
                                               "return n.position[2] - s.position[2] <= 0.581; }")
                        blocked = page.evaluate("({fps: window.getFpsState(), npc: window.getNpcState()})")
                        page.wait_for_function("before => window.getFpsState().frameCount >= before + 3",
                                               arg=blocked["fps"]["frameCount"])
                        still_blocked = page.evaluate("({fps: window.getFpsState(), npc: window.getNpcState()})")
                    finally:
                        page.keyboard.up("KeyW")
                    clearance = still_blocked["npc"]["position"][2] - still_blocked["fps"]["position"][2]
                    assert abs(clearance - 0.58) < 1e-5, "Camera crossed the NPC collision body"
                    assert math.dist(blocked["fps"]["position"], still_blocked["fps"]["position"]) < 1e-5, \
                        "Held KeyW must stop against the NPC body"
                    report["npcStates"]["bodyBlocked"] = still_blocked
                    report["npcBodyClearance"] = clearance
                    report["tests"]["npcBodyBlocksRealKeyW"] = True
                    report["stage"] = "npc-real-E-dialogue"
                    page.keyboard.press("KeyE")
                    page.wait_for_function("before => { const n = window.getNpcState(); return n.spoken && "
                                           "n.state === 'speaking' && n.interactionCount > before; }",
                                           arg=near["npc"]["interactionCount"])
                    spoken = page.evaluate("window.getNpcState()")
                    assert spoken["dialogue"] in page.locator("#objective").inner_text(), \
                        "The NERVA NPC dialogue must appear in the objective"
                    report["npcStates"]["speaking"] = spoken
                    report["tests"]["npcRealEAuthoredDialogue"] = True
                    page.keyboard.press("Escape")
                    page.wait_for_function("!window.getFpsState().pointerLocked && !window.getFpsState().playing && "
                                           "window.getFpsState().keys.length === 0")
                    final = page.evaluate("window.getFpsState()")
                    report["finalState"] = final
                if final.get("deviceLost") or final.get("gpuUncapturedErrors"):
                    raise RuntimeError("FPS controls reported a lost device or an uncaptured GPU error")
                if args.screenshot:
                    path = Path(args.screenshot)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(path), full_page=True)
                    report["screenshot"] = str(path)
                if page_errors:
                    report["pageErrors"] = page_errors
                    raise RuntimeError("Browser page reported an uncaught error")
                report["verified"] = all(report["tests"].values())
                report["ok"] = report["verified"]
                report["stage"] = "complete"
            except Exception:
                if page and not page.is_closed():
                    try:
                        report["failureState"] = page.evaluate("({state: window.getFpsState?.() ?? null, "
                                                               "status: document.querySelector('#status')?.textContent ?? null})")
                        if page_errors:
                            report["pageErrors"] = page_errors
                        if args.screenshot:
                            path = Path(args.screenshot)
                            path.parent.mkdir(parents=True, exist_ok=True)
                            page.screenshot(path=str(path), full_page=True)
                            report["screenshot"] = str(path)
                    except Exception as diagnostic_error:
                        report["diagnosticCaptureError"] = str(diagnostic_error)
                raise
            finally:
                browser.close()
        probe.write_report(report, args.out)
        return 0
    except Exception as error:
        report["error"] = str(error)
        report["ok"] = False
        report["verified"] = False
        probe.write_report(report, args.out)
        return 1
    finally:
        if server:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    sys.exit(main())
