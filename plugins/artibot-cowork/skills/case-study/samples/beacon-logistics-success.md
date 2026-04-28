<!--
INDEPENDENT REFERENCE — demonstrates case-study skill compliance with a fictional scenario; not derived from fixtures/brief-case-study.md.
Reference implementation — demonstrates case-study skill compliance.
All entities (Beacon Logistics, RouteLift, quoted stakeholders) are fictional.
Industry variant: B2B SaaS serving SMB logistics.
-->

# How Beacon Logistics Cut Dispatch Time by 64% in Nine Months

**TL;DR** — Beacon Logistics, a 74-truck regional carrier, spent 38 minutes per dispatch on manual load matching. After adopting RouteLift's ownership-tagged routing module, dispatch dropped to 13.5 minutes per load. Dispatcher headcount held flat while monthly deliveries rose 27%.

**Industry**: B2B SaaS (logistics operations)
**Timeframe**: July 2025 to April 2026
**Word count**: ~1,680

---

## Challenge

Beacon Logistics operates 74 class-8 tractors out of three terminals across the Mid-Atlantic, serving 118 shippers on contract and spot loads. Through early 2025 the dispatch team ran every load through a spreadsheet, a whiteboard, and a phone tree. Each dispatch took 38 minutes on average, from load acceptance to driver confirmation, and the dispatch team handled 62 loads per day between four full-time dispatchers.

The volume ceiling was visible by spring. Beacon's sales team had closed two new shipper contracts worth an additional 340 loads per month, but operations flagged that the team could not accept without adding two dispatchers at $78,000 loaded cost each. Hiring was open for eleven weeks without a qualified candidate landing an offer.

The stakes were larger than one hiring cycle. Beacon's margin on spot loads had compressed from 14% in 2023 to 9% in early 2025, and the CFO had set a Q3 deadline for either a per-load cost reduction or a capacity expansion that did not require proportional headcount. Without a change, Beacon would decline the two new shipper contracts and lose roughly $1.4M in annualized revenue.

## Strategy

Beacon's operations director evaluated four paths: hire two more dispatchers, outsource dispatch to a third-party TMS provider, build an internal tool on the existing spreadsheet stack, or adopt a routing platform. Hiring stayed open but was not treated as the answer. The spreadsheet build was scoped at 14 engineering weeks against a two-person IT team already committed for the year.

The outsourced dispatch option was rejected after reference calls surfaced a consistent complaint: third-party dispatchers did not know driver preferences, terminal-specific rules, or shipper quirks, and the friction cost recovered whatever hourly savings the outsource promised.

RouteLift was chosen over two competitors because it offered ownership-tagged routing — dispatchers could annotate a driver, a shipper, or a terminal with preference rules that the routing engine honored as hard constraints. The other two platforms treated preferences as soft scoring inputs that the algorithm could override, which Beacon's dispatchers had already rejected in a 30-day pilot of a prior tool.

## Execution

Rollout ran across nine months with three distinct phases, each with an explicit exit criterion.

**Phase 1 — Data consolidation (July to September 2025)**: The Beacon IT team exported driver preferences from three historic spreadsheets, shipper contract rules from the CRM, and terminal operating rules from the safety manual. RouteLift's import tooling consumed the consolidated file after two rounds of schema cleanup. Exit criterion: 100% of active drivers, shippers, and terminals represented in the RouteLift data model. Hit on September 18.

**Phase 2 — Shadow dispatch (October to December 2025)**: Dispatchers continued using the existing spreadsheet process but ran every load through RouteLift in parallel, logging disagreements between the tool's suggested dispatch and the dispatcher's actual choice. The team reviewed disagreements weekly. Of the first 1,440 loads, 217 showed disagreement; 189 were dispatcher-correct (driver-specific context the model did not have) and 28 were RouteLift-correct (pattern matches the dispatcher missed under time pressure). Exit criterion: disagreement rate below 5%. Hit in week 11 at 4.1%.

**Phase 3 — Live cutover (January to April 2026)**: RouteLift became the primary dispatch surface. The spreadsheet remained available as a manual override for the first 60 days. Dispatchers who hit an edge case flagged it in RouteLift's exception queue, and the operations director reviewed every exception weekly. By week 10 of phase 3 the exception queue ran at under three items per week, down from 28 in week one.

Throughout execution Beacon held weekly 30-minute calibration calls with their RouteLift customer success manager. Eleven feature requests were submitted during the rollout; seven shipped within the rollout window, two shipped after, and two were declined with a workaround path documented.

## Results

Beacon measured three categories of outcome: dispatch efficiency, operational capacity, and financial impact. All three showed double-digit improvement within the nine-month window.

| Metric | Before (June 2025) | After (April 2026) | Change |
|---|---|---|---|
| Average dispatch time (minutes/load) | 38 | 13.5 | -64% |
| Loads dispatched per day | 62 | 79 | +27% |
| Dispatchers on staff | 4 | 4 | 0% |
| Monthly revenue (USD) | $1.82M | $2.34M | +29% |
| Margin on spot loads | 9% | 12.5% | +3.5 pts |
| Driver acceptance rate (first offer) | 64% | 81% | +17 pts |
| Dispatcher overtime hours/month | 147 | 34 | -77% |

The two new shipper contracts closed in July 2025 were onboarded without adding dispatch headcount. A third contract, closed in February 2026, was also absorbed on the existing team. The annualized revenue captured from the three contracts landed at $1.71M by April 2026.

Driver acceptance rate — the share of loads a driver takes on first offer, versus rejecting or countering — rose 17 points because RouteLift's ownership tags meant drivers were consistently offered loads that matched their stated preferences for terminal rotation, home-time windows, and shipper history. Fewer rejections meant fewer dispatcher re-work cycles, which compounded the efficiency gain beyond the raw dispatch-time number.

Dispatcher overtime dropped 77%, which the operations director cited as the most unexpected outcome. Before RouteLift, the team absorbed demand spikes by working evenings and weekends; after, the platform's batch-dispatch mode handled spikes without requiring live dispatcher action.

"RouteLift did not replace our dispatchers. It replaced the 24 minutes per load they were spending on data lookup and driver matching, which freed them to handle the exceptions that actually needed human judgment. We are running 27% more volume with the same headcount and the team is less tired than they were before the rollout." — **Marco Delaney, Director of Operations, Beacon Logistics** (quote approved 2026-04-11)

## Lessons

Three takeaways transfer to carriers considering similar platform rollouts.

First, shadow-dispatch before live cutover is non-negotiable for operations teams that have been burned by routing tools. Beacon's dispatchers entered the rollout skeptical because a prior tool had overridden their driver preferences mid-dispatch. Twelve weeks of parallel running with a disagreement log gave the team a track record to point at, and the cutover landed without dispatcher resistance.

Second, preference data was the hardest part of the project, not the software. Three spreadsheets, a CRM, and a safety manual held data in formats that did not align. The data consolidation phase took two more weeks than the original plan, and Beacon's operations director now advises peer carriers to start data cleanup 60 days before any platform selection process closes.

Third, the capacity-without-headcount framing matters at the board level. Beacon's CFO approved the RouteLift investment specifically because the operations director stated the tradeoff in headcount-equivalent terms — $78,000 per avoided dispatcher, versus the platform's annual license cost. A pure dispatch-time metric would not have moved the approval forward.

---

**Quote approval log**

| Quote source | Title/Company | Approval status |
|---|---|---|
| Marco Delaney | Director of Operations, Beacon Logistics | Approved 2026-04-11 (email on file) |

**KPI source verification**: All figures pulled from RouteLift analytics dashboard and Beacon's Q2 2025 through Q1 2026 financial summaries. Final case study reviewed by Beacon's CFO prior to publication.
