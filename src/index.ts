import "dotenv/config";
import * as fs from "fs";

// ============ CONFIG ============
const API_KEY = process.env.SPIDRA_API_KEY || "";
const BASE_URL = process.env.SPIDRA_BASE_URL || "";
const SEARCH_URL = process.env.SEARCH_URL || "https://www.eventbrite.com/d/tx--houston/lecture/";
const PAGES_INPUT = process.env.PAGES || "1-2";

// ============ PAGE PARSER ============
// Supports: "6" (just page 6), "1-5" (pages 1-5), "3,5,7" (specific pages), "1-3,7,9-10" (combined)
function parsePages(input: string): number[] {
  const pages = new Set<number>();
  const trimmed = input.trim();
  
  // Parse comma-separated parts
  const parts = trimmed.split(",").map(p => p.trim()).filter(Boolean);
  
  for (const part of parts) {
    if (part.includes("-")) {
      // Range: "3-7"
      const [start, end] = part.split("-").map(n => parseInt(n.trim()));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          if (i > 0) pages.add(i);
        }
      }
    } else {
      // Single page: "5" means just page 5
      const num = parseInt(part);
      if (!isNaN(num) && num > 0) pages.add(num);
    }
  }
  
  return Array.from(pages).sort((a, b) => a - b);
}

const PAGES = parsePages(PAGES_INPUT);

// ============ SPIDRA API ============
async function scrape(urls: string[], prompt: string): Promise<any> {
  // API allows max 3 URLs per request
  if (urls.length > 3) urls = urls.slice(0, 3);
  
  const jobRes = await fetch(`${BASE_URL}/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({
      urls: urls.map(url => ({ url })),
      prompt,
      output: "json",
      aiMode: true,
      useProxy: true,
      proxyCountry: "us",
    }),
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
    
    if (data.status === "completed") {
      const content = data.result?.content;
      return Array.isArray(content) ? content[0] : content;
    }
    if (data.status === "failed") throw new Error(data.error || "Job failed");
    console.log(`    Status: ${data.progress?.message || "processing..."}`);
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function archiveExistingResults() {
  const outputPath = "output/events.json";
  if (fs.existsSync(outputPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const archivePath = `output/events-${timestamp}.json`;
    fs.renameSync(outputPath, archivePath);
    console.log(`📦 Archived previous results to ${archivePath}`);
  }
}

async function main() {
  if (!API_KEY) {
    console.error("❌ Set SPIDRA_API_KEY in .env");
    process.exit(1);
  }

  console.log(`\n🕷️ Eventbrite Scraper\nSearch: ${SEARCH_URL}\nPages: ${PAGES.join(", ")} (${PAGES.length} total)\n`);

  // Archive existing results before starting new scrape
  archiveExistingResults();

  let allResults: any[] = [];
  
  // STEP 1: Get event URLs
  console.log("📄 Step 1: Getting event URLs...\n");
  const eventUrlSet = new Set<string>();
  
  for (const page of PAGES) {
    const pageUrl = page === 1 ? SEARCH_URL : `${SEARCH_URL}?page=${page}`;
    console.log(`  Page ${page}: ${pageUrl}`);
    try {
      const result = await scrape([pageUrl], `
        Extract all event URLs from this Eventbrite search page.
        Return JSON: { "event_urls": ["https://www.eventbrite.com/e/...", ...] }
        Only include URLs containing /e/ (actual event pages).
      `);
      const urls = result?.event_urls || [];
      urls.filter((u: string) => u?.includes("/e/")).forEach((u: string) => eventUrlSet.add(u));
      console.log(`    Found ${urls.length} events\n`);
    } catch (err: any) {
      console.log(`    Error: ${err.message}\n`);
    }
    await sleep(1000);
  }

  const eventUrls = Array.from(eventUrlSet);
  console.log(`✅ Total unique events: ${eventUrls.length}\n`);

  // STEP 2: Process each event
  console.log("📝 Step 2: Processing events...\n");

  for (let i = 0; i < eventUrls.length; i++) {
    const eventUrl = eventUrls[i];
    console.log(`[${i + 1}/${eventUrls.length}] ${eventUrl}`);

    try {
      const event = await scrape([eventUrl], `
        Extract: event_name, organizer_name, organizer_url (the /o/... link)
      `);
      
      let organizer: any = {};
      if (event?.organizer_url) {
        console.log(`  → Organizer: ${event.organizer_url}`);
        try {
          organizer = await scrape([event.organizer_url], `
            Extract: organizer_name, website (external URL), facebook, follower_count, total_events
          `);
        } catch (err: any) {
          console.log(`    Organizer error: ${err.message}`);
        }
      }

      let websiteContact: any = {};
      if (organizer?.website) {
        console.log(`  → Website: ${organizer.website}`);
        try {
          websiteContact = await scrape([organizer.website], `
            Extract contact info from this website. Return EXACTLY this flat JSON format:
            { "email": "...", "phone": "...", "address": "...", "facebook": "..." }
            - email: contact email address
            - phone: phone number
            - address: physical address
            - facebook: facebook URL from social media links
            Use null for any field not found. Do NOT nest the data.
          `) || {};
        } catch (err: any) {
          console.log(`    Website error: ${err.message}`);
        }
      }

      let facebookContact: any = {};
      // Only scrape Facebook if we didn't get email from website, and use the WEBSITE's facebook
      if (websiteContact?.facebook && !websiteContact?.email) {
        console.log(`  → Facebook: ${websiteContact.facebook}`);
        try {
          facebookContact = await scrape([websiteContact.facebook], `
            Extract from About section. Return EXACTLY this flat JSON format:
            { "email": "...", "phone": "...", "address": "..." }
            Use null for any field not found. Do NOT nest the data.
          `) || {};
        } catch (err: any) {
          console.log(`    Facebook error: ${err.message}`);
        }
      }

      // Filter out Eventbrite's own Facebook (useless)
      const cleanFacebook = (fb: string | null) => {
        if (!fb) return null;
        if (fb.includes("facebook.com/Eventbrite")) return null;
        return fb;
      };

      const record = {
        event_name: event?.event_name || "",
        event_url: eventUrl,
        organizer_name: organizer?.organizer_name || event?.organizer_name || "",
        organizer_url: event?.organizer_url || "",
        organizer_website: organizer?.website || null,
        email: websiteContact?.email || facebookContact?.email || null,
        phone: websiteContact?.phone || facebookContact?.phone || null,
        address: websiteContact?.address || facebookContact?.address || null,
        facebook: cleanFacebook(websiteContact?.facebook) || null,
        follower_count: organizer?.follower_count || 0,
        total_events: organizer?.total_events || 0,
      };

      allResults.push(record);
      console.log(`  ✓ Done: ${record.event_name}\n`);
      saveResults(allResults);
    } catch (err: any) {
      console.log(`  Error: ${err.message}\n`);
    }
    await sleep(1000);
  }

  console.log(`\n✅ Done! Scraped ${allResults.length} events.\n📁 Output: output/events.json\n`);
}

function saveResults(results: any[]) {
  fs.mkdirSync("output", { recursive: true });
  fs.writeFileSync("output/events.json", JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
