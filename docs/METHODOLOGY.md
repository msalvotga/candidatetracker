# Methodology

The modeled quantity is a **polling margin**, in percentage points:

> margin = Abbott’s share − Hinojosa’s share

A positive margin means Abbott is ahead in that poll. The trend is an estimate of that margin over time. It is not a probability that either candidate wins the election, and it is not a forecast of votes cast.

Candidate shares are still stored and shown. They are not averaged separately and then subtracted. Averaging shares first lets undecided voters and third-party choices leak into the comparison in a way that depends on how each average was built.

Third-party and undecided voters are **not** reallocated into the two-candidate margin unless `experimental_reallocate_remainder` is turned on. It is off.

## Field dates

The midpoint is still stored and shown:

> midpoint = start + (end − start) / 2

The primary model does not treat every interview as if it happened on that midpoint. A poll fielded September 20–26 is an observation of the average latent margin on those days, with equal weight on each day unless a source reports interviews by day. None of the current polls do.

If the end is before the start, the record fails validation.

## Measurement uncertainty

The modeled quantity is the margin, Abbott minus Hinojosa. A reported margin of error belongs to one candidate share. It is not the margin of error of the difference.

When the shares are proportions and `n_eff` is the effective sample size:

> Var(pA − pB) = [pA + pB − (pA − pB)²] / n_eff

The sampling variance in points-squared is that number times 10,000. Its square root is the sampling standard error of the margin.

`n_eff` is **reported** when the source gives an effective sample size. If the source gives a classical 95% margin of error, `n_eff` is **estimated** by inverting that MOE at a 50/50 share, and the margin variance is then **derived** from the two shares. A design-effect MOE is preferred when the source prints both. The University of Texas August poll is the example: ±2.83, and ±3.58 once weighting is included. The model uses 3.58.

A credibility interval or a non-probability “equivalent margin of error” is stored and labeled **reported**. It is not inverted into `n_eff`. If no classical MOE is usable, `n_eff` is set equal to the raw sample size and labeled **estimated**.

The poll’s measurement variance is:

> R = sampling variance + excess variance + method variance + population variance

Excess variance is the historically calibrated non-sampling piece. It does not go to zero when the sample is huge. Method variance is extra uncertainty for non-probability or online-only methods, estimated from the gap between online and live-phone residuals in the historical file. Population variance would be an extra term for registered-voter or adult samples. That file does not label sample type, so no separate population variance was estimated. Registered-voter polls still enter. Their extra uncertainty, if any, sits inside the shared excess term.

Sampling error is not total polling error.

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

## Source completeness

Model version 1.1.0. Sponsor type is still stored and shown. It is not a default weight. A campaign-sponsored poll is not automatically down-weighted because a campaign paid for it.

The default multiplier measures whether the underlying poll can be documented:

- original pollster source with methodology or crosstabs: 1.00
- original pollster topline with limited methodology: 0.90
- credible institutional or media publication with poll details: 0.85
- aggregator-only result, original source not resolved: 0.70

Sponsor-category multipliers remain in the config for a sensitivity row and for an optional switch. Both are off in the default model.

## Same-pollster clustering

Repeated polls from one organization are correlated. Polls from the same canonical pollster whose midpoints form a chain with gaps of at most 7 days are one cluster.

Each poll in a cluster of size `k` is multiplied by `1 / sqrt(k)`. Two polls in the same week each keep about 71% of the weight they would have had alone. The pair together weighs about 1.41 times one poll, not twice one poll. This is a transparent stand-in for intra-organization correlation, not a full mixed model.

A weight-cap alternative is in the config (`clustering.method: cap`) and is not the default.

## Total weight

> raw weight = precision × recency × sample type × source completeness × cluster adjustment × outlier factor

The outlier factor is 1. A flagged outlier is not down-weighted. Sponsor type is not in this product unless the optional switch is on. House effects, when enabled, change the margin rather than the weight.

The raw weights are then divided by their sum. Every poll in the model shows each factor and the final share. A poll at 26% of the model is 26% because those factors multiplied out that way, not because it was assigned a grade.

## Primary model — latent daily margin

Model version 1.2.0. The headline is a latent polling margin for every day:

> x_t = x_(t−1) + daily shock

The shock is normal with standard deviation `q`, chosen by historical backtest. It is not a 21-day half-life, and it is not a cap on how far the line may move in a day.

A poll is a noisy reading of the average of `x_t` over its field dates, plus a shrunk house effect, plus error with variance R. A high-MOE poll therefore moves the latent line less than a low-MOE poll. Three polls from one firm move it less than three polls from three firms, because a second poll from the same firm inside seven days shares a transitory shock.

The posterior is Gaussian. The displayed number is the posterior mean, which is also the median. The 50%, 80%, and 95% intervals are central posterior intervals. They are not bootstrap percentiles and not a chance of winning.

House effects are normal with a prior standard deviation estimated from older gubernatorial races. Few polls shrink the estimate toward zero. The number is where that pollster has sat relative to the latent margin. It is not labeled partisan bias.

The line is a nowcast of the polling environment. It is not an election forecast.

## Comparison models

These are shown with the latent line. They are not the headline.

**Conservative average.** An exponentially weighted mean. Its half-life is the best of 21, 28, 35, and 42 days on the historical score, unless the overall winner is already that slow.

**Fast trend.** A local linear fit with a 14-day bandwidth, held after the newest field midpoint. If it jumps while the latent and conservative lines stay put, the page says “Possible emerging movement; limited confirmation.” That sentence is not a prediction.

**Straight average.** Equal weight on every qualifying poll released by that day.

**Weighted local linear trend.** The previous default. Precision, recency, sample type, source completeness, and clustering still build its weights. Sponsor type does not. Past the newest midpoint the line is held. Its intervals, when inspected in the comparison machinery, remain a cluster bootstrap.

**EWMA at 7, 10, 14, 21, 28, 35, and 42 days.** Scored in the model lab. The selected comparison half-life is the one with the lowest average 14-day future-poll RMSE across historical gubernatorial races. The primary model does not decay polls with that half-life. Older polls lose influence because process noise accumulates between their release and today.

## Engine A — weighted local linear trend

This is a comparison, not the default.

For each day, polls are combined with a local linear regression. A tricube kernel gives a poll its full poll-weight when the day is on top of its midpoint, and zero weight when the day is more than the bandwidth away (default 28 days). Inside the window the regression is a weighted straight line, and the value used is the line’s height on that day.

Past the newest field midpoint, the line is **held** at the fitted value on that midpoint. A local line will otherwise extrapolate whatever slope the last few polls happened to trace. That slope is not a forecast, and early versions of this fit ran away from the polls for that reason. The hold is labeled on the overview.

The chart does not draw that line until three qualifying polls are in the series. Earlier days stay in the stored series and are labeled insufficient polling density. The visible axis follows the polls and the drawn line. If a stored interval extends past that axis, the picture is clipped and the tooltip keeps the stored number. The stored series is not rewritten.

## Uncertainty for Engine A

Intervals come from a **cluster bootstrap**. Each draw resamples polling organizations with replacement, keeps every poll from the drawn organizations, refits the trend, and stores the path. The displayed margin is the local-linear fit, not the mean or median of those draws.

The intervals are percentile intervals, not a normal approximation and not a highest-density interval. The 80% band is the 10th to 90th percentile of those paths. The 95% band is the 2.5th to 97.5th. Draws are not clipped.

Resampling organizations, rather than polls, means five polls from one shop are not treated as five independent measurements. With few organizations the band is wide. That width is the point. It is uncertainty about the polling trend, not a chance of winning.

## Legacy midpoint filter

A simpler random walk, with observations on the field midpoint and a fixed daily shock of 0.35 points, remains in the comparison table as “State-space trend” only when that older path is still computed beside the local-linear series. The headline path is the field-window filter described above. Its daily shock comes from calibration, not from 0.35.

## House effects

In the primary model, each pollster’s house effect is drawn from a normal prior centered at zero. The prior standard deviation is the between-pollster spread of mean residuals in historical gubernatorial races. The posterior mixes that prior with the pollster’s residuals against the latent margin. One poll is pulled hard toward zero. Many polls that sit on the same side of the latent line can keep a larger estimate. The screen shows the estimate and its standard error.

The sign is points of margin, Abbott minus Hinojosa. It is not a finding that the pollster is biased.

The settings switch still controls whether the local-linear comparison subtracts a house effect. The primary model includes the shrunk effect either way.

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
