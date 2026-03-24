/**
 * CSV Enrichment Mode
 *
 * Takes a CSV of Eventbrite organizer URLs and fills in any missing contact
 * fields (website, email, phone, address, Facebook) using the Spidra API.
 *
 * Enrichment chain per row:
 *   Organizer page  → website, Facebook (if not already in CSV)
 *   Website         → email, phone, address, Facebook
 *   Facebook        → email, phone, address  (only if still no email; uses proxy)
 *
 * Usage:
 *   INPUT_CSV=organizers.csv npm run enrich
 *
 * Environment variables (.env):
 *   SPIDRA_API_KEY  — your Spidra API key (required)
 *   INPUT_CSV       — path to the input CSV file (required)
 *
 * Output:
 *   output/enriched.csv           — enriched version of the input CSV
 *   output/enriched.json          — same data as JSON
 *   output/enriched-progress.json — progress checkpoint (enables safe re-runs)
 *
 * Resume: safe to re-run — rows that were already enriched are skipped automatically.
 */

import "dotenv/config";
import * as fs from "fs";

// ─── Configuration ────────────────────────────────────────────────────────────

const API_KEY   = process.env.SPIDRA_API_KEY || "";
const BASE_URL  = "https://api.spidra.io/api";
const INPUT_CSV = process.env.INPUT_CSV || "";

const PROGRESS_FILE = "output/enriched-progress.json";
const OUTPUT_JSON   = "output/enriched.json";
const OUTPUT_CSV    = "output/enriched.csv";

// ─── Spidra API ───────────────────────────────────────────────────────────────

/**
 * Submits a scrape job to Spidra and waits for the result.
 * Pass useProxy = true for sites that block data-center IPs (e.g. Facebook).
 */
async function scrape(url: string, prompt: string, useProxy = false): Promise<any> {
  // Submit job with retry on 429
  let jobId: string | undefined;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const jobRes = await fetch(`${BASE_URL}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ urls: [{ url }], prompt, output: "json", useProxy }),
    });
    if (jobRes.status === 429) {
      const wait = attempt * 10000;
      console.log(`    Rate limited on submit — waiting ${wait / 1000}s (attempt ${attempt}/5)`);
      await sleep(wait);
      continue;
    }
    if (!jobRes.ok) throw new Error(`API error: ${jobRes.status}`);
    const body = await jobRes.json();
    jobId = body.jobId;
    break;
  }
  if (!jobId) throw new Error("Failed to submit job after 5 attempts (rate limited)");
  console.log(`    Job: ${jobId}`);

  // Poll for result
  while (true) {
    await sleep(2000);
    const statusRes = await fetch(`${BASE_URL}/scrape/${jobId}`, {
      headers: { "x-api-key": API_KEY },
    });
    if (!statusRes.ok) {
      if (statusRes.status === 429) { await sleep(5000); continue; }
      throw new Error(`Poll error: ${statusRes.status}`);
    }
    const data = await statusRes.json();
    if (data.status === "completed") return data.result?.content;
    if (data.status === "failed") throw new Error(data.error || "Job failed");
    console.log(`    Status: ${data.progress?.message || "processing..."}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function isEmpty(val: string | undefined): boolean {
  return !val || val.trim() === "" || val.trim() === "--";
}

/** Filters out Eventbrite's own Facebook page which appears on many organizer pages. */
function cleanFacebook(fb: string | null | undefined): string {
  if (!fb || fb.includes("facebook.com/Eventbrite")) return "";
  return fb;
}

/**
 * Follows HTTP redirects and returns the final destination URL.
 * Used to resolve shortlinks (bit.ly, tinyurl, etc.) before appending /contact or /about.
 */
async function resolveUrl(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    clearTimeout(timer);
    return res.url || url;
  } catch {
    return url;
  }
}

/**
 * After scraping the website root with no email found, tries /contact then /about.
 * Returns the first result that contains an email, or null if neither does.
 */
async function tryExtraContactPages(baseUrl: string): Promise<any> {
  const base = baseUrl.replace(/\/$/, "");
  for (const suffix of ["/contact", "/about"]) {
    const url = `${base}${suffix}`;
    console.log(`  -> Extra page: ${url}`);
    try {
      const result = await scrape(url, `
        Extract contact info. Return EXACTLY this flat JSON:
        { "email": "...", "phone": "...", "address": "...", "facebook": "..." }
        Use null for any field not found. Do NOT nest the data.
      `) || {};
      if (result?.email) return result;
    } catch {
      // page not found or scrape failed — try next
    }
  }
  return null;
}

// ─── CSV Utilities ────────────────────────────────────────────────────────────

function parseCSV(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const allRows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') { field += '"'; i++; } // escaped quote
      else inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      current.push(field); field = "";
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++; // skip \r\n
      current.push(field); field = "";
      if (current.some(f => f.trim())) allRows.push(current);
      current = [];
    } else {
      field += char;
    }
  }
  if (field || current.length) { current.push(field); if (current.some(f => f.trim())) allRows.push(current); }

  const headers = allRows[0]?.map(h => h.trim()) ?? [];
  const rows = allRows.slice(1).map(values =>
    Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()]))
  );
  return { headers, rows };
}

function toCSV(headers: string[], rows: Record<string, string>[]): string {
  const escape = (v: string) => (v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v);
  const headerLine = headers.map(escape).join(",");
  const dataLines = rows.map(row => headers.map(h => escape(row[h] ?? "")).join(","));
  return [headerLine, ...dataLines].join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) { console.error("Missing SPIDRA_API_KEY — add it to your .env file"); process.exit(1); }
  if (!INPUT_CSV) { console.error("Missing INPUT_CSV — run as: INPUT_CSV=file.csv npm run enrich"); process.exit(1); }
  if (!fs.existsSync(INPUT_CSV)) { console.error(`File not found: ${INPUT_CSV}`); process.exit(1); }

  fs.mkdirSync("output", { recursive: true });

  const { headers, rows } = parseCSV(fs.readFileSync(INPUT_CSV, "utf-8"));
  console.log(`\nCSV Enrichment\nInput : ${INPUT_CSV} (${rows.length} rows)\n`);

  // Helper to read a column by any of its possible names (case-insensitive)
  const col = (row: Record<string, string>, ...names: string[]): string => {
    for (const name of names) {
      const key = Object.keys(row).find(k => k.trim().toLowerCase() === name.toLowerCase());
      if (key !== undefined) return row[key] ?? "";
    }
    return "";
  };

  // Helper to write a value back to whichever column name actually exists in the row.
  // Falls back to the first name if none exist yet (adds as new column).
  const writeCol = (row: Record<string, string>, value: string, ...names: string[]) => {
    for (const name of names) {
      const key = Object.keys(row).find(k => k.trim().toLowerCase() === name.toLowerCase());
      if (key !== undefined) { row[key] = value; return; }
    }
    if (value) row[names[0]] = value;
  };

  // Load progress checkpoint — supports keyed object and array (compiled.json) formats
  const rawProgress: any = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"))
    : {};

  const progress: Record<string, Record<string, string>> = Array.isArray(rawProgress)
    ? Object.fromEntries(
        rawProgress
          .filter((e: any) => e["Eventbrite Organizer Website"])
          .map((e: any) => [e["Eventbrite Organizer Website"].trim(), e])
      )
    : rawProgress;

  let enriched = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const organizerUrl = col(row, "Eventbrite Organizer Website", "Eventbrite organizer url", "organizer_url", "organizer url").trim();

    if (!organizerUrl) {
      console.log(`[${i + 1}/${rows.length}] No organizer URL — skipping`);
      skipped++;
      continue;
    }

    // Pull existing values from the CSV row so we don't overwrite data already present
    let website       = col(row, "Website URL", "Website", "website").trim();
    let email         = col(row, "email", "Email").trim();
    let phone         = col(row, "Phone Number", "Phone", "phone").trim();
    let address       = col(row, "Street Address", "address").trim();
    let facebook      = col(row, "Facebook Company Page", "facebook").trim();
    let description   = col(row, "Description", "description").trim();
    let city          = col(row, "City", "city").trim();
    let country       = col(row, "Country/Region", "Country", "country").trim();
    let followerCount = col(row, "Eventbrite followers", "follower_count").trim();
    let totalEvents   = col(row, "total_events", "Total Events").trim();
    let twitter       = col(row, "Twitter Handle", "twitter").trim();

    // Skip if already in progress checkpoint
    if (progress[organizerUrl]) {
      const p = progress[organizerUrl];
      if ("website" in p || "phone" in p) {
        // Old format: internal field names — map to correct HubSpot columns
        writeCol(row, p.website       || "", "Website URL", "Website");
        writeCol(row, p.email         || "", "email", "Email");
        writeCol(row, p.phone         || "", "Phone Number", "Phone");
        writeCol(row, p.address       || "", "Street Address", "address");
        writeCol(row, p.facebook      || "", "Facebook Company Page", "facebook");
        writeCol(row, p.description   || "", "Description", "description");
        writeCol(row, p.city          || "", "City", "city");
        writeCol(row, p.country       || "", "Country/Region", "Country");
        writeCol(row, p.follower_count|| "", "Eventbrite followers", "follower_count");
        writeCol(row, p.total_events  || "", "total_events", "Total Events");
        writeCol(row, p.twitter       || "", "Twitter Handle", "twitter");
      } else {
        // New format: full row with HubSpot field names
        Object.assign(row, p);
      }
      skipped++;
      continue;
    }

    console.log(`[${i + 1}/${rows.length}] ${organizerUrl}`);

    // Step A: Organizer page — find website, Facebook, follower_count, total_events, twitter
    try {
      if (isEmpty(website) || isEmpty(followerCount) || isEmpty(totalEvents) || isEmpty(twitter)) {
        console.log(`  -> Organizer page`);
        const org = await scrape(organizerUrl, `
          Extract: website (external URL, not eventbrite.com), facebook (facebook.com URL),
          twitter (twitter.com or x.com URL or handle), follower_count (number), total_events (number).
          Return as flat JSON. Use null for missing fields.
        `);
        if (isEmpty(website)       && org?.website)                website       = org.website;
        if (isEmpty(facebook)      && org?.facebook)               facebook      = cleanFacebook(org.facebook);
        const rawFc = org?.follower_count ?? org?.followers ?? null;
        const rawTe = org?.total_events  ?? org?.event_count ?? org?.events_count ?? null;
        if (isEmpty(followerCount) && rawFc != null) followerCount = String(rawFc);
        if (isEmpty(totalEvents)   && rawTe != null) totalEvents   = String(rawTe);
        if (isEmpty(twitter)       && org?.twitter)                twitter       = org.twitter;
      }
    } catch (err: any) {
      console.log(`  Step A error: ${err.message}`);
    }

    // Step B: Website — fill in any missing contact fields
    try {
      if (!isEmpty(website) && (isEmpty(email) || isEmpty(phone) || isEmpty(address))) {
        console.log(`  -> Website: ${website}`);
        const contact = await scrape(website, `
          Extract contact info. Return EXACTLY this flat JSON:
          { "email": "...", "phone": "...", "address": "...", "facebook": "..." }
          Use null for any field not found. Do NOT nest the data.
        `) || {};
        if (isEmpty(email) && contact?.email)       email    = contact.email;
        if (isEmpty(phone) && contact?.phone)       phone    = contact.phone;
        if (isEmpty(address) && contact?.address)   address  = contact.address;
        if (isEmpty(facebook) && contact?.facebook) facebook = cleanFacebook(contact.facebook);
      }

      // Step B2: /contact and /about pages — only if website returned no email
      if (!isEmpty(website) && isEmpty(email)) {
        const resolvedWebsite = await resolveUrl(website);
        const extraContact = await tryExtraContactPages(resolvedWebsite);
        if (extraContact) {
          if (isEmpty(email)    && extraContact?.email)    email    = extraContact.email;
          if (isEmpty(phone)    && extraContact?.phone)    phone    = extraContact.phone;
          if (isEmpty(address)  && extraContact?.address)  address  = extraContact.address;
          if (isEmpty(facebook) && extraContact?.facebook) facebook = cleanFacebook(extraContact.facebook);
        }
      }
    } catch (err: any) {
      console.log(`  Step B error: ${err.message}`);
    }

    // Step C: Facebook — fills any still-missing fields using a residential proxy.
    try {
      const needsFacebook = !isEmpty(facebook) && (
        isEmpty(email) || isEmpty(phone) || isEmpty(address) ||
        isEmpty(description) || isEmpty(city) || isEmpty(country)
      );
      if (needsFacebook) {
        console.log(`  -> Facebook: ${facebook}`);
        const fb = await scrape(facebook, `
          Extract from the About/Intro section of this Facebook page.
          Return EXACTLY this flat JSON:
          {
            "email": "...",
            "phone": "...",
            "address": "...",
            "description": "...",
            "city": "...",
            "country": "...",
            "website": "..."
          }
          Use null for any field not found. Do NOT nest the data.
          "description" = the page intro or about text.
          "city" = city name only.
          "country" = country name only.
          "address" = full street address.
        `, true) || {};
        if (isEmpty(email)       && fb?.email)       email       = fb.email;
        if (isEmpty(phone)       && fb?.phone)       phone       = fb.phone;
        if (isEmpty(address)     && fb?.address)     address     = fb.address;
        if (isEmpty(description) && fb?.description) description = fb.description;
        if (isEmpty(city)        && fb?.city)        city        = fb.city;
        if (isEmpty(country)     && fb?.country)     country     = fb.country;
        if (isEmpty(website)     && fb?.website)     website     = fb.website;
      }
    } catch (err: any) {
      console.log(`  Step C error: ${err.message}`);
    }

    // Write enriched fields back to the row and save progress regardless of step errors
    writeCol(row, website,       "Website URL", "Website");
    writeCol(row, email,         "email", "Email");
    writeCol(row, phone,         "Phone Number", "Phone");
    writeCol(row, address,       "Street Address", "address");
    writeCol(row, facebook,      "Facebook Company Page", "facebook");
    writeCol(row, description,   "Description", "description");
    writeCol(row, city,          "City", "city");
    writeCol(row, country,       "Country/Region", "Country");
    writeCol(row, followerCount, "Eventbrite followers", "follower_count");
    writeCol(row, totalEvents,   "total_events", "Total Events");
    writeCol(row, twitter,       "Twitter Handle", "twitter");

    progress[organizerUrl] = { ...row };
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

    console.log(`  Done: email=${email || "—"} phone=${phone || "—"} city=${city || "—"}\n`);
    enriched++;

    await sleep(1000);
  }

  // Write final output files
  // Ensure organizer-derived columns are present even if not in the original CSV
  const outputHeaders = [...new Set([...headers.map(h => h.trim()), "Eventbrite followers", "total_events", "Twitter Handle"])];
  fs.writeFileSync(OUTPUT_CSV, toCSV(outputHeaders, rows));
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(rows, null, 2));

  // ── Enrichment stats ─────────────────────────────────────────────────────────

  const allProgress = Object.values(progress);
  const total = allProgress.length;
  const uniqueOrganizers = new Set(
    rows.map(r => col(r, "Eventbrite Organizer Website", "Eventbrite organizer url", "organizer_url", "organizer url").trim()).filter(Boolean)
  ).size;
  // Each field mapped as [possible keys (new + old format), display label]
  const fields: [string[], string][] = [
    [["Website URL", "website"],                "Website URL"],
    [["email"],                                 "Email"],
    [["Phone Number", "phone"],                 "Phone"],
    [["Street Address", "address"],             "Address"],
    [["Facebook Company Page", "facebook"],     "Facebook"],
    [["Description", "description"],            "Description"],
    [["City", "city"],                          "City"],
    [["Country/Region", "country"],             "Country"],
    [["Eventbrite followers", "follower_count"],"Follower Count"],
    [["total_events"],                          "Total Events"],
    [["Twitter Handle", "twitter"],             "Twitter"],
  ];

  const pct = (n: number) => total ? `${Math.round((n / total) * 100)}%` : "0%";
  const hasValue = (v: any) => v && String(v).trim() !== "" && String(v).trim() !== "null";

  console.log(`\n${"─".repeat(45)}`);
  console.log(`  Enrichment Summary`);
  console.log(`${"─".repeat(45)}`);
  console.log(`  Total scraped  : ${total}`);
  console.log(`  Enriched now   : ${enriched}`);
  console.log(`  Skipped        : ${skipped}`);
  console.log(`  Remaining      : ${uniqueOrganizers - total}`);
  console.log(`${"─".repeat(45)}`);
  console.log(`  Field               Filled    Rate`);
  console.log(`${"─".repeat(45)}`);
  for (const [keys, label] of fields) {
    const count = allProgress.filter((p: any) => keys.some(k => hasValue(p[k]))).length;
    console.log(`  ${label.padEnd(20)}${String(count).padEnd(10)}${pct(count)}`);
  }
  console.log(`${"─".repeat(45)}\n`);

  console.log(`CSV  : ${OUTPUT_CSV}`);
  console.log(`JSON : ${OUTPUT_JSON}\n`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
