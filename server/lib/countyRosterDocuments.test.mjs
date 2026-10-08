import assert from "node:assert/strict";
import test from "node:test";
import { rosterDocumentBody } from "./countyRosterDocuments.mjs";

test("a voter roster is stored as text so Postgres does not build one giant JSON value", () => {
  const small = rosterDocumentBody({ enabled: true });
  assert.equal(small.asText, false);
  const voters = Array.from({ length: 4000 }, (_, index) => ({
    vuid: String(index),
    profile: [{ label: "FirstName", value: "VOTER" }, { label: "LastName", value: "NAME" }],
  }));
  const large = rosterDocumentBody(voters);
  assert.equal(large.asText, true);
});
