/**
 * Green Party and Libertarian Party nominees for the 2026 cycle.
 * Sources:
 * - https://www.txgreens.org/2026_nominated_candidates
 * - https://www.lptexas.org/candidates
 */
export const THIRD_PARTY_CANDIDATES_2026 = [
  // Green Party — U.S. House
  { party: "G", officeCode: "TX-7", name: "Espoir Ngabo", website: "https://espoirfortexas.com" },
  { party: "G", officeCode: "TX-28", name: "Marlón Durán", website: "https://marlonduran.com" },
  { party: "G", officeCode: "TX-31", name: "Greg Stoker", website: "https://www.stokerfortexas.com/" },
  { party: "G", officeCode: "TX-34", name: "Eddie Espinoza", website: "https://espinoza4tx.com" },
  { party: "G", officeCode: "TX-38", name: "Alex McMenemy", website: "https://alexforthepeople.org/" },

  // Green Party — statewide
  { party: "G", officeCode: "COMPT", name: "Shehla Faizi", website: "https://www.faizifortexas.com" },
  { party: "G", officeCode: "AGRI", name: "Alfred Molison", website: "http://votealfred.com/" },
  { party: "G", officeCode: "LTGOV", name: "Kevin McCormick", website: "https://www.kmm2026.org/" },

  // Green Party — Texas Senate / House
  { party: "G", officeCode: "SD-26", name: "Julián Villarreal", website: "https://www.julianfortxsenate.org" },
  { party: "G", officeCode: "HD-049", name: "Arshia Papari", website: "https://arshiafortexas.org/" },
  { party: "G", officeCode: "HD-061", name: "Anissa Chilmeran", website: "https://anissa4congress.com/" },

  // Libertarian Party — statewide
  { party: "L", officeCode: "USS-TX", name: "Ted Brown" },
  { party: "L", officeCode: "GOV", name: "Pat Dixon" },
  { party: "L", officeCode: "LTGOV", name: "Anthony Cristo" },
  { party: "L", officeCode: "AG", name: "Tom Oxford" },
  { party: "L", officeCode: "COMPT", name: "V. Alonzo Echavarria-Garza" },
  { party: "L", officeCode: "GLO", name: "Neill Snider" },
  { party: "L", officeCode: "AGRI", name: "Austin R Kelly" },
  { party: "L", officeCode: "CCA-PL3", name: "Mark Ash" },

  // Libertarian Party — U.S. House
  { party: "L", officeCode: "TX-26", name: "Phil Gray" },
  { party: "L", officeCode: "TX-34", name: "Chris Royal" },

  // Libertarian Party — Texas House
  { party: "L", officeCode: "HD-014", name: "Jeff Miller" },
  { party: "L", officeCode: "HD-015", name: "Jessi Cowart" },
  { party: "L", officeCode: "HD-057", name: "Darren Hamilton" },
];

/** Nominees listed on LPTexas but not tracked in this app (no matching office row). */
export const SKIPPED_THIRD_PARTY_CANDIDATES = [
  { party: "L", office: "Railroad Commissioner", name: "Arthur DiBianca", reason: "no RRC office in tracker" },
];
