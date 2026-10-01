import assert from "node:assert/strict";
import test from "node:test";
import { harrisBbmRosterLink, parseHarrisBbmCsv } from "./harrisRoster.mjs";

const page = `
<a href="https://appfiles.harrisvotes.com/harrisvotes/prd/Reports/Cumulative_BBM_0526.zip">May 26, 2026 - Primary Runoff Elections - Unofficial BBM Roster for May 04, 2026 - May 27, 2026</a>
<a href="https://appfiles.harrisvotes.com/harrisvotes/prd/Reports/Cumulative_BBM_ToPost_1126.zip">November 03, 2026 - General and Special Elections - Unofficial BBM Roster for September 24, 2026 - September 28, 2026</a>
<a href="https://appfiles.harrisvotes.com/harrisvotes/prd/Reports/Cumulative_EV_1126.zip">November 03, 2026 - General and Special Elections - Unofficial Early Voting Roster</a>
`;

test("picks the November 2026 general unofficial BBM roster", () => {
  const link = harrisBbmRosterLink(page);
  assert.equal(link.href, "https://appfiles.harrisvotes.com/harrisvotes/prd/Reports/Cumulative_BBM_ToPost_1126.zip");
});

test("reads column E as the VUID and column H as the vote date", () => {
  const csv = `Name,VoterAddress,VoterCity,VoterZIP,StateVoterID,IDNumber,Precinct,ActivityDate
"GOWER, ALLISON EMMA",101 WESTCOTT,HOUSTON,77007,,92087934,0070,09/24/2026
"PEACOCK, LINDA LEE",2828 GREENBRIAR,HOUSTON,77098,2221343697,92087411,0139,09/24/2026
`;
  const parsed = parseHarrisBbmCsv(csv);
  assert.equal(parsed.skippedMissingVuid, 1);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-09-24", missingVuid: 1 }]);
  assert.deepEqual(parsed.rows, [{ vuid: "2221343697", activityDate: "2026-09-24", votingMethod: "AB" }]);
});
