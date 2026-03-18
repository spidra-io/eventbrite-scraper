/**
 * Eventbrite Scraper
 *
 * Scrapes Eventbrite search results and enriches each event with organizer
 * contact details (email, phone, address, Facebook) by following a chain:
 *   Event page → Organizer page → Website → Facebook (if still no email)
 *
 * Usage:
 *   npm start
 *
 * Environment variables (.env):
 *   SPIDRA_API_KEY   — your Spidra API key (required)
 *   SEARCH_URL       — Eventbrite search URL to scrape (optional, see default below)
 *   PAGES            — pages to crawl, e.g. "1-5" or "1,3,7" (optional, default: "1-2")
 *   SKIP_DISCOVERY   — set to "true" to reuse cached URLs from a previous run (optional)
 *
 * Output:
 *   output/events.json — enriched event records, updated live as the run progresses
 */

import "dotenv/config";
import * as fs from "fs";

// ─── Configuration ────────────────────────────────────────────────────────────

const API_KEY    = process.env.SPIDRA_API_KEY || "";
const BASE_URL   = "https://api.spidra.io/api";
const SEARCH_URL = process.env.SEARCH_URL || "https://www.eventbrite.com/d/tx--houston/lecture/";
const PAGES      = parsePages(process.env.PAGES || "1-2");
const SKIP_DISCOVERY = process.env.SKIP_DISCOVERY === "true";

const URL_CACHE_FILE = "output/event-urls.json";
const OUTPUT_FILE    = "output/events.json";

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

/** Parses a page range string like "1-3,5,7-9" into a sorted array of numbers. */
function parsePages(input: string): number[] {
  const pages = new Set<number>();
  for (const part of input.trim().split(",").map(p => p.trim()).filter(Boolean)) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(n => parseInt(n.trim()));
      if (!isNaN(start) && !isNaN(end))
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++)
          if (i > 0) pages.add(i);
    } else {
      const num = parseInt(part);
      if (!isNaN(num) && num > 0) pages.add(num);
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

/** Returns a blank record for an event URL — used to pre-fill the output file. */
function emptyRecord(eventUrl: string) {
  return {
    event_name:       null,
    event_url:        eventUrl,
    organizer_name:   null,
    organizer_url:    null,
    organizer_website: null,
    email:            null,
    phone:            null,
    address:          null,
    facebook:         null,
    follower_count:   null,
    total_events:     null,
  };
}

/** Filters out Eventbrite's own Facebook page which appears on many organizer pages. */
function cleanFacebook(fb: string | null | undefined): string | null {
  if (!fb || fb.includes("facebook.com/Eventbrite")) return null;
  return fb;
}

function saveResults(results: any[]) {
  fs.mkdirSync("output", { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
}

function archiveIfExists(path: string) {
  if (fs.existsSync(path)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    fs.renameSync(path, path.replace(".json", `-${ts}.json`));
    console.log(`Archived previous results`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.error("Missing SPIDRA_API_KEY — add it to your .env file");
    process.exit(1);
  }

  console.log(`\nEventbrite Scraper\nSearch: ${SEARCH_URL}\nPages: ${PAGES.join(", ")} (${PAGES.length} total)\n`);
  archiveIfExists(OUTPUT_FILE);
  fs.mkdirSync("output", { recursive: true });

  // ── Step 1: Collect event URLs ───────────────────────────────────────────────
  //
  // Scrape each search results page and extract the individual event URLs (/e/...).
  // Results are cached to event-urls.json so you can set SKIP_DISCOVERY=true
  // on re-runs to go straight to enrichment without re-scraping the listings.

  let eventUrls: string[] = [];

  if (SKIP_DISCOVERY && fs.existsSync(URL_CACHE_FILE)) {
    eventUrls = JSON.parse(fs.readFileSync(URL_CACHE_FILE, "utf-8"));
    console.log(`Step 1: Loaded ${eventUrls.length} cached event URLs (SKIP_DISCOVERY=true)\n`);
  } else {
    console.log("Step 1: Collecting event URLs...\n");
    const eventUrlSet = new Set<string>();

    for (const page of PAGES) {
      const pageUrl = page === 1 ? SEARCH_URL : `${SEARCH_URL}?page=${page}`;
      console.log(`  Page ${page}: ${pageUrl}`);
      try {
        const result = await scrape(pageUrl, `
          Extract all event URLs from this Eventbrite search page.
          Return JSON: { "event_urls": ["https://www.eventbrite.com/e/...", ...] }
          Only include URLs containing /e/ (actual event pages).
        `);
        const urls: string[] = result?.event_urls || [];
        urls.filter(u => u?.includes("/e/")).forEach(u => eventUrlSet.add(u));
        console.log(`    Found ${urls.length} events\n`);
      } catch (err: any) {
        console.log(`    Error: ${err.message}\n`);
      }
      await sleep(1000);
    }

    eventUrls = Array.from(eventUrlSet);
    fs.writeFileSync(URL_CACHE_FILE, JSON.stringify(eventUrls, null, 2));
    console.log(`Total unique events: ${eventUrls.length} (cached to ${URL_CACHE_FILE})\n`);
  }

  if (eventUrls.length === 0) {
    console.log("No events found. Exiting.");
    process.exit(0);
  }

  // ── Step 2: Enrich each event ────────────────────────────────────────────────
  //
  // For each event, follow this chain to collect contact details:
  //
  //   Event page       → event name, organizer name, organizer URL
  //   Organizer page   → website, Facebook, follower count, total events
  //   Website          → email, phone, address, Facebook
  //   Facebook         → email, phone, address  (only if still no email; uses proxy)
  //
  // Each step only runs if the previous step returned the data needed to continue.
  // Results are written to events.json after each event so progress is never lost.

  console.log("Step 2: Enriching events...\n");

  const allResults: any[] = eventUrls.map(emptyRecord);
  saveResults(allResults); // write stubs so the file exists immediately

  // Caches to avoid re-scraping the same organizer page or website
  // across multiple events from the same organizer.
  const organizerCache = new Map<string, any>();
  const websiteCache   = new Map<string, any>();

  for (let i = 0; i < eventUrls.length; i++) {
    const eventUrl = eventUrls[i];
    console.log(`[${i + 1}/${eventUrls.length}] ${eventUrl}`);

    try {
      // 1. Event page — get event name and organizer link
      const event = await scrape(eventUrl, `
        Extract: event_name, organizer_name, organizer_url (the /o/... link)
      `);

      // 2. Organizer page — get website, Facebook, follower count
      let organizer: any = {};
      if (event?.organizer_url) {
        if (organizerCache.has(event.organizer_url)) {
          organizer = organizerCache.get(event.organizer_url);
          console.log(`  -> Organizer: ${event.organizer_url} (cached)`);
        } else {
          console.log(`  -> Organizer: ${event.organizer_url}`);
          try {
            organizer = await scrape(event.organizer_url, `
              Extract: organizer_name, website (external URL), facebook, follower_count, total_events
            `);
            organizerCache.set(event.organizer_url, organizer);
          } catch (err: any) {
            console.log(`    Organizer error: ${err.message}`);
          }
        }
      }

      // 3. Website — get contact details
      let websiteContact: any = {};
      if (organizer?.website) {
        if (websiteCache.has(organizer.website)) {
          websiteContact = websiteCache.get(organizer.website);
          console.log(`  -> Website: ${organizer.website} (cached)`);
        } else {
          console.log(`  -> Website: ${organizer.website}`);
          try {
            websiteContact = await scrape(organizer.website, `
              Extract contact info. Return EXACTLY this flat JSON:
              { "email": "...", "phone": "...", "address": "...", "facebook": "..." }
              Use null for any field not found. Do NOT nest the data.
            `) || {};
            websiteCache.set(organizer.website, websiteContact);
          } catch (err: any) {
            console.log(`    Website error: ${err.message}`);
          }
        }
      }

      // 4. Facebook — fallback for email/phone/address if still missing
      //    Prefers the Facebook URL found on the website; falls back to the one
      //    on the organizer page. Uses a residential proxy to bypass the login wall.
      const facebookUrl = cleanFacebook(websiteContact?.facebook) || cleanFacebook(organizer?.facebook);

      let facebookContact: any = {};
      if (facebookUrl && !websiteContact?.email) {
        console.log(`  -> Facebook: ${facebookUrl}`);
        try {
          facebookContact = await scrape(facebookUrl, `
            Extract from About section. Return EXACTLY this flat JSON:
            { "email": "...", "phone": "...", "address": "..." }
            Use null for any field not found. Do NOT nest the data.
          `, true) || {};
        } catch (err: any) {
          console.log(`    Facebook error: ${err.message}`);
        }
      }

      // Merge all collected data into the final record
      allResults[i] = {
        event_name:        event?.event_name || null,
        event_url:         eventUrl,
        organizer_name:    organizer?.organizer_name || event?.organizer_name || null,
        organizer_url:     event?.organizer_url || null,
        organizer_website: organizer?.website || null,
        email:             websiteContact?.email || facebookContact?.email || null,
        phone:             websiteContact?.phone || facebookContact?.phone || null,
        address:           websiteContact?.address || facebookContact?.address || null,
        facebook:          facebookUrl,
        follower_count:    organizer?.follower_count || null,
        total_events:      organizer?.total_events || null,
      };

      console.log(`  Done: ${allResults[i].event_name}\n`);
      saveResults(allResults);
    } catch (err: any) {
      console.log(`  Error: ${err.message}\n`);
    }

    await sleep(1000);
  }

  console.log(`Done! Scraped ${allResults.length} events.\nOutput: ${OUTPUT_FILE}\n`);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
