import assert from "node:assert/strict";
import test from "node:test";
import { orderTablesForInsert, quoteIdent, sqlTextLiteral } from "./exportDatabase.mjs";

test("quotes text and doubles apostrophes", () => {
  assert.equal(sqlTextLiteral(null), "NULL");
  assert.equal(sqlTextLiteral("O'Brien"), "'O''Brien'");
});

test("rejects unexpected table names", () => {
  assert.equal(quoteIdent("sos_results"), '"sos_results"');
  assert.throws(() => quoteIdent("sos_results;drop"));
});

test("inserts parent tables before tables that reference them", () => {
  assert.deepEqual(
    orderTablesForInsert(
      ["county_results", "election_source_configs", "sos_results"],
      [
        { parent: "election_source_configs", child: "county_results" },
        { parent: "sos_results", child: "county_results" },
      ],
    ),
    ["election_source_configs", "sos_results", "county_results"],
  );
});
