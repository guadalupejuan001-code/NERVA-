#!/usr/bin/env python3
"""Run a real WebGPU probe or engine benchmark in local Chromium.

Optional development helper: Python Playwright and Chromium must already exist.
The selected adapter is reported explicitly; SwiftShader is software rendering.
No CPU emulation replaces a failed WebGPU device or failed GPU assertion.
"""

import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
from urllib.parse import urlparse


BASE_CHROMIUM_ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-webgpu",
]

SOFTWARE_CHROMIUM_ARGS = [
    "--use-angle=swiftshader",
    "--allow-unsafe-swiftshader",
    # Linux headless direct GPUCanvas presentation needs a matching Vulkan
    # backing. Compute/offscreen rendering alone can work without these flags.
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
]


PROBE = """async () => {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser context');
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw new Error('WebGPU requestAdapter returned null');
  const rawInfo = adapter.info ?? await adapter.requestAdapterInfo?.() ?? {};
  const info = Object.fromEntries(['vendor', 'architecture', 'device', 'description',
    'subgroupMinSize', 'subgroupMaxSize', 'isFallbackAdapter'].map(k => [k, rawInfo[k] ?? null]));
  const software = /swiftshader|llvmpipe|software/i.test(
    [info.vendor, info.architecture, info.device, info.description].join(' '));
  const features = [...adapter.features].sort();
  const limitNames = ['maxTextureDimension2D', 'maxBindGroups', 'maxBufferSize',
    'maxStorageBufferBindingSize', 'maxComputeWorkgroupSizeX', 'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupsPerDimension', 'maxStorageBuffersPerShaderStage'];
  const limits = Object.fromEntries(limitNames.map(k => [k, adapter.limits[k]]));
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const data = new Float32Array([0, 1, -2, 3.5, 8, 16, 32, 63]);
  const storage = device.createBuffer({size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC});
  const output = device.createBuffer({size: data.byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(storage, 0, data);
  const shader = device.createShaderModule({code: `
    @group(0) @binding(0) var<storage, read_write> values: array<f32>;
    @compute @workgroup_size(8)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      if (id.x < arrayLength(&values)) { values[id.x] *= 2.0; }
    }`});
  const compilation = await shader.getCompilationInfo();
  const shaderErrors = compilation.messages.filter(m => m.type === 'error');
  if (shaderErrors.length) throw new Error(shaderErrors.map(m => m.message).join('; '));
  const pipeline = await device.createComputePipelineAsync({layout: 'auto',
    compute: {module: shader, entryPoint: 'main'}});
  const bindGroup = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
    entries: [{binding: 0, resource: {buffer: storage}}]});
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
  encoder.copyBufferToBuffer(storage, 0, output, 0, data.byteLength);
  device.queue.submit([encoder.finish()]);
  await output.mapAsync(GPUMapMode.READ);
  const actual = Array.from(new Float32Array(output.getMappedRange()));
  output.unmap();
  const validation = await device.popErrorScope();
  storage.destroy();
  output.destroy();
  device.destroy();
  if (validation || errors.length) throw new Error(validation?.message ?? errors.join('; '));
  const expected = Array.from(data, n => n * 2);
  if (actual.some((n, i) => n !== expected[i])) throw new Error('GPU compute readback mismatch');
  return {available: true, adapter: info, softwareAdapter: software,
    fallbackAdapter: adapter.isFallbackAdapter ?? info.isFallbackAdapter,
    features, limits, compute: {input: Array.from(data), expected, actual, verified: true}};
}"""


class LocalHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path == "/__nerva_webgpu_probe__.html":
            payload = b"<!doctype html><title>NERVA WebGPU probe</title>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            super().do_GET()

    def log_message(self, *_args):
        pass


def write_report(report, destination):
    serialized = json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False)
    if destination:
        path = Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--page", help="Relative HTML harness path exposing window.runEngineBenchmark()")
    parser.add_argument("--out", help="JSON result destination")
    parser.add_argument("--screenshot", help="Optional harness screenshot destination")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--adapter", choices=("software", "auto"), default="software",
                        help="software forces SwiftShader for validation; auto lets Chromium select an adapter")
    parser.add_argument("--timeout-ms", type=int, default=120000)
    args = parser.parse_args()
    chromium_args = BASE_CHROMIUM_ARGS + (SOFTWARE_CHROMIUM_ARGS if args.adapter == "software" else [])
    report = {"adapterMode": args.adapter, "chromiumArgs": chromium_args, "probe": {"available": False}}
    server = None
    browser = None
    try:
        from playwright.sync_api import sync_playwright

        root = Path(args.root).resolve()
        if not root.is_dir():
            raise ValueError(f"Root directory does not exist: {root}")
        if args.page:
            page_path = (root / args.page).resolve()
            if not page_path.is_relative_to(root) or not page_path.is_file():
                raise ValueError("Harness must be an existing file inside --root")
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(LocalHandler, directory=str(root)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{server.server_address[1]}"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=chromium_args)
            report["browser"] = browser.version
            page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
            page.set_default_timeout(args.timeout_ms)
            # This helper only needs local repository files and WebGPU.
            page.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname in
                       ("127.0.0.1", "localhost") else route.abort())
            console_errors = []
            page.on("pageerror", lambda error: console_errors.append(str(error)))
            page.goto(origin + "/__nerva_webgpu_probe__.html")
            report["probe"] = page.evaluate(PROBE)
            if args.page:
                page.goto(origin + "/" + args.page.lstrip("/"), wait_until="load")
                report["benchmark"] = page.evaluate("async timeoutMs => {\n"
                    "if (typeof window.runEngineBenchmark !== 'function') "
                    "throw new Error('Harness must expose window.runEngineBenchmark()');\n"
                    "let timeout;\n"
                    "try { return await Promise.race([window.runEngineBenchmark(), "
                    "new Promise((_, reject) => { timeout = setTimeout(() => "
                    "reject(new Error('Engine benchmark timed out')), timeoutMs); })]); } "
                    "finally { clearTimeout(timeout); }\n}", args.timeout_ms)
            if args.screenshot:
                screenshot = Path(args.screenshot)
                screenshot.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(screenshot), full_page=True)
                report["screenshot"] = str(screenshot)
            if console_errors:
                report["pageErrors"] = console_errors
                raise RuntimeError("Browser page reported an uncaught error")
            browser.close()
            browser = None
        report["ok"] = True
        write_report(report, args.out)
        return 0
    except Exception as error:
        report["ok"] = False
        report["error"] = str(error)
        write_report(report, args.out)
        return 1
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        if server:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    sys.exit(main())
