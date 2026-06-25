/**
 * Texas statewide elected offices for the candidate tracker.
 * up_for_reelection: 1 = on the 2026 general election ballot, 0 = not on ballot this cycle.
 */
export const STATEWIDE_OFFICES = [
  { code: "GOV", name: "Governor", holder: "Greg Abbott", party: "R", up_for_reelection: 1, sort_order: 10 },
  { code: "LTGOV", name: "Lieutenant Governor", holder: "Dan Patrick", party: "R", up_for_reelection: 1, sort_order: 20 },
  { code: "AG", name: "Attorney General", holder: "Ken Paxton", party: "R", up_for_reelection: 1, sort_order: 30 },
  { code: "COMPT", name: "Comptroller of Public Accounts", holder: "Kelly Hancock", party: "R", up_for_reelection: 1, sort_order: 40 },
  { code: "GLO", name: "Commissioner of the General Land Office", holder: "Dawn Buckingham", party: "R", up_for_reelection: 1, sort_order: 50 },
  { code: "AGRI", name: "Commissioner of Agriculture", holder: "Sid Miller", party: "R", up_for_reelection: 1, sort_order: 60 },

  { code: "USS-TX-1", name: "U.S. Senate (Texas)", holder: "Ted Cruz", party: "R", up_for_reelection: 0, sort_order: 70 },

  { code: "SCOTX-CHIEF", name: "Supreme Court, Chief Justice", holder: "Jimmy Blacklock", party: "R", up_for_reelection: 1, sort_order: 100 },
  { code: "SCOTX-PL2", name: "Supreme Court, Place 2", holder: "James Sullivan", party: "R", up_for_reelection: 1, sort_order: 102 },
  { code: "SCOTX-PL3", name: "Supreme Court, Place 3", holder: "Debra Lehrmann", party: "R", up_for_reelection: 0, sort_order: 103 },
  { code: "SCOTX-PL4", name: "Supreme Court, Place 4", holder: "John Devine", party: "R", up_for_reelection: 0, sort_order: 104 },
  { code: "SCOTX-PL5", name: "Supreme Court, Place 5", holder: "Rebeca Huddle", party: "R", up_for_reelection: 0, sort_order: 105 },
  { code: "SCOTX-PL6", name: "Supreme Court, Place 6", holder: "Jane Bland", party: "R", up_for_reelection: 0, sort_order: 106 },
  { code: "SCOTX-PL7", name: "Supreme Court, Place 7", holder: "Kyle Hawkins", party: "R", up_for_reelection: 1, sort_order: 107 },
  { code: "SCOTX-PL8", name: "Supreme Court, Place 8", holder: "Brett Busby", party: "R", up_for_reelection: 1, sort_order: 108 },
  { code: "SCOTX-PL9", name: "Supreme Court, Place 9", holder: "Evan Young", party: "R", up_for_reelection: 0, sort_order: 109 },

  { code: "CCA-PRES", name: "Court of Criminal Appeals, Presiding Judge", holder: "David J. Schenck", party: "R", up_for_reelection: 0, sort_order: 200 },
  { code: "CCA-PL2", name: "Court of Criminal Appeals, Place 2", holder: "Mary Lou Keel", party: "R", up_for_reelection: 0, sort_order: 202 },
  { code: "CCA-PL3", name: "Court of Criminal Appeals, Place 3", holder: "Bert Richardson", party: "R", up_for_reelection: 1, sort_order: 203 },
  { code: "CCA-PL4", name: "Court of Criminal Appeals, Place 4", holder: "Kevin Yeary", party: "R", up_for_reelection: 1, sort_order: 204 },
  { code: "CCA-PL5", name: "Court of Criminal Appeals, Place 5", holder: "Scott Walker", party: "R", up_for_reelection: 0, sort_order: 205 },
  { code: "CCA-PL6", name: "Court of Criminal Appeals, Place 6", holder: "Jesse McClure", party: "R", up_for_reelection: 0, sort_order: 206 },
  { code: "CCA-PL7", name: "Court of Criminal Appeals, Place 7", holder: "Gina G. Parker", party: "R", up_for_reelection: 0, sort_order: 207 },
  { code: "CCA-PL8", name: "Court of Criminal Appeals, Place 8", holder: "Lee Finley", party: "R", up_for_reelection: 0, sort_order: 208 },
  { code: "CCA-PL9", name: "Court of Criminal Appeals, Place 9", holder: "David Newell", party: "R", up_for_reelection: 1, sort_order: 209 },

  { code: "15TH-CHIEF", name: "15th Court of Appeals, Chief", holder: "Scott Brister", party: "R", up_for_reelection: 1, sort_order: 300 },
  { code: "15TH-PL2", name: "15th Court of Appeals, Place 2", holder: "Scott Field", party: "R", up_for_reelection: 1, sort_order: 302 },
  { code: "15TH-PL3", name: "15th Court of Appeals, Place 3", holder: "April Farris", party: "R", up_for_reelection: 1, sort_order: 303 },
];
