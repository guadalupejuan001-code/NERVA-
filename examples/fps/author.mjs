import { prepareProgram } from '../../src/runtime.mjs';
import { createFPSWorld } from '../../src/graphics/world.mjs';

/** Host-owned state survives the fresh, bounded interpreter run each frame. */
export function createNPCState(character) {
  if (!character || typeof character.name !== 'string' || typeof character.url !== 'string' ||
    !Array.isArray(character.position) || character.position.length !== 3 ||
    !character.position.every(Number.isFinite) || !Number.isFinite(character.yaw) ||
    ![character.interactionRadius, character.patrolDistance, character.patrolSpeed].every(value => Number.isFinite(value) && value > 0) ||
    typeof character.dialogue !== 'string') throw new TypeError('Invalid character description');
  return { name: character.name, position: [...character.position], homePosition: [...character.position],
    yaw: character.yaw, interactionRadius: character.interactionRadius, patrolDistance: character.patrolDistance,
    patrolSpeed: character.patrolSpeed, dialogue: character.dialogue,
    state: 'idle', elapsed: 0, spoken: false, speechRemaining: 0, patrolDirection: 1, interactionCount: 0 };
}

const GLYPHS = {
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
};

/** Runs the actual NERVA scene program in Node or browser; no generated JS. */
export function buildFPSDescription(source) {
  let configuration = {};
  const objects = [], lights = [];
  const add = object => {
    if (objects.length >= 10_000) throw new RangeError('FPS example exceeds its object budget');
    objects.push(object);
    return objects.length - 1;
  };
  const result = prepareProgram(source, { filename: 'scene.nv' }).run({ captureGlobals: false, host: {
    configure: settings => { configuration = settings; return null; },
    object: add,
    light: light => { lights.push(light); return lights.length - 1; },
    sign: ({ text, position, height, material }) => {
      if (typeof text !== 'string' || text.length > 20 || !Array.isArray(position) || position.length !== 3 ||
        !Number.isFinite(height) || height <= 0) throw new TypeError('Invalid sign description');
      const cell = height / 7, width = (text.length * 6 - 1) * cell;
      for (let letter = 0; letter < text.length; letter++) {
        const glyph = GLYPHS[text[letter]];
        if (!glyph) throw new Error(`Unsupported sign glyph: ${text[letter]}`);
        for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) {
          if (glyph[row][column] !== '1') continue;
          add({ kind: 'box', position: [position[0] - width / 2 + (letter * 6 + column + 0.5) * cell,
            position[1] + (3 - row) * cell, position[2]], scale: [cell * 0.9, cell * 0.9, cell * 0.16], material, solid: false });
        }
      }
      return null;
    },
  } });
  const description = { ...configuration, objects, lights };
  const world = createFPSWorld(description);
  return { description, world, interpreterSteps: result.steps, records: result.records };
}
