import assert from "node:assert/strict";
import test from "node:test";
import { parseWiseRosterPages, wiseMailRosterLink } from "./wiseRoster.mjs";

const page = `
<a href="/DocumentCenter/View/7919/November-3-2026-Early-Voting-dates-times-and-locations">November 3, 2026 Early Voting dates, times, and locations</a>
<a href="/DocumentCenter/View/7940/Roster-of-Early-Voting-By-Mail-November-3-2026-General-and-Special-Election-received-as-of-09282026">Roster of Early Voting By Mail November 3, 2026 General and Special Election received as of 09.28.2026</a>
<a href="/DocumentCenter/View/8000/Roster-of-Early-Voting-By-Mail-November-3-2026-General-and-Special-Election-received-as-of-10012026">Roster of Early Voting By Mail November 3, 2026 General and Special Election received as of 10.01.2026</a>
`;

test("uses the newest received-as-of mail roster and leaves the locations PDF alone", () => {
  const link = wiseMailRosterLink(page);
  assert.equal(link.votingMethod, "AB");
  assert.equal(link.asOf, "2026-10-01");
  assert.equal(
    link.href,
    "https://co.wise.tx.us/DocumentCenter/View/8000/Roster-of-Early-Voting-By-Mail-November-3-2026-General-and-Special-Election-received-as-of-10012026",
  );
});

test("reads the VUID and a two-digit vote date", () => {
  const parsed = parseWiseRosterPages([
    [
      { str: "VUID Number", x: 104, y: 240 },
      { str: "Date", x: 714, y: 254 },
      { str: "S 3.3", x: 53, y: 283 },
      { str: "1110349162", x: 128, y: 283 },
      { str: "ONEILL,MORGAN", x: 188, y: 283 },
      { str: "9/28/26", x: 734, y: 283 },
      { str: "*", x: 775, y: 283 },
    ],
  ]);
  assert.deepEqual(parsed.rows, [{ vuid: "1110349162", activityDate: "2026-09-28", votingMethod: "AB" }]);
});
