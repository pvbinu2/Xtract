# Xtract business plan

Prepared 9 September 2026. Based on the repository README, selected application code, and public competitor pricing. India is the assumed initial market; this is a positioning choice to validate, not an established customer fact. All Xtract prices, costs, conversion rates, and revenue figures below are planning hypotheses. No customer traction or extraction benchmark was supplied.

**Recommendation**

Build Xtract into a B2B document processing business, starting with invoice capture, review, and export for finance operations teams. Monetize through a monthly subscription with included processing volume, additional usage charges, and a separate implementation fee. Start with paid, assisted pilots and customer-isolated deployments. Add self-service SaaS after proving repeatability and tenant isolation.

The initial promise: “Turn incoming invoices into reviewed, structured records ready for your accounting system.” Sell reduced handling time and dependable delivery. Positioning around extraction alone leaves Xtract competing mainly on accuracy and price.

**Product foundation and commercial gaps**

The repository describes PDF, image, and Excel ingestion; configurable schemas; classification; AI extraction; side-by-side validation; source highlighting; API ingestion; downstream JSON delivery; and processing cost visibility. These provide a foundation for paid pilots. The README explicitly describes Xtract as a prototype; this review is not a production-readiness certification.

Configurable hosted AI and Ollama support could support deployment flexibility. Local application deployment alone does not guarantee that data stays local: extraction, embeddings, telemetry, and other outbound flows must all be checked before making that promise.

The user and incoming-document schemas inspected do not contain tenant identifiers. Treat shared multi-customer hosting as unproven. Existing validation attribution is useful, but is not evidence of a complete, immutable audit history. Generic downstream API delivery also does not mean there are production-ready accounting or ERP connectors.

**Initial customer and problem**

Target finance teams at distributors and service businesses, plus accounting firms providing recurring bookkeeping services. Prioritize customers processing roughly 2,000–10,000 invoices monthly, receiving varied supplier formats, and spending substantial time entering and checking data. For accounting firms, begin with one client entity in an isolated environment; cross-client access and reporting require additional product work.

The buyer is the finance head, business owner, or accounting-firm partner. Daily users are accounts payable staff and reviewers. The buying trigger is rising document volume, a processing backlog, costly outsourcing, or a new accounting-system rollout.

The first workflow should cover invoice headers, totals, tax amounts, and agreed line items, with human approval before delivery. Focus discovery on documents that still require manual handling; customers already receiving reliable structured invoice data may have little need for extraction.

Avoid launching simultaneously into healthcare, lending, recruitment, and contract analysis. Each brings different fields, acceptance criteria, integrations, and buying processes. Expand after three to five customers buy substantially the same workflow.

**Competitive position**

Public pricing checked on the preparation date:

| Alternative | Published commercial model | Implication for Xtract |
| --- | --- | --- |
| Docparser | Monthly Starter $39 for 100 credits; Business $159 for 1,000 credits. One credit covers a document up to five pages. | Low-cost parsing is already available. Xtract must demonstrate workflow value. |
| Nanonets | Usage by workflow block; published examples include $0.02 simple operations, $0.10 standard AI, and $0.30 complex AI per run. | Buyers need a predictable estimate for their full workflow. |
| Rossum | Starter begins at $18,000 annually; quotes vary with volume and workflow complexity. | A focused, assisted offer can test demand below enterprise procurement budgets. |

Sources: [Docparser pricing](https://docparser.com/pricing), [Nanonets pricing](https://nanonets.com/pricing), [Rossum pricing](https://rossum.ai/pricing/). These units and feature packages differ; the figures are not a like-for-like cost or quality comparison.

Xtract's proposed differentiation is fast implementation for a narrow workflow, transparent volume pricing, source-linked review, and a dependable connection to the customer's accounting process. These are hypotheses to prove against actual alternatives. Durable advantages would come from reusable workflow rules, tested mappings, regression datasets used with permission, and implementation partners. The underlying AI model is not a defensible advantage by itself.

**Monetization and proposed pricing**

Use a platform subscription plus included pages and overages. Include reviewers generously: charging heavily per reviewer could discourage the quality-control step that makes the product useful. Do not offer unlimited processing.

| Offer | Proposed price, excluding applicable taxes | Scope |
| --- | --- | --- |
| Paid pilot | ₹25,000 once, four weeks | One workflow, up to 1,000 pages, agreed fields, baseline measurement, and a standard JSON export. Custom integration quoted separately. |
| Starter — later | ₹15,000/month | 2,000 pages, three reviewers, one workflow, standard export; ₹6 per additional page. Launch only when deployment and support costs justify it. |
| Growth — initial recurring offer | ₹40,000/month | 8,000 pages, ten reviewers, up to three agreed document types, API access and one supported integration; ₹4 per additional page. |
| Business — after repeatability | ₹85,000/month | 20,000 pages, twenty reviewers, more workflows, priority support and reporting; ₹3 per additional page. |
| Private deployment — later | Test a ₹12 lakh annual software/support minimum | Customer infrastructure and AI consumption billed separately; implementation from ₹1.5 lakh, with support scope explicitly capped. |

The plan packaging describes intended commercial offers, not a claim that every entitlement or connector exists today. For managed cloud plans, standard AI consumption is included within the page allowance. Premium models, unusually complex documents, and dedicated infrastructure require an explicit quote.

Charge ₹30,000–₹1 lakh separately for standard onboarding, depending on document types, mapping, and integration effort. Quote bespoke integrations as fixed-scope projects with milestones and change control. Do not subsidize indefinite customization through the subscription.

Introduce annual contracts after successful pilots, with a modest discount only if margins support it. Longer-term opportunities include partner/reseller agreements and an embedded API with minimum monthly commitments. Offer human-operated review services only as a separately priced, labor-costed service; customer employees perform review in the core subscription. Advertising and customer-document resale do not fit this product.

**Billing rules**

A billable page is a source PDF/image page for which extraction completes successfully. Include normal classification and internal retry costs in that price. Repeated idempotent submissions and retries caused by Xtract failures must not create duplicate charges. Customer-requested new processing after schema changes can be charged if clearly disclosed.

Meter at source ingestion and reconcile against a durable usage ledger. Send allowance alerts and let customers choose approved overages or a hard stop. Cap document size and complexity. Quote Excel separately during pilots until a row/cell-based unit is tested; a worksheet can contain too much data to equate fairly to one PDF page.

**Customer return on investment**

Illustrative Growth customer: 5,000 invoices monthly, averaging 1.6 pages, use the 8,000-page allowance. Assume manual handling takes four minutes per invoice and Xtract-assisted review takes one minute. The reduction is 250 staff-hours monthly. At an assumed fully loaded ₹300 per hour, capacity released is worth ₹75,000/month. After the ₹40,000 subscription, the modeled benefit is ₹35,000/month; ₹60,000 onboarding would take about 1.7 months to recover.

This is capacity value, not necessarily cash saved. If manual handling already takes two minutes, savings fall to 83.3 hours or ₹25,000; the same subscription would not pay for itself on labor alone. Qualify customers using measured time, volume, and wage cost. Treat avoided errors and faster turnaround as additional benefits only when the customer can substantiate them.

**Unit economics and pricing gates**

Illustrative monthly Growth account at its full allowance:

| Item | Base assumption |
| --- | ---: |
| Subscription revenue | ₹40,000 |
| AI, OCR, and variable processing: 8,000 pages × ₹0.60 | ₹4,800 |
| Allocated hosting, storage, queues, monitoring | ₹4,000 |
| Support and account-specific maintenance | ₹3,000 |
| Total direct delivery cost | ₹11,800 |
| Gross contribution | ₹28,200 |
| Gross margin | 70.5% |

These are estimates, not measured Xtract costs. At ₹1.50 variable cost per page, direct cost becomes ₹19,000 and margin drops to 52.5%. At ₹3/page, margin drops to 22.5%. Actual dedicated infrastructure could also exceed the allocation, especially at low customer counts. Include payment costs, storage retention, failed runs, backups, and support in the measured model before setting final prices.

Instrument real costs across representative scans, long documents, line-item tables, languages, and retries. Track cost per accepted document as well as per page. Use the existing token-cost dashboard as one input; token estimates do not capture total delivery cost. Require a path to at least 70% gross margin for a repeatable hosted offer. Reprice complex workflows or reduce scope when that gate fails.

**Customer acquisition and first 90 days**

Days 1–15: conduct 15–20 buyer interviews. Ask for monthly volume, current handling time, error/rework patterns, systems used, data restrictions, and budget authority. Obtain permission to evaluate a representative document sample. Choose one workflow and one destination system based on repeated demand.

Days 16–30: build an evaluation set spanning suppliers and document quality, separate from schema-tuning examples. Run five qualified demonstrations using customer-relevant documents. Sell three fixed-scope paid pilots. A working offer: “We will measure the reduction in invoice handling time on your documents and demonstrate reviewed export into your agreed workflow.”

Days 31–60: deliver the pilots in isolated environments, measure baseline versus assisted handling, and log every correction and failed delivery. Add the most requested reusable connector. Set acceptance criteria with each buyer before the pilot starts. Do not promise a universal accuracy percentage.

Days 61–90: aim to convert two of the three pilots to subscriptions, secure permission for one quantified case study, and approach two accounting or ERP implementation partners. These are execution targets, not a predicted conversion rate.

Use founder-led introductions, targeted outreach, accounting communities, and partner referrals first. Track accounts contacted, qualified meetings, sample evaluations, paid pilots, conversions, and sales-cycle length. Defer broad paid advertising until an offer converts consistently. Suggested CAC gate: recover fully loaded acquisition cost within six months of recurring gross profit, including founder sales time and partner commission in the cost.

**Product work tied to revenue**

Before paid production use: verify isolated customer environments, strong authentication and secrets handling, backup restoration, queue failure recovery, monitored delivery, and agreed retention/deletion behavior. Implement invoice-specific validation, such as required fields and total reconciliation, with clear exceptions for review. Retain reviewer identity and a history of changes; approval attribution alone is insufficient for a full audit trail.

Before shared SaaS: implement and test organization-level isolation across databases, files, queues, vector search, API keys, and realtime events. Add a usage ledger, quotas, subscription entitlements, billing reconciliation, and customer administration. Shared hosting must wait until cross-customer access tests pass.

After repeated demand: add email ingestion, a supported accounting connector, operational reporting, and configurable approval routing. Confidence thresholds should be calibrated against labeled outcomes before enabling automatic posting. SSO, contractual availability commitments, advanced audit controls, and additional deployment regions belong in a buyer-funded enterprise roadmap.

**First-year operating scenario**

Assume a small founder-led team, ₹2 lakh monthly fixed operating expense excluding direct delivery costs, a ₹30,000 average monthly subscription across customers, and 70% blended recurring gross margin. Budget actual founder compensation, development, sales, and administration before using this as a funding plan.

Illustrative active subscription accounts by month: 0, 0, 0, 1, 2, 3, 4, 5, 6, 8, 10, 12. These are net active counts; the example assumes no churn and should be revised once retention is known.

| Metric | Base scenario |
| --- | ---: |
| Customer-months in year one | 51 |
| Year-one recurring revenue | ₹15.3 lakh |
| Month-12 recurring revenue | ₹3.6 lakh |
| Annualized recurring revenue at month 12 | ₹43.2 lakh |
| Year-one recurring gross profit at 70% | ₹10.71 lakh |
| Fixed operating expense | ₹24 lakh |
| Operating loss before implementation contribution | ₹13.29 lakh |
| Setup revenue: 12 customers × ₹30,000 | ₹3.6 lakh |
| Setup contribution at assumed 50% margin | ₹1.8 lakh |
| Operating loss after setup contribution | ₹11.49 lakh |

Paid-pilot revenue is excluded to avoid assuming how pilot fees and onboarding credits interact. ARR is an exit run rate, not revenue earned during the first year. This operating example excludes taxes, financing, capital purchases, and cash-collection timing. Starting cash needs must include those items and a contingency; they cannot be inferred from the operating loss alone.

At ₹30,000 average revenue and 70% gross margin, each active account contributes ₹21,000 monthly. Approximately ten active accounts cover ₹2 lakh monthly fixed expense. Six accounts produce ₹1.8 lakh MRR and ₹1.26 lakh contribution; twelve produce ₹3.6 lakh MRR and ₹2.52 lakh contribution; twenty-four produce ₹7.2 lakh MRR and ₹5.04 lakh contribution. The larger scenario would likely require more staffing, so do not assume fixed expenses stay flat indefinitely.

**Risks and decisions**

The largest commercial risk is insufficient value after review effort. Measure time per accepted document, correction rate, delivery success, and customer retention. Report accuracy separately for critical fields, line items, document classification, and complete documents; a pooled field score can hide expensive errors.

The largest delivery risk is becoming a bespoke integration agency. Standardize one workflow, limit included implementation hours, and track reusable versus customer-specific work. The main cost risks are complex scans, retries, low utilization of dedicated infrastructure, and support. The main trust risks are incorrect output and unclear data handling; document actual system behavior and keep human review until automation is justified by evidence.

Continue investing after the first three pilots if at least two convert, handling time falls by at least 50% on representative work, buyers accept the quality of reviewed output, and measured costs support the margin target. These are proposed decision gates. If they fail, revise the workflow, target segment, or price before expanding features or acquisition spend.

The immediate commercial action is to sell one ₹25,000 invoice-processing pilot, measure the customer's economics, and use the results to validate a ₹40,000/month recurring offer.
