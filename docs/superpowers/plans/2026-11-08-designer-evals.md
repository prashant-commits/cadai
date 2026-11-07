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
| **iterative** | 12 sequences | Build, then add 1, 2 or 3 random features one at a time (see section 2a): each new feature lands, earlier features survive, and the design stays coherent |
| **adversarial** | 5 | Prompt-injection and escape attempts in the request: guardrail holds, nothing unsafe runs, honest failure message |

## 2a. Iterative set: does the design survive repeated feature additions?
**Shape:** a base request, then a random sequence of follow-up feature additions, at most 3, sent one at a time as chat follow-ups. This is the same path a user takes.
- **Mixed lengths:** across the 12 sequences, 4 get 1 addition, 4 get 2 and 4 get 3.
- **Mixed kinds:** each sequence draws its features from different kinds, so no sequence is all cosmetic.
- **Reproducible:** sequences are generated once from a fixed seed and frozen in `eval/designer/sets/iterative.json`.

**Base objects (12):** box with lid, phone stand, desk organizer, wall shelf, headphone stand, small enclosure, planter, lamp base, drawer unit, cable tray, pen holder, monitor riser.

**Feature pool,** drawn by kind:
| Kind | Examples |
|---|---|
| Simple cut or boss | cable hole at the back, mounting holes, label recess on the front, rubber-foot recesses underneath, ventilation slots |
| Added part | handle, hook, divider, pen slot, phone slot, small tray |
| Mechanism | hinged lid, small drawer, sliding cover, snap-on cap |
| Global change | 20 mm taller, rounder edges, make it 30% wider, thinner walls |
| Conflicting | add something where an earlier feature already is (a drawer where the storage cavity is): the designer must resolve it sensibly and say how |

**Measured at every step:**
- **Feature landed.** Checked with a geometric probe where possible: hole or slot count up, a new labelled part, a bbox or named-dimension change of the right size, a moving part that moves. Otherwise the reviewer checks it on renders.
- **Nothing lost.** Every feature from earlier steps is still present; the probes are re-run cumulatively.
- **Locality.** Named dimensions and parts the user did not mention are unchanged. Measure how much of the script changed outside the edited area.
- **Hard checks** pass after each step.
- **Cost and time per step.**

**Measured at the end:**
- **Coherence.** The final design after 1–3 additions is ranked blind by the user against a fresh single-request build of the same combined request: "box with lid + cable hole + drawer" asked all at once. If iteration degrades quality, the gap shows here.
- **Metrics and targets:**
  - feature landed ≥ 95% of steps;
  - nothing lost ≥ 95% of steps;
  - no cap hit within a sequence;
  - blind tie or win against the single-request build in ≥ 50% of sequences.

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
| Iterative (iterative set) | feature landed; earlier features kept; final design vs single-request build | landed ≥ 95%, kept ≥ 95%, blind tie or win ≥ 50% |
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
  - full run: open × 2 arms, prescriptive, mechanism, edits, iterative (about 24 extra steps), adversarial;
  - concurrency 5;
  - about $20–25;
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
