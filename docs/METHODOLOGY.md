# Methodology

The modeled quantity is a **polling margin**, in percentage points:

> margin = Abbott’s share − Hinojosa’s share

A positive margin means Abbott is ahead in that poll. The trend is an estimate of that margin over time. It is not a probability that either candidate wins the election, and it is not a forecast of votes cast.

Candidate shares are still stored and shown. They are not averaged separately and then subtracted. Averaging shares first lets undecided voters and third-party choices leak into the comparison in a way that depends on how each average was built.

Third-party and undecided voters are **not** reallocated into the two-candidate margin unless `experimental_reallocate_remainder` is turned on. It is off.

## Field date

The observation date is the midpoint of fieldwork.

> midpoint = start + (end − start) / 2

June 3–4 is the morning of June 4 in fractional days (June 3.5), not a date that was quietly rounded. If the end is before the start, the record fails validation.

## Measurement uncertainty

A poll of 2,000 respondents is not twice as informative as a poll of 1,000. Sampling variance shrinks with the square root of the sample, and it is not the only error.

When a source prints a margin of error, it is treated as an approximate 95% interval:

> standard error of a proportion = (MOE / 100) / 1.96

If the source also prints a margin of error that already includes the design effect, that larger figure is the one used. Both numbers stay on the record. The University of Texas August poll is the example: ±2.83, and ±3.58 once weighting is included. The model uses 3.58.

The quantity in the model is a **difference of two shares**. Under a simplified multinomial approximation, with shares written as proportions:

> variance(Abbott − Hinojosa) ≈ [pA + pB − (pA − pB)²] / n_eff

The standard error of the margin, in points, is 100 times the square root of that variance.

`n_eff` is taken from the source when the source gives an effective sample size. Otherwise it is inverted from the margin of error, assuming the published MOE is the conventional one at a 50/50 proportion:

> n_eff ≈ 0.25 / (standard error)²

That inversion is labeled **estimated**. If there is no margin of error, `n_eff` is set equal to the raw sample size and also labeled estimated, because the design effect is unknown and that choice is optimistic. The variance floor below is what keeps the optimism from running away.

Emerson’s “credibility interval” and Univision/YouGov’s “equivalent margin of error” are used as the uncertainty input and labeled as such. They are not classical simple-random-sample margins of error.

## Variance floor

> precision weight = 1 / (SE² + τ²)

`τ` starts at 2 percentage points. It is poll-level uncertainty that sampling error does not cover: methods, weighting, and the gap between a poll and the electorate it is trying to measure.

A poll with a tiny standard error still cannot have a precision weight larger than `1 / τ²`. A survey of 20,000 people is not allowed to become the trend by itself.

## Sample type

Likely-voter and registered-voter polls are both kept. They are not the same population.

In the default **multiplier** mode the precision weight is multiplied by:

- LV 1.00
- RV 0.80
- Adults 0.50
- anything else 0.70

**Model-based** mode is the alternative. It tries to estimate an additive LV/RV shift from polls that overlap in time, shrunk toward zero, and only if each type has enough polls (default 4). Until that switch is on, the multipliers are the whole sample-type adjustment. The statewide model does not invent a sample-type effect from a handful of polls and pretend it measured one.

## Recency

> recency weight = 0.5 ^ (age in days / half-life)

Age is measured from the field midpoint to the as-of date. The default half-life is 21 days: a three-week-old poll counts half as much, all else equal.

If adaptive half-life is on, the half-life depends on how far Election Day (3 November 2026) is:

- more than 60 days out: 30 days
- 31 to 60 days: 21 days
- 0 to 30 days: 14 days

On 2 October 2026 that rule selects 21 days.

## Sponsorship

Sponsorship is recorded. Partisan polls are not deleted. The default multipliers are assumptions about influence, not grades of honesty:

- nonpartisan/public, media, university: 1.00
- advocacy: 0.85
- candidate or party: 0.70
- unknown: 0.85

## Same-pollster clustering

Repeated polls from one organization are correlated. Polls from the same canonical pollster whose midpoints form a chain with gaps of at most 7 days are one cluster.

Each poll in a cluster of size `k` is multiplied by `1 / sqrt(k)`. Two polls in the same week each keep about 71% of the weight they would have had alone. The pair together weighs about 1.41 times one poll, not twice one poll. This is a transparent stand-in for intra-organization correlation, not a full mixed model.

A weight-cap alternative is in the config (`clustering.method: cap`) and is not the default.

## Total weight

> raw weight = precision × recency × sample type × sponsorship × cluster adjustment

The raw weights are then divided by their sum. Every poll in the model shows each factor and the final share. A poll at 26% of the model is 26% because those factors multiplied out that way, not because it was assigned a grade.

## Engine A — weighted local linear trend

This is the default.

For each day, polls are combined with a local linear regression. A tricube kernel gives a poll its full poll-weight when the day is on top of its midpoint, and zero weight when the day is more than the bandwidth away (default 28 days). Inside the window the regression is a weighted straight line, and the value used is the line’s height on that day.

Past the newest field midpoint, the line is **held** at the fitted value on that midpoint. A local line will otherwise extrapolate whatever slope the last few polls happened to trace. That slope is not a forecast, and early versions of this fit ran away from the polls for that reason. The hold is labeled on the overview.

## Uncertainty for Engine A

Intervals come from a **cluster bootstrap**. Each draw resamples polling organizations with replacement, keeps every poll from the drawn organizations, refits the trend, and stores the path. The 80% band is the 10th to 90th percentile of those paths. The 95% band is the 2.5th to 97.5th.

Resampling organizations, rather than polls, means five polls from one shop are not treated as five independent measurements. With few organizations the band is wide. That width is the point. It is uncertainty about the polling trend, not a chance of winning.

## Engine B — state-space trend

The latent margin is a random walk:

> today’s margin = yesterday’s margin + a daily shock

The daily shock has a default standard deviation of 0.35 points. The filter starts from the average of the poll margins, with an initial standard deviation of 8 points, so the start is not dogmatic.

A poll is an observation of the latent margin on its field midpoint, plus noise. The observation standard deviation is `sqrt(SE² + τ²)`, the same sampling error and the same floor as Engine A. If house-effect adjustment is on, the poll is shifted by the shrunk house effect before it enters the filter.

The reported line is the smoothed latent margin. The 95% band is the smoothed mean plus or minus 1.96 smoothed standard deviations. The interval is Gaussian and model-based. It is not a bootstrap, and it is not a win probability.

House effects and sample-type effects are **not** estimated inside the filter by default. House-effect adjustment starts off. Sample type changes Engine A’s weights; it does not silently add a bias term in Engine B.

## House effects

A house effect is the average gap between a pollster’s margins and the trend on those midpoints, pulled toward zero.

> displayed effect = raw average × n / (n + k)

`n` is the number of polls. `k` defaults to 8. Three polls keep 3/11 of their raw average. Ten polls keep 10/18. One or two polls do not get a number; the screen says the effect is not estimated.

The sign is “+X Abbott” or “−X Hinojosa”. It is a description of where that pollster has sat relative to the other polling, not a finding that the pollster is biased.

The adjustment switch subtracts the shrunk effect from the poll before the trend is refit. It is off until you turn it on.

## Outliers

A residual is the poll margin minus the trend on its midpoint. The standardized residual divides that by `sqrt(SE² + τ²)`. The default flag is an absolute value above 2.5.

Flagged polls stay in the model. Removing one requires an exclusion reason. An unusual result is not automatically a bad poll.

## Duplicates

Automatic linking requires two things: a high similarity score, and fieldwork that is actually the same window (dates within 3 days, or overlapping). Score ingredients are pollster name, sponsor, dates, sample size, sample type, and the two candidate shares.

The same pollster releasing a similar result a month later is a new poll. Emerson’s August and September surveys are the test case.

When records are linked, every source is kept and one canonical record is used. The canonical record is the approved one with the best source tier. You can merge or unmerge by hand.

## Subgroups

Crosstabs are stored with the original label and a normalized label. “Hispanic” and “Latino” share a normalized name. “18–34” and “18–29” do not. “Independent” and “Independent / other” do not.

If the cell’s sample size was not published, the screen says so. It is not invented.

A subgroup trend is drawn only after three approved polls in the same compatible group. The trend uses recency, and reported subgroup `n` when it exists. If `n` is missing, the trend is recency-only and says it is not a precision claim.

Subgroup margins are not added back into the statewide model. The topline is already a weighted estimate of the electorate.

## Snapshots

Every recalculation stores the as-of date, the poll ids, the configuration, the estimate, the intervals, and the software version. The public file the page reads is `polling/data/public_snapshot.json`. Older rows stay in the `model_snapshots` table. That is how a later question — what the model said on a given day — can be answered from the archive rather than from memory.

## What this import would not do

- It would not turn an asterisk in a Fox topline into a number. Fox defines `*` as less than half a point. The Texas Politics Project’s “someone else / don’t know = 4” for the July Fox poll conflicts with that topline. The PDF is the number that is stored.
- It would not treat the September ReconMR survey as a second poll just because another site calls it Siena.
- It would not approve a Mason-Dixon row while the dates, sample type, and remainder still disagree across secondary writeups.
- It would not use a RealClearPolitics average as an input. The comparison slot is empty until a published average is transcribed on purpose, and even then it stays a comparison.
