/** Explicit resolution budgets; the normal high preset follows the display. */
export const FPS_QUALITY_PRESETS = Object.freeze({
  high: Object.freeze({ maxWidth: 1920, maxHeight: 1080, scale: 1, shadowSize: 2048, sampleCount: 4, fxaa: true }),
  balanced: Object.freeze({ maxWidth: 1280, maxHeight: 720, scale: 0.75, shadowSize: 1024, sampleCount: 4, fxaa: true }),
  validation: Object.freeze({ maxWidth: 320, maxHeight: 180, scale: 1, shadowSize: 512, sampleCount: 1, fxaa: true }),
});

export function fpsRenderSettings(quality, { width, height, devicePixelRatio = 1 } = {}) {
  const preset = FPS_QUALITY_PRESETS[quality];
  if (!preset) throw new RangeError('Unknown FPS quality preset');
  if (![width, height, devicePixelRatio].every(value => Number.isFinite(value) && value > 0))
    throw new RangeError('Display dimensions and pixel ratio must be positive finite numbers');
  const requestedWidth = width * devicePixelRatio * preset.scale;
  const requestedHeight = height * devicePixelRatio * preset.scale;
  if (!Number.isFinite(requestedWidth) || !Number.isFinite(requestedHeight))
    throw new RangeError('Display pixel dimensions must be finite');
  const budget = Math.min(1, preset.maxWidth / requestedWidth, preset.maxHeight / requestedHeight);
  return { width: Math.max(1, Math.floor(requestedWidth * budget)),
    height: Math.max(1, Math.floor(requestedHeight * budget)), shadowSize: preset.shadowSize,
    sampleCount: preset.sampleCount, fxaa: preset.fxaa };
}
