# Image generation

Read this reference when creating a poster, social graphic, typography treatment,
visual concept, complex raster asset, or a page reference for text-to-code. For page
references, first read [visual direction](visual-direction.md).

## Defaults

| Setting | Default |
|---|---|
| Tool | built-in `generate_ming_image`, `task: "design"` |
| Model | `inclusionai/ming-image-0.1-design` on OpenRouter |
| Output | `artifacts/design-<timestamp>/design_01.png` plus a `manifest.json` |
| Size | Selected by the service |

Prefer the built-in tool. It needs no API key in the skill directory, so the
skill works out of the box; the agent calls the tool directly instead of
running a script. Read the returned paths from the tool result rather than
guessing the timestamped directory.

Set the shared endpoint with `LING_UI_DESIGN_API_BASE` and image defaults with
`LING_UI_DESIGN_IMAGE_*` in the skill-root `.env` or process environment.
Those apply only to the script fallback below. `LING_UI_DESIGN_API_KEY` is
required only for that fallback and has no default.

Describe the target format, orientation, and aspect ratio in the prompt; no `size`
parameter is sent. Inspect the actual output dimensions. For a poster or asset, also
state the subject placement, safe space for copy, visual hierarchy, exact required
text, and what must not appear. A generated spelling is never assumed correct.

For a scrollable page reference, treat the result as design direction rather than proof
that the entire page fits in one browser viewport. Keep sections at a believable scale
and let the composition continue below the fold rather than compressing the whole page.
Do not upscale a visibly soft result in CSS.

## Generate

Call the built-in tool with `task: "design"` and a text prompt:

```text
generate_ming_image(task="design", prompt="scrollable museum landing UI, editorial grid, quiet stone gallery, natural desktop scale, no device chrome")
```

Describe output type, subject, composition, palette, lighting or material, intended
placement, and negative constraints. For typography artwork, quote the exact text,
request no other letters, and verify every character after generation. For interface
references, do not ask the image model to render meaningful UI copy; add it in HTML/CSS.

A generated full-page mockup is visual direction, not final layout. Never embed it as
the implementation. Do not regenerate it to fix copy or to re-split sections; do that
in code. For text-only work, skip generation only when existing visual references
already define the design or the user explicitly chooses direct coding.

## Inspect and retry

Open every result before integrating it. For a **page mockup**, retry only if it is
unusable as visual direction. For a generated **asset**, revise the prompt to name the
observed defect: wrong crop, incorrect subject count, unwanted lettering, palette
drift, missing negative space, or inconsistent perspective. Do not repeat an identical
failed request more than once; normally stop after three attempts.

## Script fallback

Only when the built-in tool is unavailable and the user has configured a key,
`scripts/generate_image.py` performs the same request. `--format` accepts `jpeg`
(default), `jpg` (alias), `png`, or `webp`; use a matching output extension.

```bash
LING_UI_DESIGN_SKILL_ROOT=/absolute/path/to/ling-ui-design
cd /absolute/path/to/target-app
python "$LING_UI_DESIGN_SKILL_ROOT/scripts/generate_image.py" \
  --prompt "scrollable museum landing UI, editorial grid, quiet stone gallery, natural desktop scale, no device chrome" \
  --out artifacts/museum-reference.jpg
```

The helper accepts text prompts only and never logs the API key.
