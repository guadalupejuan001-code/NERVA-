#!/usr/bin/env python3
"""Optional real WebGPU tests of orientation, padded capture and disposal.

Requires Python Playwright and Chromium; software adapter metrics are functional
verification, not physical GPU performance measurements.
"""
import argparse
import functools
from http.server import ThreadingHTTPServer
import importlib.util
import json
import sys
from pathlib import Path
import threading
from urllib.parse import urlparse
sys.dont_write_bytecode = True
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
parser.add_argument('--chromium', default='/usr/bin/chromium')
parser.add_argument('--adapter', choices=('software', 'auto'), default='software')
parser.add_argument('--out', default='private/fps/gpu-final-qa.json')
args = parser.parse_args()
from playwright.sync_api import sync_playwright
root = Path(args.root).resolve()
spec = importlib.util.spec_from_file_location("probe", root / "scripts/probe-webgpu.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(probe.LocalHandler, directory=str(root)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True,
                                            args=probe.BASE_CHROMIUM_ARGS + (probe.SOFTWARE_CHROMIUM_ARGS if args.adapter == "software" else []))
        try:
            page = browser.new_page()
            page.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname in
                       ("127.0.0.1", "localhost") else route.abort())
            page.goto(f"http://127.0.0.1:{server.server_address[1]}/__nerva_webgpu_probe__.html")
            result = page.evaluate("""async () => {
              const assert = (condition, message) => { if (!condition) throw new Error(message); };
              const {createScene, cullScene, defaultCamera, createWebGPURenderer, createFPSRenderer} =
                await import('/src/graphics/index.mjs');
              const {buildFPSDescription} = await import('/examples/fps/author.mjs');
              const adapter = await navigator.gpu.requestAdapter();
              assert(adapter, 'No WebGPU adapter');
              const device = await adapter.requestDevice();
              const errors = [];
              let lost = null;
              device.addEventListener('uncapturederror', event => errors.push(event.error.message));
              device.lost.then(info => lost = {reason: info.reason, message: info.message});
              let legacy, fps;
              try {
                const positions = [[0,0,10], [10,0,0], [-10,0,0], [0,0,-10],
                  [0,10,10], [0,-10,10], [50,0,0], [150,0,0], [0,10,-10], [10,10,0], [10,-10,0]];
                const scene = createScene({count: positions.length, spread: 1});
                scene.updateInstances(positions.map((position, index) => ({index, position, radius: 0.5})));
                legacy = await createWebGPURenderer({device, scene, width: 64, height: 64});
                const cases = [
                  {name:'forward +Z', yaw:0, pitch:0, ids:[0]},
                  {name:'yaw +90 degrees +X with three LODs', yaw:Math.PI/2, pitch:0, ids:[1,6,7]},
                  {name:'yaw -90 degrees -X', yaw:-Math.PI/2, pitch:0, ids:[2]},
                  {name:'yaw 180 degrees -Z', yaw:Math.PI, pitch:0, ids:[3]},
                  {name:'pitch +45 degrees +Z', yaw:0, pitch:Math.PI/4, ids:[4]},
                  {name:'pitch -45 degrees +Z', yaw:0, pitch:-Math.PI/4, ids:[5]},
                  {name:'yaw +90 and pitch +45', yaw:Math.PI/2, pitch:Math.PI/4, ids:[9]},
                  {name:'yaw +90 and pitch -45', yaw:Math.PI/2, pitch:-Math.PI/4, ids:[10]},
                  {name:'yaw 180 and pitch +45', yaw:Math.PI, pitch:Math.PI/4, ids:[8]},
                ];
                const cameraResults = [];
                for (const test of cases) {
                  const camera = defaultCamera({position:[0,0,0], yaw:test.yaw, pitch:test.pitch,
                    aspect:1, near:1, far:200, lodDistances:[30,100]});
                  const cpu = cullScene(scene, camera);
                  const gpu = await legacy.render(camera, {readback:true});
                  const actual = [...gpu.visibleIDs].sort((a,b) => a-b);
                  assert(JSON.stringify(actual) === JSON.stringify(test.ids), test.name + ': manual expected IDs differ');
                  assert(JSON.stringify([...cpu.visible].sort((a,b) => a-b)) === JSON.stringify(actual),
                    test.name + ': CPU/GPU IDs differ');
                  assert(cpu.counts.every((count, i) => count === gpu.countsGPU[i]), test.name + ': LOD counts differ');
                  const expectedLODs = new Map([...cpu.visible].map((id,i) => [id,cpu.lods[i]]));
                  assert([...gpu.visibleIDs].every((id,i) => expectedLODs.get(id) === gpu.lods[i]), test.name + ': per-ID LOD differs');
                  cameraResults.push({name:test.name, yaw:test.yaw, pitch:test.pitch, ids:actual,
                    lodCounts:gpu.countsGPU, manualExpectedVerified:true, cpuGpuVerified:true});
                }
                legacy.dispose();
                assert(legacy.statistics.bufferBytes === 0 && legacy.statistics.textureBytesEstimate === 0,
                  'Legacy renderer memory counters did not clear');
                const source = await (await fetch('/examples/fps/scene.nv')).text();
                const {world} = buildFPSDescription(source);
                fps = await createFPSRenderer({device, world, width:320, height:180, shadowSize:512, format:'bgra8unorm'});
                const initial = await fps.render({...world.spawn, aspect:320/180, fovY:1.15}, {capture:true, readback:true, time:0});
                assert(initial.rgba.length === 320*180*4, 'Initial capture length differs');
                fps.resize(257,193);
                const resized = await fps.render({...world.spawn, aspect:257/193, fovY:1.15}, {capture:true, readback:true, time:0});
                assert(resized.rgba.length === 257*193*4, 'Padded resize capture length differs');
                assert(resized.rgba.every((value,index) => index%4 !== 3 || value === 255), 'Readback rows contain invalid alpha/padding');
                let min = 255, max = 0;
                for (let index=0; index<resized.rgba.length; index++) if (index%4 !== 3) {
                  min = Math.min(min,resized.rgba[index]); max = Math.max(max,resized.rgba[index]);
                }
                assert(max-min > 80, 'Readback lacks actual scene color variation');
                const steady = await fps.render({...world.spawn, aspect:257/193, fovY:1.15}, {capture:true, readback:true, time:0});
                assert(steady.resourceCreationsThisFrame === 0 && steady.sceneUploadBytes === 0,
                  'Post-resize steady frame recreated resources or reuploaded the scene');
                fps.dispose();
                const disposed = fps.statistics;
                assert(disposed.disposed && disposed.bufferBytes === 0 && disposed.textureBytesEstimate === 0,
                  'FPS disposal did not clear counters');
                let rejected = false;
                try { await fps.render(world.spawn); } catch(error) { rejected = /disposed/.test(error.message); }
                assert(rejected, 'Render after disposal must reject');
                const zero = device.createBuffer({size:4,usage:GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
                const destination = device.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
                const encoder = device.createCommandEncoder();
                encoder.clearBuffer(zero); encoder.copyBufferToBuffer(zero,0,destination,0,4);
                device.queue.submit([encoder.finish()]);
                await destination.mapAsync(GPUMapMode.READ);
                const sharedDeviceValid = new Uint32Array(destination.getMappedRange())[0] === 0;
                destination.unmap(); zero.destroy(); destination.destroy();
                assert(sharedDeviceValid, 'Supplied device failed after renderer disposal');
                assert(errors.length === 0 && lost === null, 'GPU emitted errors or lost its device');
                const rawInfo = adapter.info;
                const info = Object.fromEntries(['vendor','architecture','device','description','isFallbackAdapter']
                  .map(key => [key,rawInfo[key] ?? null]));
                return {verified:true, adapter:info, softwareAdapter:/swiftshader|software|llvmpipe/i.test(Object.values(info).join(' ')),
                  physicalGPUPerformanceValidated:false, tests:{cameraYawPitch:cameraResults,
                    fpsResizeReadback:{verified:true,worldObjects:world.count,lights:world.lightCount,format:'bgra8unorm',
                      width:257,height:193,rgbaBytes:resized.rgba.length,unpaddedRowBytes:257*4,
                      gpuAlignedRowBytes:Math.ceil(257*4/256)*256,alphaCorrect:true,rgbRange:[min,max],
                      steadyResourceCreations:steady.resourceCreationsThisFrame,steadySceneUploadBytes:steady.sceneUploadBytes},
                    disposal:{verified:true,disposed:disposed.disposed,bufferBytes:disposed.bufferBytes,
                      textureBytesEstimate:disposed.textureBytesEstimate,renderAfterDisposeRejected:rejected,suppliedDevicePreserved:sharedDeviceValid}},
                  gpuErrors:errors, deviceLost:lost,
                  scope:'Real WebGPU camera culling, manual expected IDs and CPU parity; actual NERVA world GPU padded capture and disposal. Software adapter does not establish hardware FPS.'};
              } finally { legacy?.dispose(); fps?.dispose(); device.destroy(); }
            }""")
            output = Path(args.out)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(result, indent=2))
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
