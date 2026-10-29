// One MediaPipe selfie segmenter for the page, in the browser: the cutout in "Put yourself in it" and the crop that
// follows the person on a clip both use it. Loaded once, on first use (about 10 MB).
const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0";
const MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let segmenter = null, loading = null, clock = 0;

// The model runs in video mode, which wants a clock that only goes forward, shared by everyone using it.
export const tick = (n = 1) => clock += n;

export async function getSegmenter(progress, message = "Loading the cutout model (once, about 10 MB)…") {
  if (segmenter) return segmenter;
  progress?.(0, message);
  loading ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import(`${VISION}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
    const make = delegate => ImageSegmenter.createFromOptions(vision, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: "VIDEO", outputConfidenceMasks: true, outputCategoryMask: false });
    // The graphics card when it's quick, else the processor: on some machines the GPU path is slow to read back.
    let seg = await make("GPU").catch(() => null);
    if (seg) {
      const probe = new OffscreenCanvas(288, 512);
      const trial = () => { const t = performance.now(), r = seg.segmentForVideo(probe, tick(2)); r.confidenceMasks[0].getAsFloat32Array(); r.close(); return performance.now() - t; };
      trial(); if (trial() > 80) { seg.close(); seg = null; }
    }
    return seg || await make("CPU");
  })();
  try { return segmenter = await loading; } catch (e) { loading = null; throw e; }
}
