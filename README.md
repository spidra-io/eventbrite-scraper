# Eventbrite Scraper

This tool automatically finds events on Eventbrite and collects contact details for each organizer — including their email, phone number, address, and Facebook page.

It is powered by [Spidra](https://spidra.io), which handles all the web scraping behind the scenes.

---

## What it does

You give it an Eventbrite search URL and tell it how many pages to go through. It then works through each event on those pages and tries to find the organizer's contact details by following this chain:

1. **Event page** — finds the event name and a link to the organizer's profile
2. **Organizer profile** — finds their external website and Facebook page
3. **Website** — looks for an email, phone number, and address
4. **Facebook** — if no email was found on the website, it checks Facebook as a last resort

Results are saved to a file as it goes, so if it stops halfway through you won't lose what's already been collected.

---

## What you need

- **Node.js** installed on your computer
- A **Spidra API key** — you can get one at [spidra.io](https://spidra.io)

---

## Setup

**1. Install dependencies**

```bash
npm install
```

**2. Add your API key**

Open the `.env` file and fill in your Spidra API key:

```
SPIDRA_API_KEY=your_api_key_here
```

---

## Running the scraper

```bash
npm run scrape
```

By default it will scrape pages 1 and 2 of the Houston lectures search on Eventbrite.

**To change the search or pages**, set them when running the command:

```bash
# Scrape pages 1 to 5
PAGES=1-5 npm run scrape

# Use a different Eventbrite search URL
SEARCH_URL=https://www.eventbrite.com/d/ca--san-francisco/tech/ PAGES=1-3 npm run scrape

# Re-run enrichment without re-discovering events (faster)
SKIP_DISCOVERY=true npm run scrape
```

### Page selection examples

| What you type | What it scrapes |
|---------------|-----------------|
| `1-5`         | Pages 1, 2, 3, 4, 5 |
| `3,5,7`       | Pages 3, 5, and 7 only |
| `1-3,7,9-10`  | Pages 1–3, then 7, then 9–10 |

This is useful if you want to continue a previous run or retry specific pages.

---

## Output

Results are saved to `output/events.json`. Each record looks like this:

```json
{
  "event_name": "Tech Meetup Houston",
  "event_url": "https://www.eventbrite.com/e/...",
  "organizer_name": "Houston Tech Community",
  "organizer_url": "https://www.eventbrite.com/o/...",
  "organizer_website": "https://houstontech.com",
  "email": "hello@houstontech.com",
  "phone": "(713) 555-0123",
  "address": "123 Main St, Houston, TX 77001",
  "facebook": "https://facebook.com/houstontech",
  "follower_count": 2450,
  "total_events": 156
}
```

If a field couldn't be found, it will be `null`.

Each time you run the scraper, the previous `events.json` is automatically renamed with a timestamp so you never lose old results.

---

## CSV Enrichment (separate mode)

If you already have a CSV file of Eventbrite organizer URLs and just want to fill in the missing contact details, use the enrichment mode:

```bash
INPUT_CSV=your-file.csv npm run enrich
```

This reads your CSV, finds any rows with missing email, phone, address, or Facebook, and fills them in. It's safe to re-run — rows that were already enriched are skipped automatically.

Output is saved to `output/enriched.csv` and `output/enriched.json`.

---

Built with [Spidra](https://spidra.io).
