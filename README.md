# pi-ming-image

A [Pi](https://github.com/earendil-works/pi) package that calls the Ming image models on
OpenRouter for text-to-image generation and single-image layer decomposition.

Both entry points share one implementation and one request path.

## What it does

| Capability | Model | Input | Output |
|---|---|---|---|
| `design` — text to image | `inclusionai/ming-image-0.1-design` | prompt text | one or more PNGs |
| `layer` — image decomposition | `inclusionai/ming-image-0.1-design-layer` | prompt text + **one** local PNG/JPEG/WebP | one or more transparent PNG layers |

Requests go to `POST https://openrouter.ai/api/v1/images`. The image models are **not**
registered as chat models, so they do not appear in Pi's model list.

## Install

Install the tagged GitHub release globally (writes `~/.pi/agent/settings.json`):

```bash
pi install git:github.com/Chasen-Liao/pi-ming-image@v0.1.0
```

Add `-l` to install for a project instead (writes `.pi/settings.json`, relative to
that project). From the root of a local checkout, you can install by path:

```bash
pi install . -l
```

To try that checkout for a single run without changing settings:

```bash
pi -e .
```

Project packages load only after you grant project trust. Restart Pi or run `/reload`
after installing. A local package is identified by its resolved absolute path, so the
same directory cannot load twice through different declarations.

Remove it with `pi remove <source> [-l]`, using the same source and scope you installed with.
The `artifacts/` output and locally generated `.pi/settings.json` are Git-ignored.

## Credential

Resolved at request time, in this order:

1. Pi's OpenRouter provider credential (`pi auth check --provider openrouter`)
2. The `OPENROUTER_API_KEY` environment variable

The token is never written to disk, logged, or included in any artifact.

## Usage

### Slash command

```text
/ming-image design <prompt-file>
/ming-image layer <prompt-file> <image-path>
```

The prompt comes from a UTF-8 file. Quote any path that contains spaces:

```text
/ming-image layer prompts/layer.txt "D:\my art\board.png"
```

Invalid arguments are rejected before any request is sent.

### Agent tool

`generate_ming_image` takes the prompt text directly, so the agent does not need a
temporary prompt file.

```json
{ "task": "design", "prompt": "a calm dark hero with one luminous orb" }
{ "task": "layer",  "prompt": "split into background, cards, illustration, text",
  "imagePath": "D:\\my art\\board.png" }
```

`imagePath` is required for `layer` and rejected for `design`.

> **`layer` uploads the referenced file to OpenRouter.** Only pass images you are allowed
> to upload. The tool description states this, but the agent can still get it wrong.

## Output

Results are written to `artifacts/<task>-<timestamp>/` under the **current working
directory**, not the package:

```text
artifacts/design-20260928-172150/
├── design_01.png
└── manifest.json
```

Each run gets a unique directory, allocated atomically so concurrent runs cannot collide.
The manifest records the task, model, prompt, input image path, actual output files,
elapsed time, and allowlisted numeric usage statistics (`prompt_tokens`, `completion_tokens`,
`total_tokens`, `cost`) when present. Other upstream `usage` fields are discarded; the
manifest does not persist reflected tokens, image base64, or raw upstream error bodies.

A failed or cancelled run removes its directory rather than leaving partial output.

## Known limits

- **Layer output is not guaranteed.** The model decides how many layers to return and
  which roles they cover. The prompt asking for four layers does not mean four files
  come back. Always inspect the saved files.
- **Layer resolution is not preserved.** In a measured run, a 2048×2048 input produced
  four 1024×1024 layers, so a prompt asking to "keep the original geometry" was not
  honoured. Check the output size before assuming the layers align with the source.
- **No automatic retry.** A retry could silently duplicate a billable generation, so
  the request is sent once.
- **No size or aspect ratio control.** The request shape matches what the model accepts;
  neither task sends `size` or `aspect_ratio`.
- **Request timeout is 10 minutes.** A timeout is reported as a timeout, not a success.
- Prompt files are capped at 128,000 UTF-8 bytes in addition to the 32,000-character
  prompt limit; input images are capped at 20 MB. Limits are enforced while reading.
- Input and returned images receive container-structure checks (PNG chunks/CRC, JPEG
  markers, WebP RIFF/chunks). This is **not** a full pixel decode; inspect outputs.
- A returned image is capped at 64 MB, a response at 128 MB, and output at 16 images.

## Measured behaviour

Both tasks were run through this package against OpenRouter on 2026-09-28, once through
the tool and once through the slash command. Every run landed under the calling working
directory:

| Entry point | Task | Result | Time | Reported cost |
|---|---|---|---|---|
| tool | `design` | 1 × 2048×2048 RGB PNG | 49.1 s | 0 |
| tool | `layer` | 4 × 1024×1024 RGBA PNG, alpha 0–255 | 57.7 s | 0 |
| `/ming-image` | `design` | 1 × PNG | 34.0 s | 0 |
| `/ming-image` | `layer` | 4 × 1024×1024 RGBA PNG, alpha 0–255 | 61.3 s | 0 |

The `layer` runs were given a 2048×2048 PNG and returned 1024×1024 layers, matching the
resolution note above. Cost was `0` in all four runs on that account; do not treat that as
a general guarantee.

Six malformed invocations were checked against a real Pi session — no task, missing
prompt file, unknown task, `layer` without an image, `design` with an image, and a
nonexistent prompt file. Each produced a specific error and no output directory.

## Testing against a real Pi session

`test/run-ming-command.ps1` drives a real Pi process in RPC mode and keeps stdin open
while the image generates. Run it from a project where this package is installed;
`--approve` trusts that project's configuration for the test process. Supply your own
prompt file and, for Layer, an image you are authorized to upload:

```powershell
./test/run-ming-command.ps1 -Command '/ming-image design prompts/hero.txt'
./test/run-ming-command.ps1 -Command '/ming-image layer prompts/layer.txt "images/board.png"'
```

This is a manual harness, not part of `npm test`: it makes real OpenRouter requests
that may incur charges.

## Development

```bash
npm test
```

The suite stubs HTTP and credentials, and covers request shape for both tasks, command
argument parsing (including quoted paths), tool argument validation, output directory
concurrency, manifest redaction, error codes (402, 429, auth, empty, malformed, oversized),
cancellation, cleanup of partial output, and the extension module itself driven through a
stub `ExtensionAPI`.

Nothing in the test suite performs a real network request.

### Test dependencies

`@earendil-works/pi-coding-agent` and `typebox` are peer dependencies that Pi supplies at
load time. `test/extension.test.ts` imports the extension module directly, so those two
must also resolve when the tests run. Point them at your Pi installation with junctions
(git-ignored, and not part of the published package):

```bash
mkdir -p node_modules/@earendil-works
ln -s <pi>/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
ln -s <pi>/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox node_modules/typebox
```

The rest of the suite runs without this.


## Layout

```text
extensions/index.ts   registers /ming-image and generate_ming_image
lib/generate.ts       the single shared path both entry points call
lib/openrouter.ts     request shape, timeouts, error mapping
lib/validate.ts       prompt and image validation, format sniffing by magic bytes
lib/artifacts.ts      output directory allocation, writing, manifest
lib/command-args.ts   /ming-image argument parsing
test/                 unit tests
```

## License

[MIT](LICENSE). This repository has a GitHub release; `private: true` in `package.json`
prevents accidental npm publication and does not restrict use under the MIT license.
