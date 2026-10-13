import { createScene, cameraParameters, defaultCamera } from './scene.mjs';

/** Synchronous NERVA host. Scene state outlives individual interpreter runs.
 * Commands contain scene descriptions and edits, never copies of resident buffers.
 * The asynchronous GPU consumer belongs to the embedding application.
 */
export function createGraphicsCommandHost() {
  const scenes = new Map();
  let commands = [], nextHandle = 1;
  const getScene = handle => {
    if (!scenes.has(handle)) throw new RangeError(`Unknown scene handle: ${handle}`);
    return scenes.get(handle);
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  const host = Object.freeze({
    create_scene(options) {
      const scene = createScene(options);
      const handle = `scene-${nextHandle++}`;
      const description = { count: scene.count, seed: options.seed ?? 1, spread: options.spread ?? 100 };
      scenes.set(handle, scene);
      commands.push({ type: 'create_scene', handle, options: description });
      return handle;
    },
    update_instances(handle, patches) {
      const scene = getScene(handle);
      const ownedPatches = copy(patches);
      const revision = scene.updateInstances(ownedPatches);
      if (ownedPatches.length) commands.push({ type: 'update_instances', handle, patches: ownedPatches });
      return revision;
    },
    render_scene(handle, camera) {
      getScene(handle);
      const configuredCamera = defaultCamera(camera);
      cameraParameters(configuredCamera);
      const ownedCamera = copy(configuredCamera);
      commands.push({ type: 'render_scene', handle, camera: ownedCamera });
      return true;
    },
  });
  return Object.freeze({ host, getScene,
    drain() { const pending = commands; commands = []; return pending; },
    get pendingCount() { return commands.length; },
    get sceneCount() { return scenes.size; },
  });
}
