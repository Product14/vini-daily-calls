// Franchise-brand (OEM) classification for the Rooftop-level Usage dashboard's
// "Franchise Brand" filter.
//
// No new DB column: enterprise_team_details is CDC-replicated (read-only) and
// the dashboard's "dealer name" isn't one single source anyway (see
// callbackAttribution.js's header for the same class of problem). Instead we
// classify at read-time from data already flowing through agentBaseFact.sql —
// the dealer/team name (reliable, space-segmented) and, as a fallback, the
// dealer's website_link (which agentBaseFact.sql doesn't select yet).
//
// Design validated against the 89 real Vini rooftop team_ids pulled from the
// funnel sheet + cross-checked in ClickHouse: 71/89 matched by name alone,
// +1 by URL fallback, 17/89 genuinely unclassifiable (generic names/sites).
// Zero false positives observed.

// Keyword -> canonical brand. Matched two ways depending on source (see below):
//   • against a dealer/team NAME: split into tokens on non-alphanumeric chars,
//     then require EXACT token equality. This is what makes short keywords
//     (ford, kia, gmc, ram, vw, bmw, audi, mini, fiat) safe here — "Stanford"
//     or "Bedford" is one token and never equals the token "ford".
//   • against a website_link HOSTNAME (fallback only, used when the name
//     yields nothing): hostnames are usually concatenated with no separators
//     (e.g. getteltoyotagainesville.com), so exact-token matching can't apply.
//     We fall back to substring matching, but ONLY for keywords >= 5 chars —
//     short/ambiguous ones are excluded from this path entirely because a
//     concatenated hostname gives no boundary to rule out collisions like a
//     "-ford" place-name ending.
const BRAND_KEYWORDS = [
  ["chevrolet", "Chevrolet"], ["chevy", "Chevrolet"],
  ["honda", "Honda"],
  ["toyota", "Toyota"],
  ["ford", "Ford"],
  ["kia", "Kia"],
  ["hyundai", "Hyundai"],
  ["nissan", "Nissan"],
  ["buick", "Buick"],
  ["gmc", "GMC"],
  ["cadillac", "Cadillac"],
  ["chrysler", "Chrysler"],
  ["dodge", "Dodge"],
  ["jeep", "Jeep"],
  ["ram", "Ram"],
  ["subaru", "Subaru"],
  ["mazda", "Mazda"],
  ["volkswagen", "Volkswagen"], ["vw", "Volkswagen"],
  ["volvo", "Volvo"],
  ["bmw", "BMW"],
  ["mercedesbenz", "Mercedes-Benz"], ["mercedes", "Mercedes-Benz"], ["benz", "Mercedes-Benz"],
  ["audi", "Audi"],
  ["lexus", "Lexus"],
  ["acura", "Acura"],
  ["infiniti", "Infiniti"],
  ["mitsubishi", "Mitsubishi"],
  ["genesis", "Genesis"],
  ["landrover", "Land Rover"],
  ["jaguar", "Jaguar"],
  ["porsche", "Porsche"],
  ["mini", "Mini"],
  ["fiat", "Fiat"],
  ["alfaromeo", "Alfa Romeo"],
  ["maserati", "Maserati"],
  ["bentley", "Bentley"],
  ["rollsroyce", "Rolls-Royce"],
  ["ferrari", "Ferrari"],
  ["lamborghini", "Lamborghini"],
  ["tesla", "Tesla"],
  ["lincoln", "Lincoln"],
  ["isuzu", "Isuzu"],
  ["scion", "Scion"],
  // Non-car franchises Vini also serves (confirmed real rooftop: John Elway
  // Harley-Davidson).
  ["harleydavidson", "Harley-Davidson"], ["harley", "Harley-Davidson"],
];

// Keywords short/ambiguous enough that a bare substring match against a
// concatenated hostname (no word boundaries) risks colliding with unrelated
// place names or English words (e.g. "ford" inside a "-ford"-suffixed town).
// These are still caught fine via the name-based exact-token path.
const URL_FALLBACK_MIN_LEN = 5;

// Industry-standard multi-brand acronyms used directly in dealer names (e.g.
// "Austin Ford CDJR", "Beaver County Dodge Chrysler Jeep Ram" already spells
// it out, but plenty of real rooftops just say "CDJR") — expands to all four
// Stellantis brands it stands for.
const COMPOUND_TOKENS = {
  cdjr: ["Chrysler", "Dodge", "Jeep", "Ram"],
  cjdr: ["Chrysler", "Dodge", "Jeep", "Ram"],
  dcjr: ["Chrysler", "Dodge", "Jeep", "Ram"],
};

// Manual corrections, keyed by team_id, for cases the heuristic gets wrong.
// Empty for v1 — add entries here if QA finds a real misclassification rather
// than building override infrastructure preemptively.
const OEM_OVERRIDES = {};

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalizeHost(url) {
  let s = String(url || "").trim();
  // ClickHouse stores some website_link values with literal embedded quotes
  // (e.g. `"https://www.paragonhonda.com/"`, length includes the quote chars) —
  // stripped along with everything else non-alphanumeric below.
  if (!s || s === "\\N" || s === "#N/A") return "";
  s = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return s;
}

function brandsFromName(name) {
  const tokens = new Set(tokenize(name));
  const found = new Set();
  for (const [kw, brand] of BRAND_KEYWORDS) {
    if (tokens.has(kw)) found.add(brand);
  }
  for (const token of tokens) {
    for (const brand of COMPOUND_TOKENS[token] ?? []) found.add(brand);
  }
  return found;
}

function brandsFromWebsite(websiteLink) {
  const host = normalizeHost(websiteLink);
  const found = new Set();
  if (!host) return found;
  for (const [kw, brand] of BRAND_KEYWORDS) {
    if (kw.length < URL_FALLBACK_MIN_LEN) continue;
    if (host.includes(kw)) found.add(brand);
  }
  return found;
}

// Returns a sorted string[] of matched brands (possibly multiple for
// multi-franchise rooftops), or [] when nothing could be classified.
export function classifyOemBrands(name, websiteLink, teamId) {
  if (teamId && OEM_OVERRIDES[teamId]) return OEM_OVERRIDES[teamId];
  const byName = brandsFromName(name);
  const found = byName.size > 0 ? byName : brandsFromWebsite(websiteLink);
  return Array.from(found).sort();
}

// Anchor-based SQL injection mirroring callbackAttribution.js's pattern: keeps
// the Metabase-synced agentBaseFact.sql pristine so re-syncs re-apply this
// automatically instead of silently losing a hand edit. Only adds a SELECT
// column — etd is already joined in the outer query, no new CTE/JOIN needed.
const SELECT_ANCHOR = "coalesce(nullIf(etd.dealer_name, ''), etd.team_name) AS rooftop_name,";
const SELECT_ADDITION = "etd.website_link AS dealer_website,\n    coalesce(nullIf(etd.dealer_name, ''), etd.team_name) AS rooftop_name,";

export function injectDealerWebsite(sql, label = "sql") {
  if (sql.includes("dealer_website")) return sql; // already applied
  if (!sql.includes(SELECT_ANCHOR)) {
    throw new Error(
      `[oemBrands] ${label}: missing rooftop_name SELECT anchor — upstream SQL changed, fix needs review`
    );
  }
  return sql.replace(SELECT_ANCHOR, SELECT_ADDITION);
}
