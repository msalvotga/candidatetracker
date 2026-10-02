# Model assumptions

Each knob below is a choice. The settings screen can change the ones that are exposed. Reset restores `polling/config/model.yaml`.

## Variance floor (τ)

**What it does.** Adds a constant, in points, to the denominator of the precision weight: `1 / (SE² + τ²)`.

**Why it exists.** Sampling error is not the whole error. Without a floor, the largest poll dominates.

**Default.** 2 points.

**If increased.** Every poll’s precision weight moves toward the same value. Sample size and MOE matter less. The trend moves toward a recency-and-design weighted average.

**If decreased.** Precise polls gain influence. A very small floor lets one large survey swamp the others. Zero is allowed by the math and is a bad idea.

## Recency half-life

**What it does.** Sets how fast a poll’s weight falls. At one half-life, the recency factor is 0.5.

**Why it exists.** A poll from three weeks ago is evidence about a slightly different electorate.

**Default.** 21 days. Adaptive mode can replace it as Election Day gets closer (30, then 21, then 14).

**If increased.** Older polls keep more weight. The trend moves more slowly.

**If decreased.** The trend hugs the newest surveys and ignores more of the recent past. Very short half-lives make one new poll the whole story, which the variance floor only partly restrains.

## Adaptive half-life switch

**What it does.** Picks the half-life from how many days remain until 3 November 2026.

**Why it exists.** Closer to an election, last month’s electorate is less relevant.

**Default.** On.

**If turned off.** The fixed half-life is used all the way to Election Day.

**If the bands are shortened.** The trend forgets faster in that window.

## LV, RV, and Adults multipliers

**What they do.** Multiply the weight of a poll by the factor for its sample type.

**Why they exist.** Likely-voter screens are closer to the electorate that shows up, especially late. Registered-voter polls still contain information. Dropping them would be a different, quieter assumption.

**Defaults.** LV 1.00, RV 0.80, Adults 0.50, other 0.70.

**If an RV multiplier is increased toward 1.** Registered-voter polls count almost like likely-voter polls. The current RV-only check (Hinojosa ahead in the October 2026 fit) gets more say in the blended trend.

**If it is decreased.** Those polls fade. The trend leans on LV surveys. That is a choice about timing, not a fact about which poll was conducted well.

## Sample-type mode

**What it does.** `multiplier` uses the factors above. `model_based` tries to estimate an additive shift between sample types and shrink it toward zero.

**Why it exists.** The multipliers are round numbers. A later estimate from overlapping LV and RV polls would be less arbitrary, but only after there is enough overlap.

**Default.** `multiplier`.

**If switched to model-based.** The switch is in the config so the estimator has a place to live. Until enough overlapping LV and RV polls exist to estimate a shrunk effect, the multipliers above are what the fit uses. The code does not drop the RV multiplier just because the switch was flipped.

## Sponsor multipliers

**What they do.** Multiply weight by the sponsor category.

**Why they exist.** A candidate poll is still evidence, and it is not the same kind of evidence as a news-media poll. The factor is an influence assumption.

**Defaults.** Public, media, and university 1.00. Advocacy and unknown 0.85. Candidate or party 0.70.

**If increased.** That category moves the trend more.

**If decreased.** It moves the trend less. Zero would drop the category without deleting the rows. The archive does not do that on its own.

## Cluster window and method

**What they do.** Group a pollster’s polls when midpoints are chained by gaps no larger than the window. `sqrt_dampen` multiplies each member by `1/sqrt(k)`. `cap` limits the cluster’s total raw weight.

**Why they exist.** A pollster who publishes every week should not get a new independent vote in the average each time.

**Defaults.** 7 days, `sqrt_dampen`.

**If the window is increased.** More of a pollster’s sequence is treated as one cluster, so each poll counts less.

**If it is decreased.** Only nearly simultaneous releases are dampened.

## Local-linear bandwidth

**What it does.** Sets how many days around a date are allowed to shape that date’s fitted margin.

**Why it exists.** The raw polls jump. A bandwidth smooths them without replacing them with a straight line for the whole year.

**Default.** 28 days.

**If increased.** The line is smoother and slower to turn.

**If decreased.** The line follows poll-to-poll noise. Very small bandwidths also make the edge of the series depend on a single poll.

The hold past the newest midpoint is not a separate knob. It is there so the bandwidth’s slope is not drawn into the future.

## House-effect adjustment

**What it does.** Subtracts a shrunk pollster effect from each poll before the trend is fit.

**Why it exists.** A pollster can sit a few points to one side for reasons that repeat. Adjusting for that is reasonable only after several polls, and it changes the answer, so it starts off.

**Default.** Off. Minimum 3 polls. Shrinkage `k` of 8.

**If turned on with thin data.** Pollsters under the minimum are not adjusted. Pollsters just over the minimum are adjusted by a small fraction of their raw gap.

**If `k` is increased.** Effects shrink harder toward zero.

**If `k` is decreased.** The raw gap is trusted sooner. With three polls, a small `k` will treat noise as a house style.

## Outlier threshold

**What it does.** Flags a poll when the absolute standardized residual exceeds the threshold. It does not remove the poll.

**Default.** 2.5.

**If increased.** Fewer flags.

**If decreased.** More flags, including polls that are only somewhat off the line.

## State-space daily shock

**What it does.** Sets how far the latent margin is allowed to wander in a day when Engine B is drawn.

**Why it exists.** The polling environment moves, and the size of that movement is an assumption.

**Default.** 0.35 points per day, standard deviation. Initial standard deviation 8.

**If increased.** The latent margin tracks new polls faster and the uncertainty band widens between polls.

**If decreased.** The line is stiffer. A new poll moves it less.

## Bootstrap draws

**What they do.** Set how many cluster-bootstrap refits are stored.

**Default.** 400, seed 2026, so a rebuild is repeatable.

**If increased.** The percentiles settle down. The run gets slower.

**If decreased.** The bands jitter between rebuilds.

## Colors and the “even” band

**What they do.** Color the candidates, and call a margin inside ±0.5 points “approximately even.”

**Why they exist.** The words on the page should match the sign of the number, and a 0.1-point lead should not be narrated as a lead.

**If the even band is widened.** More results are described as even.

**If it is narrowed.** Small leads get a candidate’s name.
