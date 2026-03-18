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
  const jobRes = await fetch(`${BASE_URL}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ urls: [{ url }], prompt, output: "json", useProxy }),
  });

  if (!jobRes.ok) throw new Error(`API error: ${jobRes.status}`);
  const { jobId } = await jobRes.json();
  console.log(`    Job: ${jobId}`);

  while (true) {
    await sleep(2000);
    const statusRes = await fetch(`${BASE_URL}/scrape/${jobId}`, {
      headers: { "x-api-key": API_KEY },
    });
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

// ─── CSV Utilities ────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content.split("\n").filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h.trim(), values[i] ?? ""]));
  });
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

  // Load progress checkpoint so re-runs skip already-enriched rows
  const progress: Record<string, Record<string, string>> = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"))
    : {};

  let enriched = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const organizerUrl = col(row, "Eventbrite organizer url", "organizer_url", "organizer url").trim();

    if (!organizerUrl) {
      console.log(`[${i + 1}/${rows.length}] No organizer URL — skipping`);
      skipped++;
      continue;
    }

    if (progress[organizerUrl]) {
      Object.assign(row, progress[organizerUrl]);
      skipped++;
      continue;
    }

    console.log(`[${i + 1}/${rows.length}] ${organizerUrl}`);

    // Pull existing values from the CSV row so we don't overwrite data already present
    let website  = col(row, "Website", "website").trim();
    let email    = col(row, "email", "Email").trim();
    let phone    = col(row, "Phone", "phone").trim();
    let address  = col(row, "Street Address", "address").trim();
    let facebook = col(row, "Facebook Company Page", "facebook").trim();

    try {
      // Step A: Organizer page — find website and Facebook if not already in the CSV
      if (isEmpty(website)) {
        console.log(`  -> Organizer page`);
        const org = await scrape(organizerUrl, `
          Extract: website (external URL, not eventbrite.com), facebook (facebook.com URL), follower_count, total_events.
          Return as flat JSON. Use null for missing fields.
        `);
        if (org?.website) website = org.website;
        if (isEmpty(facebook) && org?.facebook) facebook = cleanFacebook(org.facebook);
      }

      // Step B: Website — fill in any missing contact fields
      if (!isEmpty(website) && (isEmpty(email) || isEmpty(phone) || isEmpty(address))) {
        console.log(`  -> Website: ${website}`);
        const contact = await scrape(website, `
          Extract contact info. Return EXACTLY this flat JSON:
          { "email": "...", "phone": "...", "address": "...", "facebook": "..." }
          Use null for any field not found. Do NOT nest the data.
        `) || {};
        if (isEmpty(email) && contact?.email)    email    = contact.email;
        if (isEmpty(phone) && contact?.phone)    phone    = contact.phone;
        if (isEmpty(address) && contact?.address) address = contact.address;
        if (isEmpty(facebook) && contact?.facebook) facebook = cleanFacebook(contact.facebook);
      }

      // Step C: Facebook — last resort for email/phone/address
      //   Uses a residential proxy to bypass Facebook's login wall.
      if (isEmpty(email) && !isEmpty(facebook)) {
        console.log(`  -> Facebook: ${facebook}`);
        const fb = await scrape(facebook, `
          Extract from About section. Return EXACTLY this flat JSON:
          { "email": "...", "phone": "...", "address": "..." }
          Use null for any field not found. Do NOT nest the data.
        `, true) || {};
        if (fb?.email)                    email   = fb.email;
        if (isEmpty(phone) && fb?.phone)  phone   = fb.phone;
        if (isEmpty(address) && fb?.address) address = fb.address;
      }

      // Write enriched fields back to the row and save progress checkpoint
      Object.assign(row, {
        Website:                website,
        email:                  email,
        Phone:                  phone,
        "Street Address":       address,
        "Facebook Company Page": facebook,
      });

      progress[organizerUrl] = { website, email, phone, address, facebook };
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

      console.log(`  Done: email=${email || "—"} phone=${phone || "—"}\n`);
      enriched++;
    } catch (err: any) {
      console.log(`  Error: ${err.message}\n`);
    }

    await sleep(1000);
  }

  // Write final output files
  const outputHeaders = [...new Set([...headers.map(h => h.trim()), "website", "email", "Phone", "Street Address", "Facebook Company Page"])];
  fs.writeFileSync(OUTPUT_CSV, toCSV(outputHeaders, rows));
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(rows, null, 2));

  console.log(`\nDone!`);
  console.log(`Enriched : ${enriched}`);
  console.log(`Skipped  : ${skipped}`);
  console.log(`CSV      : ${OUTPUT_CSV}`);
  console.log(`JSON     : ${OUTPUT_JSON}\n`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
