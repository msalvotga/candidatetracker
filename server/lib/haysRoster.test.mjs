import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { haysRosterLink, parseHaysRosterCsv, parseHaysRosterZip } from "./haysRoster.mjs";

const page = `
<h3><a href="/DocumentCenter/View/5415"><img alt="Absentee Ballots Received"></a></h3>
<h3><a href="/DocumentCenter/View/5414">Excel and CSV available here</a></h3>
<a href="/DocumentCenter/View/100">Proclamation of General Election</a>
`;

test("reads the absentee Excel and CSV zip", () => {
  const link = haysRosterLink(page);
  assert.equal(link.href, "https://www.hayscountytx.gov/DocumentCenter/View/5414");
});

test("reads VUID, Date, and mail status from the CSV", async () => {
  const csv = [
    "VUID,Precinct,Last Name,First Name,Date,Status",
    "2197530315,219,Abdyusheva,Gary,2026-10-05,Mail-In",
    "1000000001,219,Overseas,Voter,2026-09-24,UOCAVA",
    ",219,No,Id,2026-10-06,Mail-In",
    "1000000002,219,Early,Voter,2026-10-19,Early Voting",
  ].join("\n");
  const parsed = parseHaysRosterCsv(csv);
  assert.deepEqual(parsed.rows, [
    { vuid: "2197530315", activityDate: "2026-10-05", votingMethod: "AB" },
    { vuid: "1000000001", activityDate: "2026-09-24", votingMethod: "AB" },
    { vuid: "1000000002", activityDate: "2026-10-19", votingMethod: "EV" },
  ]);
  assert.deepEqual(parsed.missingVuidDays, [{ date: "2026-10-06", missingVuid: 1 }]);

  const zip = new JSZip();
  zip.file("roster.pdf", "pdf");
  zip.file("roster.csv", csv);
  const fromZip = await parseHaysRosterZip(await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(fromZip.rows.length, 3);
});
