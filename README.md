# Eventbrite Scraper

A simple, automated Eventbrite event scraper powered by [Spidra](https://spidra.io). Extract event details, organizer information, and contact data from Eventbrite search results with ease.

## Features

- 🔍 **Paginated Search Scraping** - Automatically iterate through multiple search result pages
- 📅 **Event Details** - Extract event names, dates, and URLs
- 👤 **Organizer Info** - Get organizer names, follower counts, and total events
- 🌐 **Website Scraping** - Extracts contact info from organizer websites
- 📱 **Social Media** - Collects Facebook and other social links
- 📧 **Contact Enrichment** - Finds emails, phone numbers, and addresses
- 💾 **Auto-save** - Results saved incrementally to prevent data loss
- 📦 **Auto-archive** - Previous results automatically renamed with timestamp before new scrape

## How It Works

1. Takes a search URL + number of pages to scrape
2. Loops through paginated search results (page=1, page=2, etc.)
3. Extracts event URLs from each search page
4. Scrapes each event page for details + organizer link
5. Scrapes organizer page for contact info & social links
6. Scrapes organizer's external website for email/phone
7. (Optional) Falls back to Facebook for contact info
8. Saves everything to `output/events.json`

## Prerequisites

- Node.js 18+
- A [Spidra](https://spidra.io) API key

## Installation

```bash
# Clone or navigate to the project
cd eventbrite-scraper

# Install dependencies
npm install

# Create environment file
cp .env.example .env
```

## Configuration

Edit your `.env` file:

```env
# Required
SPIDRA_API_KEY=your_api_key_here
SPIDRA_BASE_URL=https://api.spidra.io/api

# Scraping options
SEARCH_URL=https://www.eventbrite.com/d/tx--houston/lecture/
TOTAL_PAGES=5
```

### Configuration Options

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SPIDRA_API_KEY` | Yes | Your Spidra API key | `sk_live_...` |
| `SPIDRA_BASE_URL` | Yes | Spidra API endpoint | `https://api.spidra.io/api` |
| `SEARCH_URL` | No | Eventbrite search URL to scrape | `https://www.eventbrite.com/d/ca--san-francisco/tech/` |
| `TOTAL_PAGES` | No | Number of search pages to scrape (default: 2) | `5` |

## Usage

```bash
# Run the scraper
npm run scrape

# Or build and run
npm run build
npm start
```

## Output

Results are saved to `output/events.json`. If a previous `events.json` exists, it's automatically archived with a timestamp:

```
output/
├── events.json                      # Current/latest scrape
├── events-2026-02-12T14-30-45.json  # Previous scrape
├── events-2026-02-11T10-15-30.json  # Older scrape
└── ...
```

### Data Structure

```json
[
  {
    "event_name": "Tech Meetup Houston",
    "event_url": "https://www.eventbrite.com/e/tech-meetup-houston-123456",
    "organizer_name": "Houston Tech Community",
    "organizer_url": "https://www.eventbrite.com/o/houston-tech-12345",
    "organizer_website": "https://houstontech.com",
    "email": "hello@houstontech.com",
    "phone": "(713) 555-0123",
    "address": "123 Main St, Houston, TX 77001",
    "facebook": "https://facebook.com/houstontech",
    "follower_count": 2450,
    "total_events": 156
  }
]
```

### Output Fields

| Field | Description |
|-------|-------------|
| `event_name` | Name of the event |
| `event_url` | Direct link to the event page |
| `organizer_name` | Name of the event organizer |
| `organizer_url` | Eventbrite organizer profile URL |
| `organizer_website` | External website of the organizer |
| `email` | Contact email (from website or Facebook) |
| `phone` | Phone number |
| `address` | Physical address |
| `facebook` | Facebook page URL |
| `follower_count` | Organizer's Eventbrite followers |
| `total_events` | Total events hosted by organizer |

## Project Structure

```
eventbrite-scraper/
├── src/
│   └── index.ts                     # Main scraper logic
├── output/
│   ├── events.json                  # Current/latest scrape
│   └── events-YYYY-MM-DDTHH-MM-SS.json  # Archived scrapes
├── package.json
├── tsconfig.json
└── .env                             # Configuration (create from .env.example)
```

## Tips

- **Rate Limiting**: The scraper includes built-in delays to avoid rate limiting
- **Incremental Saves**: Results are saved after each event, so you won't lose progress if interrupted
- **Proxy Support**: Uses Spidra's proxy feature for reliable scraping
- **Search URLs**: You can customize the `SEARCH_URL` to target specific locations or categories

### Example Search URLs

```bash
# Houston lectures
https://www.eventbrite.com/d/tx--houston/lecture/

# San Francisco tech events
https://www.eventbrite.com/d/ca--san-francisco/tech/

# New York business events
https://www.eventbrite.com/d/ny--new-york/business/

# Online events only
https://www.eventbrite.com/d/online/free/
```

## License

MIT

---

Built with [Spidra](https://spidra.io) - AI-powered web scraping made simple.
