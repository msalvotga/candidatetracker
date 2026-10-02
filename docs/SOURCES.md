# Sources

Aggregators are discovery tools. When an original release and an aggregator disagree, the original release is the number stored as the result, and the disagreement is a warning on the poll.

Tiers: 1 original pollster document, 2 sponsor release, 3 aggregator, 4 news writeup, 5 anything else.

## Discovery indexes

- Texas Politics Project, [2026 gubernatorial poll tracker](https://texaspolitics.utexas.edu/blog/texas-2026-gubernatorial-poll-tracker). Retrieved 2 October 2026. The table runs from Quantus (3–4 June) through Fox News (24–28 September). The page’s own “updated” line still mentioned 23 September even though the Fox row was present.
- RealClearPolling, Texas governor Abbott vs Hinojosa. Comparison only. The average was not copied into the model.

Watched organizations and their domains are in `polling/config/sources.yaml`. A new publisher can be added there, or it can arrive through search, without a code change to the race definition.

## What entered the model on the initial import

These had a primary release, a sponsor release, or a saved topline/crosstab behind the shares. Warnings on the poll page still apply.

| Survey | Fieldwork | Sample | Margin (Abbott − Hinojosa) | Primary document |
| --- | --- | --- | --- | --- |
| Fox / Beacon / Shaw | 24–28 Sep 2026 | 881 LV | +5 | Fox crosstab PDF, 1 Oct release. RV frame 1,203 is stored and not double-counted. |
| Texas Public Opinion Research | 19–22 Sep | 1,007 LV | +4 | TPOR release, 25 Sep. Not on the TPP tracker. |
| Marist | 17–20 Sep | 1,139 RV | −3 | Marist narrative, 23 Sep. The 5-point remainder is not in that narrative. |
| Emerson / Nexstar | 12–14 Sep | 1,000 LV | +3 | Emerson release, 17 Sep. Shares sum to 101. Credibility interval ±3. |
| ReconMR | 8–11 Sep | 614 LV | −4 | ReconMR PDF URL. N and MOE are aggregator-corroborated; the PDF itself returned HTTP 403 on 2 Oct. Several sites call this Siena. It is one poll. |
| YouGov for N+ Univision | 27 Aug–4 Sep | 1,000 RV | 0 | TelevisaUnivision release, 9 Sep. Equivalent MOE, not a probability sample. 270toWin’s “LV” label is rejected. |
| UT / Texas Politics Project | 5–13 Aug | 1,200 RV | +5 | UT release, 24 Aug. Model uses the ±3.58 design-effect MOE. Dixon is in the narrative ballot. |
| Emerson / Nexstar | 9–10 Aug | 1,000 LV | +4 | Emerson release, 13 Aug. “Someone else 3” from TPP is not stored. |
| Bush School / ReconMR | 27–30 Jul | 619 LV | +1 | Crosstab PDF. A sentence in the same file says fieldwork began 26 Jul. The headline window is stored. |
| Fox / Beacon / Shaw | 23–27 Jul | 1,006 RV | +1 | Topline PDF saved locally. Other and don’t know are asterisks. TPP’s remainder of 4 is not used. |

## Held out on purpose

- TSU/YouGov, July and September: tracker toplines only.
- NBC/Mason-Dixon or Telemundo/Mason-Dixon: dates, sample type, and the remainder do not agree across secondary sources. No Mason-Dixon document was archived.
- AARP / Fabrizio Ward / Impact Research: 49–46 is repeated, but the MOE is ±3.0 in one index and ±3.3 in another. The MOE was left blank.
- NYT/Siena, 19–27 June: tracker only. This is not the September ReconMR poll.
- UT/Texas Politics Project, June statewide: tracker only. June **suburban** shares from the August UT article are stored on that record and are not a statewide topline.
- ReconMR June: shares are in the later Texas Pulse memo. N and dates are from the tracker.
- Quantus, 3–4 June: tracker only.
- TPOR August: the September article gives the prior margin, Dixon, and undecided, not the full levels. Levels on secondary sites were not promoted.
- Overton Insights (described as Texas Public Policy Foundation-sponsored), SoCal Strategies, Big Data Poll: secondary pages only.

An Emerson/Nexstar survey from January 2026 (Abbott 50, Hinojosa 42, registered voters) is before the late-May primaries. It is outside `series_start` and is not in the database.

## Preservation

Downloads go to `polling/data/raw/YYYY/MM/DD/` and are not overwritten when a hash changes. A new hash is a new `page_versions` row. The July Fox topline PDF is the file that was saved on 2 October 2026. Image-only PDFs are flagged for a person. OCR is not the normal path.
