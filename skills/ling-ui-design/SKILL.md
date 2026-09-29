---
name: ling-ui-design
description: >-
  Design posters, social graphics, typography assets, visual concepts, and web
  interfaces with Ming Image, or decompose an existing image into editable layers.
  Use for visual design, text-to-image, image layering, text-to-code,
  screenshot-to-code, and screenshot-guided refinement. This skill is paired with
  pi-ming-image's generate_ming_image tool.
---

# Ling UI Design

Use Ming Image as a design collaborator, then inspect and refine its output. The brief,
supplied assets, exact wording, and product constraints remain authoritative. Generated
images and decomposed layers are drafts rather than proof that the request was followed.

## Choose the path

- **Poster, social graphic, key visual, or typography asset:** read
  [image generation](references/image-generation.md), compose one specific design
  prompt, generate, and inspect the preview. If editable parts are required, continue
  through [layer decomposition](references/layer-decomposition.md).
- **Decompose an existing image:** read
  [layer decomposition](references/layer-decomposition.md), plan useful visual roles,
  run one layer request, and inspect every returned preview before using the files.
- **Text-to-code:** read [visual direction](references/visual-direction.md) and
  [image generation](references/image-generation.md). Generate and inspect a page
  reference, then follow the image-to-code path.
- **Image-to-code:** keep the supplied screenshot as the visual reference. Read
  [layer decomposition](references/layer-decomposition.md), extract useful assets,
  implement the interface in code, and visually validate it.

## Use the Pi tool

Prefer the bundled `generate_ming_image` tool. It uses Pi's OpenRouter credential and
writes each run under the caller's `artifacts/` directory.

- `task: "design"` accepts prompt text only. It cannot take a reference image, and the
  API does not accept an exact size or aspect-ratio field. State the intended format,
  orientation, composition, and negative constraints in the prompt, then inspect the
  actual dimensions.
- `task: "layer"` requires exactly one local PNG, JPEG, or WebP through `imagePath`.
  It uploads that file to OpenRouter, so use only material the user is allowed to upload.
- Read the returned paths instead of guessing the timestamped output directory. Inspect
  the small files listed under `previews/` first; loading full-size PNGs into model
  context can add megabytes to every later request.
- Read `manifest.json` for the actual model, duration, files, and reported usage. A large
  image-token count does not by itself prove a monetary charge; use `usage.cost` and the
  current provider pricing when cost matters.
- One call can take several minutes. Visible heartbeat updates mean the request is still
  running. Do not launch a duplicate request because the first one is slow.
- Treat every retry as potentially billable even when the model is currently listed as
  free. Retry only for a named, material defect and change the prompt to address it.

## Workflow

Run task commands from the target project's root, not the skill directory.
Set `LING_UI_DESIGN_SKILL_ROOT` to the installed skill's absolute path. Store generated
references, layers, crops, and previews in the application's `artifacts/`, and final
assets in its `assets/`. Never write task outputs into the installed skill.

The package supplies `generate_ming_image`; no key belongs in the skill directory.
The skill retains script fallbacks for standalone installations, but do not use them
when the Pi tool is available.

1. Inspect the brief, exact copy, supplied assets, rights to upload them, target format,
   and required editable parts. For interface work, also inspect the repository, run
   command, required views, and target viewports.
2. Build a prompt from concrete requirements: output type, subject, composition,
   hierarchy, palette, lighting or material, exact text when the model must render it,
   and exclusions. Keep the main subject and key copy explicit. Do not ask the model to
   invent product facts or authoritative copy.
3. Generate or decompose once, then inspect the preview and actual dimensions. Check
   subject preservation, spelling, cropping, hierarchy, unwanted text, and artifacts.
   For layers, inspect every returned layer and verify transparency and alignment.
4. For a standalone visual deliverable, keep or refine the best output, preserve the
   full-resolution source, and report observable defects or manual assembly. When
   editable output is requested, separate meaningful roles such as typography, subject,
   decoration, and background rather than assuming the model will return a fixed count.
5. For interface work, continue with the workflow below. Do not begin implementation
   until the visual reference and required raster assets are usable.
6. Separate product UI from browser, operating-system, device, and host-container
   chrome. Recreate only product-owned content unless the user asks for a mock device.
7. Prepare reusable raster assets before writing page code:
   1. Decompose once with the built-in tool's `task: "layer"`, requesting the four
      roles in the prompt. Layers are RGBA PNGs with unused pixels usually
      transparent; the tool decides how many to return and does not label their
      roles, so inspect the original and every layer.
   2. Generate asset candidates with one command:

      `python "$LING_UI_DESIGN_SKILL_ROOT/scripts/crop_elements.py" --layers <decompose-dir> --outdir <crops-dir>`

      Inspect `manifest.json` and every written candidate PNG.
      Candidates are proposals: reject fragments and crops containing unrelated UI;
      split or clean a useful candidate with `scripts/refine_crop.py` or the manual
      mode of `crop_elements.py`. Read [asset placement](references/asset-placement.md)
      before implementation.

   **Asset gate:** Resolve every material raster region as `accepted`, `refined`,
   `generated`, or `omitted`. Omit only a minor nonessential region unless the user
   explicitly accepts a larger fidelity loss. An unresolved material region blocks
   implementation. Never substitute a gradient, solid fill, emoji, or the complete
   reference screenshot for a required raster asset.
8. Follow [pre-implementation analysis](references/pre-implementation-analysis.md) and
   [engineering taste](references/engineering-taste.md). Complete the checklist below
   before writing page code, recording brief conclusions beside the relevant items.

   **Pre-implementation checklist:**
   - [ ] Layout: region order, column proportions, alignment, and major spacing identified.
   - [ ] Visual hierarchy: heading wrapping, type scale, colors, and repeated styles identified.
   - [ ] Every material raster region has one recorded asset-gate outcome.
   - [ ] Every accepted/refined/generated asset visually matches its intended occurrence and
         contains no unrelated text, controls, or neighboring assets.
   - [ ] Selected files are copied to the app `assets/` directory with slot names and
         mapped to their intended page locations.
   - [ ] Every mapped raster has a defined slot size and fit matching the reference.
   - [ ] No complete reference screenshot or improvised placeholder is used as layout.

   Then implement text, controls, layout, and simple icons in code, using the resolved assets.
9. Run the page and follow [visual validation](references/visual-validation.md).
   Capture the requested viewports, inspect the images, fix the largest material
   mismatch, and capture again. A capture taken at a viewport other than the one
   requested is not evidence.
10. Verify interactions, responsive behavior, asset loading, and console errors.

## Visual-model outputs are drafts

Inspect every generated image and decomposed layer. If a generated page
reference is unusable as visual direction (wrong page type, collapsed layout,
or wrong mood), name the defect and retry; stop after three attempts. Do not
regenerate because mockup copy is wrong or a brief section is missing or merged;
restore those in code from the brief.

For decomposition, overlap or imperfect separation alone does not justify a retry. Generate and
review asset candidates first. Rerun the layer call at most once, only when a material
raster is missing from every layer or every candidate for it is unusable. Name that exact
defect in the revised prompt; keep the source image and layer roles fixed. If the second
decomposition still cannot recover the asset, report the limitation and ask for a
replacement or permission to generate an alternative.

For a misplaced or noisy crop, reclean it with `scripts/refine_crop.py` in that
image's own coordinates, or pass an explicit `--box` to `crop_elements.py`.
Always inspect the cleaned output before using it.

## Evidence hierarchy

1. Original user brief, supplied screenshots, and supplied assets.
2. The selected generated reference for appearance only, never for authoritative copy.
3. A rendered screenshot of the current implementation.
4. Decomposed layers, which may overlap, omit content, or invent hidden pixels.

Do not let a lower source override a visibly contradictory higher source.

## Service and environment rules

- Prefer the built-in `generate_ming_image` tool for generation and decomposition.
  It needs no key in this skill directory. When a script fallback is used, one
  `LING_UI_DESIGN_API_KEY` covers both stages: read it from the process
  environment first, then the gitignored `.env` in this skill's real root. Never
  place the key in prompts, command arguments, logs, committed files, or generated
  debug JSON.
- Keep the skill directory and its `.env` outside static-serving roots and deployment
  bundles. Publish only the application's required files, not the skill directory.
- When a helper reports a missing key, relay its application guide and
  environment/`.env` options; pause that capability until the user configures the
  key locally. Never ask for a key in chat or fill it from conversation text.
- Non-sensitive endpoints, model names, sizes, and timeouts may use the defaults in
  `.env.example`; credentials have no defaults.
- Give image-generation and layer-decomposition requests at least 10 minutes; never
  set a script client timeout below 600 seconds.
- If the built-in tool is unavailable and no script fallback is configured, report
  it and ask the user whether to configure it or explicitly skip that stage. Do not
  silently collapse the visual-first workflow into ordinary direct UI coding. A
  supplied screenshot skips reference generation, but decomposition still needs an
  image model.
- Installing Playwright, browsers, packages, or system dependencies changes the
  environment. Ask the user before installation. Prefer an existing harness browser
  or an already-installed Chrome/Edge, which need no install. If a capture tool must
  be added, prefer one `npm install` of `@playwright/cli` over Python Playwright and
  a Chromium download.

## Completion

Stop visual iteration when the requested viewports have no material structural,
asset, typography, overflow, or interaction mismatch. A default ceiling of five
render-and-correct cycles prevents low-value polishing loops; report any remaining
observable limitation.
