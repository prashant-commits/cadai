# Evals plan: designer mode

**Purpose:** measure what the user cares about, which is how good a design is in use and form, as the user judges it. The automatic checks only keep regressions out. Until now our evals rewarded conformance to a plan (requirements coverage, validators, the LLM judge), so quality stalled while the numbers looked fine.

## 1. Ground truth: the user's blind ranking
- **Page:** a generated blind page per run. Every arm is rendered the same way: plain grey, iso, back, front, and open pose. Each prompt gets random letters.
- **Picks are stored.** The user picks the best design per prompt (optionally a full rank). Picks go into the page's shared store, so results come back without copy-paste. Then the page reveals which arm made which design.
- **Primary metric:** blind win rate per arm, per prompt set.
- **Cadence:** one session per milestone, about 15 minutes, with 12–20 prompts per session.

## 2. Prompt sets (frozen, versioned in `eval/designer/sets/`)
| Set | Size | What it measures |
|---|---|---|
| **open** | 12 | Design quality on product-like requests with few stated dimensions: your dock, key holder, desk organizer, jewelry box, headphone stand, lamp base, plant pot with saucer, cable organizer, phone stand, soap dish, wall shelf with hooks, pen holder |
| **prescriptive** | 13 | The A/B prompts: stated dimensions and features met |
| **mechanism** | 6 | Hinges, drawers, snap-fits, sliding lids, rotating arms, nesting or stacking: real motion and fit |
| **edits** | 6 sequences | Build, then 2 follow-ups each ("20 mm taller", "add a cable hole at the back", "rounder corners"): the edit is applied and everything else is kept |
| **adversarial** | 5 | Prompt-injection and escape attempts in the request: guardrail holds, nothing unsafe runs, honest failure message |

## 3. Arms
- **Candidate:** designer + reviewer.
- **Ablation:** designer alone.
- **Baselines, frozen saved outputs:**
  - today's pipeline (ab-v2);
  - the dd1 test outputs;
  - references (Claude Code, Argon docks);
  - the first build where we have it.

Only the candidate and the ablation are re-run, so baselines cost nothing.

## 4. Metrics and targets
| Metric | How | Target |
|---|---|---|
| Blind win rate vs pipeline (open set) | user picks | ≥ 60% |
| Hard checks pass (after designerCheck) | compiles, valid, connected, no interference, motion | 100% |
| Stated-dimension conformance (prescriptive) | dimensions parsed from the prompt vs measured part and body sizes | ≥ 90% |
| Edit fidelity (edits set) | requested change present; other named dimensions and bbox unchanged | ≥ 90% |
| Named-dimension coverage | share of the request's stated sizes that appear as named variables | ≥ 80% |
| Reviewer usefulness | share of blocking/major flags followed by a fix; user marks false flags on a sample; ablation win rate | flags fixed ≥ 70%; false flags ≤ 20% |
| Cost per build | usage, including cache | median ≤ $0.30 |
| Time per build | wall clock | median ≤ 120 s, p90 ≤ 240 s |
| Cap rate | turns, wall or cost cap hit | ≤ 10% |
| Safety | adversarial set | 0 escapes |

**LLM judge:** secondary only. Calibrate it against the user's picks every session. Use it as a signal only while it agrees with the user at least 70% of the time, and cross-check it with Grok now and then.

## 5. Process
- **Per lane:** unit tests plus the gate, with no model calls.
- **Per merge to the designer branch:** smoke-test 3 prompts (open, mechanism, edit) on the automatic metrics, about $1.
- **Per milestone:**
  - full run: open × 2 arms, prescriptive, mechanism, edits, adversarial;
  - concurrency 5;
  - about $15–20;
  - then a user blind session.
- **Report:** `eval/designer/results/<tag>.md` with the metrics table, cost and time, links to the blind page, and a diff against the last milestone.

## 6. Tooling
- Promote `eval/designer/run.ts` (wt-dd1 91a689f) to the official runner. It runs the app's `runDesigner` and `makeReviewer` directly, not a copy, and takes `--set`, `--arms`, `--samples`, `--concurrency` (default 5), `--tag` and a cost cap.
- Blind page generator: adapt the dd test page, adding stored picks.
- Metric scripts:
  - dimension parser for prompts;
  - edit-fidelity diff from named dimensions and bbox;
  - reviewer-flag follow-through from the logs.
- Freeze the baselines into `eval/designer/baselines/`.

## 7. Out of scope for now
- Slider ranges and range sweeps: parked by the user; they return as a separate post-design step with its own eval.
- Printability.
