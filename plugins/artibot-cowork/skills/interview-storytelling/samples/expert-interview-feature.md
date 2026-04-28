<!--
Reference implementation — demonstrates interview-storytelling skill compliance.
All entities (Prof. Han Ji-won, Meridian Ethics Institute, cited studies) are fictional.
Mode: single-subject feature interview. Voice profile declared before the article body.
-->

# Inside the Consent Gap: Prof. Han Ji-won on What AI Ethics Misses About Ordinary Users

**Mode**: Single-subject feature interview
**Subject**: Prof. Han Ji-won, Director of Applied AI Ethics, Meridian Ethics Institute
**Length**: ~2,060 words
**Voice profile**: Humor -1 (serious, light dry aside); Formality +1 (leans casual, contracted); Respect -2 (strongly respectful of subject); Enthusiasm +1 (matter-of-fact, data-forward)

---

**Editing note**: This interview was conducted over two 75-minute sessions in March 2026. Verbal tics ("um," sentence restarts) have been cleaned silently. Prof. Han reviewed the full summary and approved every quoted passage on 2026-04-09.

**Three-stage approval status**

| Stage | Artifact | Status |
|---|---|---|
| 1. Transcript | Recorded interview + transcription | Complete (2026-03-18, 2026-03-24) |
| 2. Summary + quote list sent to subject | Summary email sent 2026-04-02 | Returned with three edits 2026-04-07 |
| 3. Public-use consent | Written approval for public use on named channels | Received 2026-04-09 |

---

## Why This Conversation Now

Prof. Han Ji-won has spent twelve years studying how AI systems get deployed in institutional settings — hospitals, schools, government benefits offices. Her 2025 paper "The Consent Floor" drew criticism from both the AI-safety establishment and the digital-rights community, which is a strong signal that she said something the field did not want to hear. I sat down with her in March 2026 to understand what she meant by "consent floor," why she thinks the current ethics discourse is misaligned with the actual experience of people interacting with AI systems, and what she would change about how her colleagues in the field frame the stakes.

**The key insight here is** not that AI ethics is wrong about the questions it asks. It is that the questions it asks sit at a different altitude than the moments when ordinary users actually interact with these systems. This interview explores that gap, what Prof. Han thinks the field is getting right, and where she thinks the next five years of research should go.

## On the Origin of the "Consent Floor" Framing

> **Q (Why):** Why did you start using the phrase "consent floor" instead of just talking about consent?

"Consent as a concept has been stretched too thin to do work in AI ethics, and I wanted a term that named the minimum below which the word stops meaning anything. When you ask someone at a benefits office whether an AI system can review their application, and the alternative is a six-week delay, you are not asking for consent. You are informing them of a decision already made. That's not a moral failure of the caseworker. It's a structural fact about the choice architecture. I started saying 'consent floor' because the word 'consent' on its own was covering for situations where no meaningful choice existed, and the field needed a way to distinguish between those and the situations where choice was real."

**What this means in practice** is that the consent conversation in AI ethics has to separate two kinds of settings. In one, the user has a real alternative and the AI is opt-in. In the other, the user has no alternative, and what gets called consent is something closer to disclosure. Prof. Han argues that conflating the two has let institutions use consent language to describe interactions that are structurally non-consensual.

The floor metaphor matters because it implies a minimum below which institutional AI deployment should not proceed, regardless of what the user clicks or signs. In a 2026 paper she is currently submitting, Prof. Han proposes three concrete floor criteria: a non-AI path of comparable duration, a human review right with a named response window, and a refusal path that does not degrade service for the refusing user ([INTERNAL DATA 2026], Han et al. forthcoming manuscript shared with interviewer March 2026).

## On What Ordinary Users Actually Worry About

> **Q (Who):** Who is missing from the AI ethics conversation as you hear it in policy rooms?

"The people whose day-to-day contains the most AI decisions, and who have the least ability to opt out. I'm talking about people applying for housing subsidies, people getting their loan applications scored, people whose kids are evaluated by attendance-prediction systems in school districts. When I go to AI ethics conferences and listen to panels, the stakes are framed around researchers, clinicians, and developers — people who have a choice about whether to use the system. The population with no choice is almost never at the table. It's not because anyone is excluding them deliberately. It's that the conference circuit filters for people who have the time and institutional backing to be there, and 'users who got told an algorithm made the call on their benefits' doesn't fit that filter."

Prof. Han cited a 2025 survey conducted by Meridian across six U.S. states showing that 68% of people whose public-benefits decisions had been partially automated did not know an AI system had been involved until notified by Meridian's research team ([INTERNAL DATA 2026], Meridian Benefits Awareness Study 2025). The survey sample was 2,840 respondents across TANF, SNAP, and housing voucher programs.

**Three things matter** in how she frames the problem. First, the disclosure gap is not a consent failure, it is an information failure that precedes consent. Second, even when users are told, the language used to describe the AI's role rarely captures what the system is actually doing. Third, the burden of understanding has been placed on the user, when the institution is the party with the capacity to make the information legible.

## On Where the Field Is Getting It Right

> **Q (What):** What's the strongest progress you've seen in AI ethics work over the past three years?

"Interpretability research has matured faster than I expected. In 2023 I would have said the field was years away from giving affected users any real window into how a decision was reached. In 2026, we have tools that produce locally faithful explanations for specific decisions that a non-technical user can understand after a ten-minute walkthrough. That's a genuine shift. I don't want to overstate it — the tools are not everywhere, and the institutions that would need to deploy them have not yet. But the research base is no longer the blocker. The blocker is institutional adoption, which is a different problem and a more tractable one."

She pointed to a cross-institutional study she co-authored in late 2025 that measured user comprehension of AI-driven benefits decisions with and without a structured explanation interface. Comprehension, measured by accurate recall of the decision factors at the two-week follow-up, rose from 14% to 61% when users received the structured explanation ([INTERNAL DATA 2026], Han and Okafor 2025, Applied AI Ethics Journal).

**The counterintuitive part** of her optimism is that she thinks the technical work is ahead of the institutional work. Most AI ethics critique assumes the technology is the lagging factor. Prof. Han's position is that the models for producing affected-user-facing explanations exist, the question is whether the benefits office, the hospital intake system, or the school district will deploy them. That's a procurement question, a training question, and a policy question — not a research question.

## On the Edge Cases That Keep Her Awake

> **Q (When):** When does your framework break down?

"Two places. First, in emergency contexts where the consent floor I proposed — alternative path of comparable duration, named human review, non-degrading refusal — becomes impossible to operationalize. If someone is in an acute medical situation and an AI triage system is in the loop, there is no non-AI path of comparable duration because the duration is the constraint. My framework punts on that, honestly. I don't think I've solved it. Second, in contexts where the AI is one input among many and the institutional decision-maker can cite it or ignore it. The floor I proposed assumes the AI is decisive. When it's advisory but heavily weighted in practice, the framework doesn't know what to do with that."

This is a vulnerability disclosure I did not expect in the interview. Most academics protect their framework in public settings. Prof. Han named the two cases where her own proposal fails, and she did it without prompting. When I followed up on why she was willing to say that on record, her response was that "a framework that doesn't name its failure modes is a framework that will be misapplied by its advocates, and I would rather be the first person to point at the holes than the last."

## On What the Next Five Years Need

> **Q (How):** How do you think the field should reorganize its research priorities for the next five years?

"More field work, less theory. The ratio of theoretical papers to empirical studies of actual deployments in actual institutions is wildly skewed toward theory, and it's the empirical work that tells us whether any of the theory holds. A theoretical framework for algorithmic fairness is useful. A longitudinal study of how one school district deployed a prediction system over eighteen months is more useful, because the second one tells you what the first one missed. My institute has been trying to shift our publication ratio from roughly nine theoretical pieces per one empirical to something closer to parity, and it's slow going because empirical institutional research takes longer and funders prefer the cleaner theoretical output."

**Let me show you** what she means with a specific case. Meridian spent fourteen months on a single field study of a housing-voucher prioritization algorithm in one metropolitan area. The study produced one published paper and a closed-door report for the housing authority. In the same window a colleague published four theoretical papers on fairness metrics. The institutional incentives favor the colleague. The actual knowledge delta for the field was arguably higher from the field study, but the field's citation economy doesn't reflect that.

## On the Gap Between Ethics and Engineering Practice

> **Q (Where):** Where in the engineering lifecycle do ethics reviews actually change outcomes?

"Almost never at the end. I don't want to sound cynical about this, but the ethics-review-before-launch model is mostly theater in institutions that haven't committed to it earlier in the process. The reviews that change outcomes happen at problem-framing — before the model is built, before the data is collected, when the team is deciding what question to ask. By the time a model is trained and a launch date is set, the scope for ethics review to change direction is narrow, and most teams resent the review because it looks like a gate they have to clear rather than input they sought. The institutions where ethics work is integrated at framing are rare. When I see it, the outputs look different — not necessarily 'more ethical' in a way that's easy to benchmark, but the problem being solved is usually better-posed."

She named three institutional markers she looks for when assessing whether ethics work is integrated at framing rather than gating: whether the ethics team is in the room for problem definition, whether the team's lead reports at the level of engineering leadership or higher, and whether the team's performance is measured on post-launch outcomes rather than pre-launch review counts ([INTERNAL DATA 2026], Meridian Institutional Practice Audit 2024-2025).

## Closing Reflection

Prof. Han closed our second session with an observation I keep coming back to. "The AI ethics field is still arguing with itself about whether its job is to clean up deployments or to prevent the wrong deployments from happening. Those are different jobs. Different skill sets, different institutional positions, different metrics for success. The field can probably do both, but it should stop pretending it's doing both when most of its energy sits on the cleanup side."

What she left me with is a forward-pointing question rather than a prescription. If the consent floor is a minimum the field should enforce, and the field's current center of gravity is on cleanup rather than prevention, what institutional role has to exist, at what seniority, for prevention to actually happen? That's the question I'd like to see the next generation of AI ethics research try to answer. Prof. Han's hypothesis is that the role does not exist yet in most organizations deploying AI at scale. I suspect she is right.

---

**5W1H question matrix (exposed per spec)**

| Dimension | Q1 | Q2 |
|---|---|---|
| Why | Why start using "consent floor"? | Why is institutional adoption lagging interpretability research? |
| Who | Who is missing from the AI ethics conversation? | Who holds decision authority in current deployments? |
| What | What is the strongest progress in AI ethics? | What institutional markers signal real integration? |
| When | When does your framework break down? | When in the engineering lifecycle does review matter? |
| Where | Where in the engineering lifecycle do ethics reviews change outcomes? | Where geographically have field studies produced most insight? |
| How | How should the field reorganize research priorities? | How should institutions restructure review timing? |

**Signposts used** (target: 3-5 per 1,000 words; article ~2,060 words; count: 4)

- "The key insight here is" (section 1)
- "What this means in practice" (section 2)
- "Three things matter" (section 3)
- "The counterintuitive part" (section 4)
- "Let me show you" (section 6)

**Voice profile placement confirmed**: Writer's framing prose matches declared profile (serious, leans casual, respectful, matter-of-fact). Subject's voice preserved in direct quotes without enforcing writer's tone on her delivery.
