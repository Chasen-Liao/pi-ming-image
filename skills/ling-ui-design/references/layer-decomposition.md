# Layer decomposition

Read this reference when an existing or generated image needs editable visual parts,
or before implementing from a supplied page reference. For interface work, run one
decomposition for each primary reference; the original plus all layers provide visual
context and possible reusable photographs, illustrations, textures, logos, or partially
occluded assets.

## Default request

| Setting | Default |
|---|---|
| Tool | built-in `generate_ming_image`, `task: "layer"` |
| Model | `inclusionai/ming-image-0.1-design-layer` on OpenRouter |
| Output | RGBA PNGs at `artifacts/layer-<timestamp>/layer_01.png` … plus a `manifest.json` |

Prefer the built-in tool; it needs no key in the skill directory. The agent
calls it directly. The tool decides how many layers to return and does not
label their roles, so request the four roles in the prompt and identify each
returned file by inspecting it.

Every returned `layer_*.png` is an RGBA PNG. Unused pixels are usually
transparent. Keep that alpha when cropping and when using the crop. Do not
convert layers to JPEG. Do not flatten them onto a solid background. A
checkerboard in a viewer is transparency, not a pattern to copy.

`LING_UI_DESIGN_API_KEY` and the `LING_UI_DESIGN_API_BASE` /
`LING_UI_DESIGN_DECOMPOSE_*` settings apply only to the script fallback below.

The built-in tool sends the original image at its original resolution and preserves its
aspect ratio in the request, but the model may return a different output resolution.
Its manifest records `input_image` but no
`source_size`; the crop helpers fall back to the layer pixels, so measure
`--box` coordinates in the layer's own coordinates.

If the returned count differs from four, identify each layer by inspecting it
and crop the roles you actually need. `crop_elements.py` assigns the four
default roles positionally to `layer_01..layer_04` (front to back), so a
different count is not accepted by the automatic pass; crop such a result with
explicit `--image` plus `--box`.

## Preset prompt

```text
Decompose into 4 layers: 1 all text only no cards, 2 primary photos and
illustrations only no text, 3 foreground decorations and container visuals no
text, 4 complete background no text no foreground objects
```

State the layer roles in the prompt. The built-in tool does not apply
server-side prompt enhancement to a caller-supplied plan, so the plan must
stand on its own.

The script fallback below sends a longer equivalent plan with `use_pe=true`:

```text
Decompose this image into 4 layers with the following specifications:

Number of layers: 4
Preserve the source composition and geometry exactly. Keep reusable photographs and illustrations high-detail with clean boundaries; do not resize, reposition, blur, or simplify them.
Layer 1 (text): All designed overlay text.
Layer 2 (image): All photographs and illustrations, complete and text-free, including pictures that appear inside cards.
Layer 3 (container): Empty UI chrome: navigation bars, buttons, badges, ribbons, colored section banners, and empty card or panel frames. Keep their colors and shapes. Do not include photographs.
Layer 4 (background): Remaining empty page canvas only. No photographs. No overlay text.
```

## Run

Call the built-in tool, then read the returned directory:

```text
generate_ming_image(task="layer", imagePath="artifacts/design-<timestamp>/design_01.png", prompt="Decompose into 4 layers: 1 all text only no cards, 2 primary photos and illustrations only no text, 3 foreground decorations and container visuals no text, 4 complete background no text no foreground objects")
```

Inspect every returned layer. The manifest lists the output files; the labels
`text`, `image`, `container`, and `background` are positional expectations, not
proof that the model obeyed them. Layers may overlap or contain misplaced
content.

Decomposition produces full-canvas layers, not accepted page assets.
Run the default candidate pass on the **image** and **background** layers; the
helper uses available service boxes and connected alpha regions to locate crops,
preserving original layer pixels inside each box:

```bash
python "$LING_UI_DESIGN_SKILL_ROOT/scripts/crop_elements.py" \
  --layers artifacts/layer-<timestamp> \
  --outdir artifacts/reference-crops
```

Read `artifacts/reference-crops/manifest.json` and inspect every written candidate PNG.
Service boxes are optional hints; missing or invalid metadata keeps the alpha-only path.
Nearly identical same-layer candidates retain the alpha-component crop only when it
covers its effective alpha content (alpha ≥ 8); near-transparent outer fringes may
be omitted, but pixels inside the retained crop are unchanged. Distinct candidates remain available.
Layer selection uses alpha overlap with reference appearance as a secondary signal;
outputs always come from layers, never reference crops. A matched IR background
replaces generic background-layer candidates; it still requires visual inspection.
The helper may recover a detector-located raster misplaced on a non-text layer.
The default alpha pass skips text and container layers;
if a material raster was misplaced there, manually crop that inspected layer rather
than silently omitting it. Treat `review: true` as a warning, not a verdict. Then read
[asset placement](asset-placement.md).

## Decomposition recovery

Overlap or imperfect separation alone does not justify a retry. Run
`scripts/crop_elements.py --layers … --outdir …` and inspect its candidates first.

Rerun the layer call only when a material raster asset is missing from every
layer, or every crop of it is unusable. Then run **once** more:

1. Write a full prompt that names the missing object and which layer should own it.
2. Keep the source image and the layer roles the same. The script fallback
   additionally keeps `--size` and `--seed` the same.

Stop after that second call. Keep the better of the two. Do not regenerate the page
because of an overlay. If neither attempt recovers the required asset, report the limitation
and ask for a replacement or permission to generate an alternative.

## Script fallback

Only when the built-in tool is unavailable and the user has configured a key:

```bash
LING_UI_DESIGN_SKILL_ROOT=/absolute/path/to/ling-ui-design
cd /absolute/path/to/target-app
python "$LING_UI_DESIGN_SKILL_ROOT/scripts/decompose_layers.py" \
  --image reference.png \
  --outdir artifacts/reference-layers
```

It writes `source_size` into the manifest and records the requested roles, and
supports `--layers`, `--size`, `--steps`, `--seed`, `--prompt-file`, and
`--no-pe`.
