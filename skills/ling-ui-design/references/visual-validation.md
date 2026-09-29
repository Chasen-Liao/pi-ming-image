# Visual validation

Use the lightest available browser path. Do not install anything before checking what
the harness already provides.

## Capability order

1. **Harness-native browser or screenshot tool.** Use it when it can load the local
   app, hit the requested viewports, and return images to the model.
2. **Installed browser, headless.** `scripts/capture_page.py --engine chrome` drives
   Chrome, Edge, or Chromium directly and needs no Playwright install. It covers
   desktop widths; see the measured floor below.
3. **`playwright-cli`.** Prefer this Playwright path when a narrow viewport is
   required: one persistent session can open, resize, snapshot, screenshot, click,
   and read console output. Use an existing binary first. If nothing can capture
   the page and Node.js 20+ is present, ask to install the CLI before installing
   Python Playwright.
4. **Existing Python Playwright.** Run `scripts/capture_page.py` without
   `--engine chrome` when the CLI is unavailable. It first tries the bundled
   browser, then installed Chrome and Edge.
5. **Heavier installation, only with user approval.** Python Playwright plus a
   Chromium download, or Linux `install-deps`, only when Node/CLI is not viable.

Resolve every bundled command from the installed skill, not the target application:

```bash
LING_UI_DESIGN_SKILL_ROOT=/absolute/path/to/ling-ui-design
cd /absolute/path/to/target-app
```

Official documentation:

- [Playwright for coding agents](https://playwright.dev/docs/getting-started-cli)
- [Browser installation and existing Chrome/Edge channels](https://playwright.dev/python/docs/browsers)

## Installed-browser route

No installation, no API key:

```bash
python "$LING_UI_DESIGN_SKILL_ROOT/scripts/capture_page.py" \
  --url http://localhost:3000 \
  --outdir artifacts/previews
```

`--engine auto` (the default) uses Playwright when it is importable and otherwise
falls back to the installed browser. The helper locates Chrome, Edge, or Chromium
on Windows, macOS, and Linux; set `LING_UI_DESIGN_CHROME` to an explicit binary
path when auto-detection picks the wrong one.

**The browser clamps `--window-size` to a minimum window width.** On Windows the
observed floor is an `innerWidth` of 518px, so a requested 390px mobile viewport
is laid out at 518px and the resulting PNG is cropped to 390px. That image
misrepresents the requested layout. The helper probes the real viewport first and
refuses to write a preview whose layout is wider than requested, reporting it as
`SKIPPED` instead. `--force-device-scale-factor` does not raise the floor.

Consequences for this route:

- good evidence for desktop layout at a requested width or slightly under it;
- **not** evidence for narrow or mobile layouts — use a harness browser,
  `playwright-cli resize`, or Playwright viewport emulation for those;
- viewport only, never a full-page capture;
- it cannot freeze animation, so confirm the frame is static.

A screenshot containing an empty image frame, or one captured at a viewport other
than the one requested, is failed evidence, not a successful capture.

## Agent CLI route

Check an existing `playwright-cli --help` or project-local binary before installing;
do not use `npx` discovery that could download a missing package.
Ask the user before any install. Installation is one Node package; it can drive
an already-installed Chrome:

```bash
npm install -g @playwright/cli@latest
# or, scoped to the app: npm install -D @playwright/cli@latest
```

```bash
playwright-cli open http://localhost:3000 --browser=chrome
playwright-cli resize 1280 832
playwright-cli screenshot --filename=artifacts/desktop.png
playwright-cli resize 390 844
playwright-cli screenshot --filename=artifacts/mobile.png
```

Before a full-page capture, scroll through the page once and return to the top so
lazy-loaded content is present. Verify that visible images have loaded; a screenshot
containing an empty image frame is failed evidence, not a successful capture.

`playwright-cli install --skills` is optional; this `ling-ui-design` skill already contains
the visual-correction workflow. Still ask before any install; do not silently add a
global package or a project `devDependency`.

## Python Playwright route

If the project already has Playwright, reuse it. To use an installed Chrome without a
browser download:

```bash
python "$LING_UI_DESIGN_SKILL_ROOT/scripts/capture_page.py" \
  --url http://localhost:3000 \
  --channel chrome \
  --outdir artifacts/previews
```

The helper allows five minutes for initial page loading by default; use `--timeout`
only when a page has a known reason to need longer. For full-page captures it performs
the lazy-load scroll automatically and reports the number of images that failed to load.

If no supported browser exists, Node is unavailable, and the user approves a download:

```bash
python -m pip install -e "$LING_UI_DESIGN_SKILL_ROOT[browser]"
python -m playwright install --only-shell chromium
```

On Linux, missing system libraries may require `python -m playwright install-deps
chromium`, which can modify the system and therefore needs separate approval.

An existing browser binary without Playwright provides the coarse desktop evidence
described above. Do not accept it as exact narrow-viewport evidence; use a harness
browser, `playwright-cli resize`, or Playwright viewport emulation, or report the
limitation.

## Correction loop

Capture the exact requested viewport and inspect the image itself. Compare in this
order:

1. page boundary, major regions, and responsive mode;
2. component geometry, alignment, spacing, and overflow;
3. raster assets and cropping. Verify each selected asset actually renders, matches
   its reference occurrence, contains no neighboring UI, and uses the same visible
   crop and fit. An empty frame or improvised placeholder is a failed capture;
4. typography, colors, borders, shadows, and minor decoration;
5. interactions and console/network failures.

Fix the largest material mismatch, then capture again. Default to at most five cycles.
If two captures show no material improvement, stop and report the remaining issue.

Pixel diffs are useful only when baseline and candidate use the same OS, browser,
fonts, and rendering settings. Cross-environment pixel differences are not reliable
design evidence; inspect the rendered screenshots visually.
