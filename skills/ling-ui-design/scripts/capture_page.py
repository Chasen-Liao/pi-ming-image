#!/usr/bin/env python3
# pyright: reportMissingImports=false
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from _common import artifact_path


DEFAULT_VIEWPORTS = (("desktop", 1280, 832), ("mobile", 390, 844))

CHROME_BINARY_ENV = "LING_UI_DESIGN_CHROME"

CHROME_CANDIDATE_NAMES = ("chrome", "msedge", "chromium", "headless_shell")

# Chrome clamps --window-size to a minimum window width, so a requested narrow
# viewport is laid out wider and the PNG is cropped. The floor observed on
# Windows is an innerWidth of about 518px.
NARROW_VIEWPORT_FLOOR = 518

PROBE_HTML = (
    "<!doctype html><meta charset=utf-8><body><script>"
    "document.body.textContent='IW'+window.innerWidth+'IH'+window.innerHeight;"
    "</script></body>"
)

WINDOWS_CHROME_PATHS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
)

MACOS_CHROME_PATHS = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)

POSIX_CHROME_NAMES = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
)


def parse_viewport(value: str) -> tuple[str, int, int]:
    try:
        name, dimensions = value.split("=", 1)
        width_text, height_text = dimensions.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("viewport must be NAME=WIDTHxHEIGHT") from exc
    if not name.strip() or width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("viewport name and dimensions must be positive")
    return name.strip(), width, height


def normalize_url(value: str) -> str:
    if "://" in value:
        return value
    path = Path(value)
    if path.exists():
        return path.resolve().as_uri()
    return value


def launch_browser(playwright: object, channel: str):
    chromium = getattr(playwright, "chromium")
    candidates: list[str | None]
    if channel == "auto":
        candidates = [None, "chrome", "msedge"]
    elif channel == "bundled":
        candidates = [None]
    else:
        candidates = [channel]
    errors: list[str] = []
    for candidate in candidates:
        try:
            if candidate:
                browser = chromium.launch(headless=True, channel=candidate)
            else:
                browser = chromium.launch(headless=True)
            return browser, candidate or "bundled"
        except Exception as exc:  # browser availability differs by host
            errors.append(f"{candidate or 'bundled'}: {type(exc).__name__}")
    raise SystemExit(
        "error: no usable Playwright browser (" + ", ".join(errors) + "). "
        "Read references/visual-validation.md before installing one."
    )


def find_chrome() -> str | None:
    """Locate an installed Chromium browser without installing anything."""
    override = os.environ.get(CHROME_BINARY_ENV)
    if override and Path(override).is_file():
        return override
    if override:
        print(
            f"[capture_page] {CHROME_BINARY_ENV}={override} is not a file; "
            "falling back to auto-detection"
        )
    if sys.platform == "win32":
        for candidate in WINDOWS_CHROME_PATHS:
            if Path(candidate).is_file():
                return candidate
        return None
    if sys.platform == "darwin":
        for candidate in MACOS_CHROME_PATHS:
            if Path(candidate).is_file():
                return candidate
        return None
    for name in POSIX_CHROME_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


def measure_viewport(binary: str, width: int, height: int) -> tuple[int, int] | None:
    """Ask the browser what viewport a window size actually yields."""
    with tempfile.TemporaryDirectory(prefix="ling-ui-probe-") as work:
        probe = Path(work) / "probe.html"
        probe.write_text(PROBE_HTML, encoding="utf-8")
        command = [
            binary,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--hide-scrollbars",
            f"--user-data-dir={Path(work) / 'profile'}",
            f"--window-size={width},{height}",
            "--virtual-time-budget=1000",
            "--dump-dom",
            probe.as_uri(),
        ]
        try:
            result = subprocess.run(  # noqa: S603
                command, capture_output=True, text=True, timeout=120, check=False
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
    match = re.search(r"IW(\d+)IH(\d+)", result.stdout or "")
    return (int(match.group(1)), int(match.group(2))) if match else None


def capture_with_chrome(
    target: str,
    output_dir: Path,
    viewports: list[tuple[str, int, int]],
    *,
    virtual_time_ms: int,
    full_page: bool,
) -> str:
    """Capture with the browser's own headless mode; no Playwright needed.

    This path renders at the viewport the browser grants, which is clamped to a
    minimum width. A clamped capture is reported as unusable for that viewport
    rather than silently written as a valid preview.
    """
    binary = find_chrome()
    if binary is None:
        raise SystemExit(
            f"error: no Chromium browser found. Set {CHROME_BINARY_ENV} to a browser "
            "binary, or use the playwright engine; read references/visual-validation.md."
        )
    clamped: list[str] = []
    for name, width, height in viewports:
        actual = measure_viewport(binary, width, height)
        if actual is not None and actual[0] > width:
            # The layout is wider than requested and the PNG is cropped to the
            # request, so the image misrepresents the requested layout.
            clamped.append(f"{name} (asked {width}x{height}, laid out {actual[0]}x{actual[1]})")
            continue
        if actual is not None and actual[0] < width:
            print(
                f"[capture_page] {name}: browser viewport is {actual[0]}x{actual[1]}, "
                f"slightly under the requested {width}x{height}"
            )
        output = artifact_path(output_dir / f"{name}.png")
        with tempfile.TemporaryDirectory(prefix="ling-ui-capture-") as profile:
            command = [
                binary,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-lcd-text",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                f"--user-data-dir={profile}",
                f"--window-size={width},{height}",
                f"--screenshot={output}",
            ]
            if virtual_time_ms > 0:
                command.append(f"--virtual-time-budget={virtual_time_ms}")
            command.append(target)
            result = subprocess.run(  # noqa: S603
                command, capture_output=True, text=True, timeout=300, check=False
            )
        if not output.is_file():
            detail = (result.stderr or result.stdout or "").strip().splitlines()
            raise SystemExit(
                f"error: chrome produced no screenshot for {name}: "
                + (detail[-1] if detail else f"exit {result.returncode}")
            )
        print(f"[capture_page] {name} {width}x{height} -> {output}")
    if clamped:
        print(
            f"[capture_page] SKIPPED {len(clamped)} viewport(s): the browser clamps "
            "--window-size to a minimum width, so the layout would be wider than "
            "requested and the PNG cropped. Not valid evidence: "
            + "; ".join(clamped)
        )
        print(
            "[capture_page] Use a harness browser, playwright-cli resize, or the "
            "playwright engine for narrow viewports."
        )
    if full_page:
        print(
            "[capture_page] NOTE: the chrome engine captures the viewport only; "
            "a full-page capture needs the playwright engine."
        )
    print(
        "[capture_page] chrome engine cannot disable animation; verify a static "
        "frame before treating a preview as final."
    )
    return Path(binary).name


def prepare_full_page(page: Any) -> list[str]:
    return page.evaluate(
        """async () => {
          const height = document.documentElement.scrollHeight;
          const step = Math.max(1, Math.floor(window.innerHeight * 0.8));
          for (let y = 0; y < height; y += step) {
            window.scrollTo(0, y);
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          window.scrollTo(0, 0);
          const images = Array.from(document.images);
          await Promise.race([
            Promise.all(images.filter(img => !img.complete).map(img =>
              new Promise(resolve => {
                img.addEventListener('load', resolve, {once: true});
                img.addEventListener('error', resolve, {once: true});
              })
            )),
            new Promise(resolve => setTimeout(resolve, 5000))
          ]);
          return images
            .filter(img => !img.complete || img.naturalWidth === 0)
            .map(img => img.currentSrc || img.src || '<unknown>');
        }"""
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Capture stable desktop/mobile previews.")
    result.add_argument("--url", required=True, help="URL or local HTML path")
    result.add_argument("--outdir", required=True)
    result.add_argument("--viewport", action="append", type=parse_viewport)
    result.add_argument(
        "--channel", choices=("auto", "bundled", "chrome", "msedge"), default="auto"
    )
    result.add_argument(
        "--engine",
        choices=("auto", "playwright", "chrome"),
        default="auto",
        help="auto uses playwright when importable and falls back to the installed browser",
    )
    result.add_argument(
        "--virtual-time-ms",
        type=int,
        default=5000,
        help="chrome engine page-settle budget; 0 disables it",
    )
    result.add_argument("--timeout", type=float, default=300.0)
    result.add_argument("--full-page", action=argparse.BooleanOptionalAction, default=True)
    result.add_argument("--allow-motion", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    output_dir = artifact_path(args.outdir)
    output_dir.mkdir(parents=True, exist_ok=True)
    viewports = args.viewport or list(DEFAULT_VIEWPORTS)
    target = normalize_url(args.url)

    if args.engine in ("auto", "chrome"):
        try:
            import playwright.sync_api  # noqa: F401
        except ImportError:
            if args.engine == "playwright":
                raise SystemExit(
                    "error: Python Playwright is unavailable. Use --engine chrome, a "
                    "harness browser, or playwright-cli; read "
                    "references/visual-validation.md before installing."
                ) from None
            print("[capture_page] playwright unavailable; using the installed browser")
            args.engine = "chrome"
        else:
            if args.engine == "auto":
                print("[capture_page] playwright available; using the playwright engine")
            args.engine = "playwright"
    if args.engine == "chrome":
        browser_name = capture_with_chrome(
            target,
            output_dir,
            viewports,
            virtual_time_ms=args.virtual_time_ms,
            full_page=args.full_page,
        )
        print(f"[capture_page] browser={browser_name} (headless); inspect previews before editing again")
        return

    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SystemExit(
            "error: Python Playwright is unavailable. Use --engine chrome, a "
            "harness browser, or playwright-cli; read "
            "references/visual-validation.md before installing."
        ) from exc

    try:
        sync_playwright().start()
    except Exception as exc:  # browser availability differs by host
        raise SystemExit(
            f"error: Playwright could not start ({type(exc).__name__}). Use "
            "--engine chrome for desktop widths, or a harness browser; read "
            "references/visual-validation.md before installing."
        ) from exc

    with sync_playwright() as playwright:
        browser, browser_name = launch_browser(playwright, args.channel)
        try:
            for name, width, height in viewports:
                page = browser.new_page(viewport={"width": width, "height": height})
                try:
                    page.goto(
                        target,
                        wait_until="domcontentloaded",
                        timeout=int(args.timeout * 1000),
                    )
                    try:
                        page.wait_for_load_state("networkidle", timeout=5000)
                    except PlaywrightTimeoutError:
                        pass
                    try:
                        page.evaluate("document.fonts && document.fonts.ready")
                    except Exception:
                        pass
                    if not args.allow_motion:
                        page.add_style_tag(
                            content="""*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"""
                        )
                    if args.full_page:
                        failed_images = prepare_full_page(page)
                        if failed_images:
                            print(
                                f"[capture_page] WARNING: {len(failed_images)} unloaded images; "
                                "inspect the page without logging credential-bearing URLs."
                            )
                    page.wait_for_timeout(250)
                    output = artifact_path(output_dir / f"{name}.png")
                    page.screenshot(path=str(output), full_page=args.full_page, type="png")
                    print(f"[capture_page] {name} {width}x{height} -> {output}")
                finally:
                    page.close()
        finally:
            browser.close()
    print(f"[capture_page] browser={browser_name}; inspect previews before editing again")


if __name__ == "__main__":
    main()
