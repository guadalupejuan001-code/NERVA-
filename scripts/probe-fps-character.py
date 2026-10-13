#!/usr/bin/env python3
"""Validate real GPU skinning, animated shadows, reflections, and MSAA for Iria.

Optional development helper requiring preinstalled Python Playwright and Chromium.
Software mode uses SwiftShader. All modes report the actual selected adapter;
successful pixel readbacks do not establish physical GPU frame-rate performance.
"""

import argparse
import functools
from http.server import ThreadingHTTPServer
import importlib.util
from pathlib import Path
import shutil
import sys
import threading
from urllib.parse import urlparse


SKIN_TEST = """async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  assert(navigator.gpu, 'WebGPU is unavailable in this browser context');
  const { createFPSRenderer, createFPSWorld } = await import('/src/graphics/index.mjs');
  const { loadGLTF, sampleGLTFAnimation } = await import('/src/graphics/gltf.mjs');
  const adapter = await navigator.gpu.requestAdapter();
  assert(adapter, 'No WebGPU adapter is available');
  const info = adapter.info ?? {};
  const adapterInfo = Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter']
    .map(key => [key, info[key] ?? null]));
  const softwareAdapter = /swiftshader|llvmpipe|software/i.test(Object.values(adapterInfo).join(' '));
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  let renderer;
  try {
    const asset = await loadGLTF('/assets/characters/iria.gltf');
    const idle = sampleGLTFAnimation(asset, { animation: 'idle', time: .17 });
    const walk = sampleGLTFAnimation(asset, { animation: 'walk', time: .28 });
    const transform = new Float32Array([-1,0,0,0, 0,1,0,0, 0,0,-1,0, 0,0,0,1]);
    const world = createFPSWorld({ floorY: 0,
      objects: [{ kind: 'box', position: [0,-.1,0], scale: [10,.2,10],
        material: { color: [.16,.21,.27], roughness: .08, metallic: .15, reflection: 1 } }],
      lights: [{ position: [0,2,-2], color: [1,.85,.68], intensity: 25, radius: 10 }],
      lighting: { sunDirection: [-.5,.8,-.3], sunIntensity: 3.8, ambient: .2, reflectionStrength: 1 } });
    renderer = await createFPSRenderer({ device, world, width: 320, height: 180, shadowSize: 512,
      format: 'bgra8unorm', characterAsset: asset, characterPose: idle,
      characterTransform: transform, sampleCount: 4, fxaa: true });
    const camera = { position: [0,1.3,-3], yaw: 0, pitch: -.1, fovY: 1.15, aspect: 16/9, near: .08, far: 30 };
    const capture = (pose, changes = {}) => renderer.render(camera, {
      capture: true, readback: true, time: 0, characterPose: pose,
      effects: { shadows: true, reflections: true, bloom: false, ao: false, fogDensity: 0, ...changes } });
    const a = await capture(idle);
    const aNoShadow = await capture(idle, { shadows: false });
    const aNoReflection = await capture(idle, { reflections: false });
    const b = await capture(walk);
    const bNoShadow = await capture(walk, { shadows: false });
    const bNoReflection = await capture(walk, { reflections: false });
    const steady = await capture(walk);
    const difference = (first, second) => {
      let changed = 0, sum = 0;
      for (let i = 0; i < first.length; i++) if (i % 4 !== 3) {
        const n = Math.abs(first[i] - second[i]);
        sum += n; if (n > 2) changed++;
      }
      return { changedChannels: changed, meanAbsoluteDifference: sum / (first.length / 4 * 3) };
    };
    const contributionDifference = (onA, offA, onB, offB) => {
      let changed = 0, sum = 0;
      for (let i = 0; i < onA.length; i++) if (i % 4 !== 3) {
        const n = Math.abs((onA[i] - offA[i]) - (onB[i] - offB[i]));
        sum += n; if (n > 2) changed++;
      }
      return { changedChannels: changed, meanAbsoluteDifference: sum / (onA.length / 4 * 3) };
    };
    const poseDifference = difference(a.rgba, b.rgba);
    const shadowDifference = contributionDifference(a.rgba, aNoShadow.rgba, b.rgba, bNoShadow.rgba);
    const reflectionDifference = contributionDifference(a.rgba, aNoReflection.rgba, b.rgba, bNoReflection.rgba);
    assert(poseDifference.changedChannels > 20, 'Pose did not change actual GPU color capture');
    assert(shadowDifference.changedChannels > 10, 'Shadow contribution did not change with pose');
    assert(reflectionDifference.changedChannels > 10, 'Reflection contribution did not change with pose');
    assert(b.boneUploadBytes > 0 && b.npcShadowRendered, 'Changed pose failed bone upload or dynamic shadow refresh');
    assert(steady.boneUploadBytes === 0 && !steady.npcShadowRendered && steady.resourceCreationsThisFrame === 0,
      'Identical pose did not retain resources/shadow cache');
    assert(a.sampleCount === 4 && a.fxaa && a.renderGraphPasses.includes('depth-resolve'),
      'Actual skin scene AA/depth resolve unavailable');
    assert(errors.length === 0, 'GPU emitted errors');
    return { verified: true, adapter: adapterInfo, softwareAdapter, physicalGPUPerformanceValidated: false,
      asset: { joints: asset.jointCount, vertices: a.characterVertexCount, triangles: a.skinnedTriangles },
      resolution: { width: 320, height: 180 }, sampleCount: a.sampleCount, fxaa: a.fxaa,
      tests: { poseDifference, shadowContributionPoseDifference: shadowDifference,
        reflectionContributionPoseDifference: reflectionDifference,
        changedPose: { boneUploadBytes: b.boneUploadBytes, npcShadowRendered: b.npcShadowRendered, passes: b.renderGraphPasses },
        unchangedPose: { boneUploadBytes: steady.boneUploadBytes, npcShadowRendered: steady.npcShadowRendered,
          resourceCreations: steady.resourceCreationsThisFrame } }, gpuErrors: errors,
      scope: 'Real glTF asset rendered by WebGPU. Pixel readbacks prove pose, shadow and reflection changes; adapter identity is explicit. No physical GPU FPS claim.' };
  } finally { renderer?.dispose(); device.destroy(); }
}"""


def load_probe():
    sys.dont_write_bytecode = True
    path = Path(__file__).with_name("probe-webgpu.py")
    spec = importlib.util.spec_from_file_location("nerva_webgpu_probe", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--adapter", choices=("software", "auto"), default="software")
    parser.add_argument("--out", default="private/fps/skin-gpu-qa.json")
    parser.add_argument("--chromium", default=shutil.which("chromium") or "chromium")
    parser.add_argument("--timeout-ms", type=int, default=120000)
    args = parser.parse_args()
    probe = load_probe()
    chromium_args = probe.BASE_CHROMIUM_ARGS + (probe.SOFTWARE_CHROMIUM_ARGS if args.adapter == "software" else [])
    report = {"adapterMode": args.adapter, "chromiumArgs": chromium_args, "verified": False,
              "physicalGPUPerformanceValidated": False}
    server = None
    try:
        from playwright.sync_api import sync_playwright

        root = Path(args.root).resolve()
        if not root.is_dir():
            raise ValueError(f"Root directory does not exist: {root}")
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(probe.LocalHandler, directory=str(root)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=chromium_args)
            try:
                report["browser"] = browser.version
                page = browser.new_page()
                page.set_default_timeout(args.timeout_ms)
                page.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname in
                           ("127.0.0.1", "localhost") else route.abort())
                page.goto(f"http://127.0.0.1:{server.server_address[1]}/__nerva_webgpu_probe__.html")
                runner = ("async timeoutMs => { let timeout; try { return await Promise.race([(" + SKIN_TEST + ")(), "
                          "new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Character GPU validation timed out')), timeoutMs); })]); } "
                          "finally { clearTimeout(timeout); } }")
                report.update(page.evaluate(runner, args.timeout_ms))
                report["ok"] = report["verified"]
            finally:
                browser.close()
        probe.write_report(report, args.out)
        return 0
    except Exception as error:
        report["ok"] = False
        report["verified"] = False
        report["error"] = str(error)
        probe.write_report(report, args.out)
        return 1
    finally:
        if server:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    sys.exit(main())
