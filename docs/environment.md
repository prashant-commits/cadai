# Environment variables

- `EXPLABS_API_KEY` (required): API key for the Experiential Labs model gateway.
- `CADAI_MODEL` (default `gpt-5.6-luna`): model used when the request names none.
- `CADAI_SPEC_SHEETS` (default `on`): `off` disables concept sheets and the 2D review loop (more than one variant still goes to the gate).
- `CADAI_SPEC_REVIEW_RETRIES` (default `5`): max automated sheet-review retries before the variant goes to the gate.
- `CADAI_SPEC_REVIEW_BUDGET_MS` (default `240000`, Vercel only): time budget for the sheet review loop.
- `CADAI_MAX_VARIANTS` (default `3`): max concept variants the architect plans and specs.
- `CADAI_DRAFTER_START` (default `blockout`): `blockout` seeds the drafter with a block-out script; `scratch` starts empty.
- `CADAI_CRITIC_MODEL` (default: the selected model): model override for the design critic.
- `CADAI_VISUAL_CRITIC` (default off): `on` enables the render-based visual critic.
- `CADAI_MAX_ATTEMPTS` (default `1`): global cap on drafter repair attempts per run.
