# Object Lesson -- Complete Project Documentation

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [File Structure](#3-file-structure)
4. [Features -- Storefront](#4-features--storefront)
5. [Admin Panel](#5-admin-panel)
6. [Cloudflare Worker](#6-cloudflare-worker)
7. [Inventory Schema](#7-inventory-schema)
8. [Deployment](#8-deployment)
9. [External Services](#9-external-services)
10. [Styling and Design System](#10-styling-and-design-system)
11. [Git History Summary](#11-git-history-summary)
12. [Known Issues and Future Work](#12-known-issues-and-future-work)

---

## 1. Project Overview

**Object Lesson** is an online storefront and inventory management system for a vintage, antique, and art dealer shop run by **Eli Kagan and Megan Gage**, located at the **Pasadena Antique Center** (480 S. Fair Oaks Ave, Pasadena, CA 91105).

- **Live URL:** https://objectlesson.la/
- **Tagline:** "Uncommon Objects, Art and Design"
- **Repository:** https://github.com/elikagan/objectlesson-site
- **Contact:** eli@objectlesson.la / SMS: 310-498-5138
- **Instagram:** @objectlesson_la

The project consists of three main parts:

1. **Public storefront** -- A single-page app (SPA) served from GitHub Pages that displays inventory with a mosaic hero, product grid, detail views, and integrated Square Checkout.
2. **Admin panel** -- A separate SPA (also on GitHub Pages at `/admin/`) that acts as a mobile-first PWA for managing inventory, with AI-powered image processing via Gemini.
3. **Cloudflare Worker** -- A serverless backend (`ol-checkout.objectlesson.workers.dev`) that handles Square Checkout link creation, gift certificate checkout, payment webhooks, auto-marking items as sold, email sending via Resend, and buyer email capture.

---

## 2. Architecture

### Single-Page App (Hash Routing)

Both the storefront and admin panel are single-page applications using hash-based routing. No build step is required for development -- files are served directly.

**Storefront routes:**
| Hash | View | Description |
|------|------|-------------|
| (empty) | `view-grid` | Product grid with mosaic hero |
| `#about` | `view-about` | About/visit page |
| `#{itemId}` | `view-detail` | Product detail with carousel |
| (invalid id) | `view-notfound` | "Item no longer available" |

**Admin routes:**
| Hash | View | Description |
|------|------|-------------|
| (none) | `view-lock` | PIN lock screen |
| (after unlock) | `view-list` | Inventory list |
| `#analytics` | `view-analytics` | Analytics dashboard |
| `#marketing` | `view-marketing` | Email subscribers and discount codes |
| `#giftcerts` | `view-giftcerts` | Gift certificate management |

### Data Flow

```
inventory.json (GitHub repo)
        |
        |-- Public site fetches from GitHub raw (instant updates)
        |   with fallback to local inventory.json
        |
        |-- Admin panel reads/writes via GitHub API
        |   (using personal access token stored in IndexedDB)
        |
        |-- Cloudflare Worker reads/writes via GitHub API
            (for auto-marking items sold on payment)

Supabase (PostgreSQL)
        |
        |-- events table: analytics (page views, item views, inquiries)
        |-- emails table: subscriber emails
        |-- discount_codes table: promo codes

Square API
        |
        |-- Payment links created by Cloudflare Worker
        |-- Webhooks notify Worker of completed payments

Resend API
        |
        |-- Gift certificate confirmation emails
        |-- Sends from gift@objectlesson.la
        |-- Domain verified via DKIM/SPF/DMARC on Porkbun DNS
```

---

## 3. File Structure

```
Object Lesson App and Website/
|
|-- index.html              Main storefront HTML (216 lines)
|-- app.js                  Storefront JavaScript (893 lines)
|-- style.css               Storefront CSS (1090 lines)
|-- inventory.json           Product data (16 items)
|-- OL_logo.svg             Object Lesson logo (SVG, reads "OBJECT LESSON")
|-- Asset 1.png             OG image for social sharing
|-- CNAME                   Custom domain: objectlesson.la
|-- .gitignore              Ignores .DS_Store, .claude/
|-- build.sh                Minification script (terser + csso)
|-- mosaic-proto.html       Standalone mosaic prototype (development artifact)
|
|-- images/
|   |-- products/
|       |-- 000001/         Calder Print images (0.jpg - 3.jpg)
|       |-- 000002/         Cicely Debeers Abstract
|       |-- 000003/         Studio Pot
|       |-- ...             (21 product directories total)
|       |-- mm3pl1ta/       Ceramic Studio Vase
|
|-- admin/
|   |-- index.html          Admin panel HTML (243 lines)
|   |-- app.js              Admin panel JavaScript (1584 lines)
|   |-- style.css           Admin panel CSS (1131 lines)
|   |-- sw.js               Service worker for offline caching (v24)
|   |-- manifest.json       PWA manifest
|   |-- config.enc          Encrypted API keys (AES-GCM, decrypted with PIN)
|
|-- gift/
|   |-- index.html          Gift certificate purchase page
|
|-- worker/
|   |-- square-checkout.js  Cloudflare Worker source
|
|-- .claude/
    |-- launch.json         Dev server config (Ruby HTTP, port 8090)
```

---

## 4. Features -- Storefront

### 4.1 Mosaic Hero

A 6x3 grid of animated, flipping tiles at the top of the main page. Each tile is a product image that periodically flips (3D rotateY) to reveal a different product.

- **18 cells** total (6 columns on desktop)
- Responsive: 4 columns/12 cells on tablet (max-width 959px), 2 columns/6 cells on mobile (max-width 559px)
- Flips every **1 second**, with **4-5 tiles** flipping simultaneously on desktop, **2-3** on mobile
- Flip animation duration: **700ms** (cubic-bezier easing)
- Each tile links to its product's detail page
- Mosaic pauses when navigating to detail view or when browser tab is hidden
- Only shows items that are not sold and have images
- Requires at least 4 items to display

### 4.2 Product Grid

A responsive grid of product cards below the mosaic.

- **2 columns** on mobile, **2 columns** on small tablets (560px+), **3 columns** on desktop (960px+)
- Cards fade up with staggered animation (0.04s delay per card)
- Each card shows: hero image, title, price
- Sold items pushed to bottom of "All" view, shown at 45% opacity
- Non-sold category filters exclude sold items entirely
- Hover effect: subtle 1.03x image scale

### 4.3 Category Filters

A dropdown filter below the mosaic, triggered by a pill button with a sliders icon.

**Categories:**
| Value | Label |
|-------|-------|
| `all` | All (default) |
| `under-400` | Under $400 (price filter, excludes sold) |
| `wall-art` | Wall Art |
| `object` | Object |
| `ceramic` | Ceramic |
| `furniture` | Furniture |
| `light` | Light |
| `sculpture` | Sculpture |
| `misc` | Misc |

In "All" mode, sold items are pushed to the end. In all other modes, sold items are excluded.

### 4.4 Detail View with Image Carousel

When a product card or mosaic tile is clicked, the detail view shows:

- **Sticky header** with back button, logo (blurred glass background)
- **Scroll hint** -- animated bouncing chevron at bottom, disappears after 50px scroll
- **Image carousel** with touch swipe support:
  - Real-time finger-following drag (translateX)
  - Direction locking (horizontal vs vertical)
  - Edge resistance (0.3x at boundaries)
  - 20% width threshold to advance slides
  - Smooth animated snap-back via CSS transition
- **Thumbnail strip** below carousel for multi-image items (scrollable, 64x64px)
- **Product info**: title, price, tax (10.25%), total, size, description
- **Badges**: New (black border), Sold (gray), On Hold (dark gold #b8860b)
- **Action buttons**: Buy Now, Inquire, Share
- **Discount code input** (on purchasable items)
- **Email gate** (required before first checkout)
- **Post-purchase thank you** card (after Square redirect)
- **Shipping note**: "Free pickup in Pasadena. LA delivery available."
- **Item ID** displayed as A-prefixed 6-digit number (e.g., A000015)

### 4.5 Square Checkout Integration

The "Buy Now" flow:

1. User clicks "Buy Now"
2. If user has not previously provided email (`ol_email_collected` not in localStorage), an **email gate** appears
3. Email is captured to Supabase `emails` table (source: "purchase")
4. POST request sent to Cloudflare Worker at `https://ol-checkout.objectlesson.workers.dev/checkout`
5. Worker creates a Square payment link with:
   - Item title and price
   - 10.25% CA sales tax
   - Optional discount (validated server-side)
   - Redirect URL: `https://objectlesson.la/?purchased=1#{itemId}`
   - Shipping address collection enabled
6. User is redirected to Square Checkout
7. After payment, Square redirects back; the `?purchased=1` parameter triggers the thank-you card

### 4.6 Email Gate Before Purchase

- Blocking step shown before Square checkout for first-time buyers
- Email sent to Supabase `emails` table with source "purchase"
- Sets `ol_email_collected` and `ol_email_dismissed` in localStorage
- Subsequent purchases skip the gate
- Input validates email format with HTML5 validation

### 4.7 Discount Codes (Supabase-Backed)

- Input field on the detail page (above Buy Now, gray background)
- Codes are validated against the Supabase `discount_codes` table
- Validates: code exists, is active, has not exceeded max uses
- Supports two types: `percent` (e.g., 10% off) and `fixed` (e.g., $50 off)
- When applied:
  - Original price gets strikethrough styling
  - Discounted price shown in green (#2d7d46)
  - Green badge shows code name and discount (e.g., "WELCOME10 -- 10% off")
  - Tax and total recalculated
  - Remove button (x) to clear discount
- Discount code is sent to the Cloudflare Worker for server-side validation and application on the Square order
- Worker increments `used_count` in Supabase after successful checkout

### 4.8 Email Capture Bar (10% Off WELCOME10)

- Fixed black bar at bottom of screen
- Shows on first visit if `ol_email_dismissed` is not set in localStorage
- Offers "Get 10% off your first purchase"
- On submit: captures email to Supabase `emails` table (source: "newsletter", discount_code: "WELCOME10")
- Shows success state with code "WELCOME10" for 6 seconds then auto-hides
- Close button dismisses permanently (sets `ol_email_dismissed`)
- Does not show when returning from a purchase (`?purchased` parameter)
- Slide-up animation (translateY, 350ms cubic-bezier)

### 4.9 Share Functionality

- Share button (upload icon) on detail view
- On mobile (Web Share API supported): uses native share sheet with title, price, and URL
- On desktop (no Web Share API): copies URL to clipboard, button shows "copied" state for 1.5s
- Tracked as analytics event

### 4.10 Analytics (Supabase Events Table)

Events tracked from the storefront:

| Event | When | Item ID |
|-------|------|---------|
| `page_view` | Page load | null |
| `item_view` | Detail page opened | Item ID |
| `inquire` | Inquire link clicked | Item ID |
| `buy_now` | Buy Now button clicked | Item ID |
| `filter` | Category filter changed | null |
| `email_signup` | Email bar form submitted | null |
| `discount_applied` | Discount code applied | Item ID |

Each event includes: session_id (random, per-session), referrer, utm_source, ua_mobile (boolean), path (current hash).

Bot/crawler traffic is excluded via user-agent check.

### 4.11 Sold / Hold / New Badges

- **New**: White background on card grid, black border outline on detail page. Not shown on sold/hold items.
- **Sold**: White background with gray text on card grid (card itself at 45% opacity). Gray border on detail. Hides Buy Now, discount, shipping, and shows only Sold badge.
- **On Hold**: White background with dark gold (#b8860b) text on card grid. Gold border on detail. Hides Buy Now, shows Inquire button.

### 4.12 SMS Inquire (Mobile) / Email (Desktop)

The "Inquire" link dynamically generates:
- **Mobile** (iPhone/iPad/Android detected via user agent): `sms:3104985138&body=...`
- **Desktop**: `mailto:eli@objectlesson.la?subject=Inquiry: {title}&body=...`

Pre-filled message: "Hi, I'm interested in {title} for ${price}. (item {id})"

### 4.13 Post-Purchase Thank You Flow

When returning from Square with `?purchased=1#{itemId}`:
1. The `?purchased` query parameter is detected on load
2. URL is cleaned (query removed, hash preserved)
3. Detail view opens with Sold badge shown
4. Thank-you card displayed with:
   - "Thank you for your purchase!"
   - Pickup info at Pasadena Antique Center
   - SMS link to arrange other pickup/shipping

### 4.14 Header Layout

The header uses a three-column flex layout with `justify-content: space-between`:
- **Left:** Two icon buttons (house icon for Visit/About, gift box icon for Gift Certificates) in a `header-side` div with `flex: 1`
- **Center:** Object Lesson logo (linked to homepage)
- **Right:** Instagram icon in a `header-side` div with `flex: 1` and `justify-content: flex-end`

Both side divs use `flex: 1` to ensure they take equal width, keeping the logo perfectly centered on all screen sizes. Icons are circular pill buttons (`.header-icon` class) matching the `.ig-pill` style.

### 4.15 About/Visit Page

Accessible via the house icon in the header. Shows:
- Tagline: "Uncommon Objects, Art and Design"
- Founders: "Eli Kagan & Megan Gage"
- Address (linked to Google Maps): 480 S. Fair Oaks Ave, Pasadena, CA 91105
- Context: "In the Pasadena Antique Center"
- Email and Instagram links

### 4.16 Not Found View

When a hash points to a non-existent item ID, shows:
- "This item is no longer available."
- "Browse all items" link

### 4.17 Gift Certificate Purchase Page

**URL:** `/gift/` (standalone page: `gift/index.html`)

A customer-facing page where visitors can purchase gift certificates.

**Marketing Copy:** "Give the gift of something unexpected. Object Lesson gift certificates can be used online or in-store at our Pasadena shop -- and they never expire."

**Purchase Form:**
- Custom dollar amount input ($1 - $10,000)
- Email address (required) -- used for Square checkout pre-fill and confirmation email
- Optional "To" (recipient name) and "From" (purchaser name) fields
- "Purchase Gift Certificate" button -> POST to worker `/gift-checkout` endpoint
- Redirects to Square Checkout (no sales tax, no shipping address, buyer email pre-filled)

**After Payment:**
- Square redirects back to `/gift/?purchased=1&code=GIFT-XXXX-XXXX`
- Confirmation view shows the gift certificate code prominently
- Code is selectable and has tap-to-copy functionality
- Share buttons: Email (mailto:), Text (sms:), Share (native Web Share API on mobile)
- Instructions: use at checkout on objectlesson.la or in-store, never expires
- "Continue Shopping" button links back to homepage
- **Confirmation email sent automatically** via Resend from `gift@objectlesson.la` with:
  - Styled HTML email matching site aesthetic (Helvetica Neue)
  - Gift code displayed prominently in bordered box
  - Dollar amount
  - To/From names if provided
  - Usage instructions (online + in-store, no expiration)

**Navigation:**
- House icon (visit) and gift box icon in homepage header (icon-only circular buttons)
- Both sides of header use `flex: 1` to keep logo perfectly centered
- "Back to shop" link on the gift page
- Discount input placeholder on main site reads "Discount or gift certificate code"

**Analytics:**
- `page_view` event tracked on page load
- `gift_purchase` event tracked on buy button click
- Events sent to Supabase `events` table with path `/gift/`

**How redemption works:**
- Gift certificate codes (`GIFT-XXXX-XXXX`) are stored in the `discount_codes` table with `is_gift_certificate: true`, `type: fixed`, `max_uses: 1`
- Customers enter the code in the discount input on any product detail page
- The existing discount code validation and application flow handles it -- no special case needed
- One-time use: after checkout, `used_count` is incremented and the code becomes invalid
- If a used code is entered, the discount silently does not apply (code not found in active codes query)

### 4.18 Inventory Loading

1. Fetches from GitHub raw URL with cache-bust timestamp: `https://raw.githubusercontent.com/elikagan/objectlesson-site/main/inventory.json?t={timestamp}`
2. Falls back to local `inventory.json?t={timestamp}` if raw fetch fails
3. Items sorted by `order` field
4. Loading indicator: pulsing dot animation

---

## 5. Admin Panel

### 5.1 Overview

The admin panel is a mobile-first Progressive Web App (PWA) at `/admin/`. It is designed to be used from a phone, added to the home screen via the PWA manifest.

### 5.2 Authentication

- **PIN lock screen**: 4+ digit PIN hashed with SHA-256
- PIN hash: `7f6257b880b51353e620ab9224907e72348e8d2c3c1f6e0ba9866661acbc05e9`
- **Rate limiting**: 5 attempts, then 5-minute lockout
- Unlock state persisted in IndexedDB (`ol_unlocked`)
- Supports browser password autofill (hidden username field)

### 5.3 Key Storage

API keys are stored in **IndexedDB** (database: `ol_admin`, object store: `kv`). Keys stored:
- `ol_gh_token` -- GitHub personal access token
- `ol_gemini_key` -- Google Gemini API key
- `ol_supa_url` -- Supabase project URL
- `ol_supa_key` -- Supabase service key

Additionally, keys are encrypted and backed up to the repo at `admin/config.enc`:
- Encrypted with **AES-GCM** (256-bit key derived from PIN via PBKDF2, 100,000 iterations, SHA-256)
- Salt (16 bytes) and IV (12 bytes) prepended to ciphertext
- Prefixed with 'A' and base64-encoded
- Fallback XOR cipher for environments without crypto.subtle

This allows the admin to work on a new device by entering just the PIN, which decrypts the config.enc file from the repo.

### 5.4 Setup Screen

First-time or settings configuration:
- GitHub Token (required)
- Gemini API Key (required)
- Supabase URL (optional)
- Supabase Service Key (optional)

Accessible from hamburger menu as "Settings" (shows as back-navigable screen without logo/intro text).

### 5.5 Item List

- Shows all items sorted by order, with active items on top and sold items in a collapsible "Archive" section
- Each row displays: drag handle, thumbnail (52x52), title, ID (A-format), price, badge (New/Hold/Sold), category pill
- **Drag-to-reorder**: Uses SortableJS library. Reorder saves immediately via GitHub API. Only active items can be reordered; archive section is excluded.
- **Swipe-to-reveal delete**: Horizontal touch swipe reveals a red delete button behind the row. Threshold: 70px. Closing gesture if swipe < 35px.
- **Floating Action Button (FAB)**: Black circle in bottom-right corner to add new items.

### 5.6 Item Editor

Full-screen editor for creating and editing items:

**Photo Management:**
- "Add Photos" button (opens file picker, multiple images)
- Photo grid: 3 columns, drag-to-reorder via SortableJS
- First photo marked as hero (white dot indicator)
- Each photo has a remove (x) button
- Unprocessed photos have an AI toggle button (star icon)
- Uses blob URLs for display (avoids embedding megabytes of base64 in DOM)

**AI Processing (Gemini API):**
- "Process with AI" button triggers multi-step pipeline:
  1. **Price tag detection**: Sends all photo thumbnails (512px) to Gemini 2.5 Flash asking which image is a price tag (returns index or -1)
  2. **OCR on price tag**: Sends detected tag image (1024px) to Gemini, extracts price, dealer code, and item name. Auto-fills fields. Removes tag photo from product photos.
  3. **Background removal**: Sends each unprocessed product photo (1536px) to Gemini 2.5 Flash Image model. Replaces background with pure white, enhances lighting, adds subtle shadow (contact shadow for objects, wall shadow for wall art).
  4. **Title/description/category suggestion**: Sends up to 4 photos (768px) to Gemini. Gets 2-5 word title, single-sentence description, and category. Only fills empty fields.
- Each photo has an AI toggle -- photos with AI disabled skip background removal.
- Images are resized before API calls for speed and cost savings.

**Form Fields:**
- Title (text, required)
- Description (textarea)
- Price (number)
- Size (text, e.g., '24" x 18"')
- Category (select, required): Wall Art, Object, Ceramic, Furniture, Light, Sculpture, Misc
- Dealer Code (text, default "14EK")
- Mark as New (toggle switch)
- Put on Hold (toggle switch)
- Mark as Sold (toggle switch)

**Save Process:**
1. Generates sequential 6-digit ID for new items (e.g., "000016")
2. Uploads each new photo to GitHub at `images/products/{id}/{index}.jpg` via GitHub Contents API
3. Builds item JSON with all fields
4. For new items: pushes existing items' order values down, inserts at order 0
5. Updates `inventory.json` in the repo with commit message "Add {title}" or "Update {title}"
6. SHA conflict handling: if 409 error, re-fetches current SHA and retries once

**Delete:**
- Available from editor screen (trash icon in header) and swipe-to-reveal in list
- Confirmation dialog (custom modal)
- Deletes all associated images from GitHub repo
- Removes item from inventory.json
- Commit message: "Delete {title}"

### 5.7 Analytics Dashboard

Accessible from hamburger menu. Displays metrics from the Supabase `events` table.

**Date Range Toggle:** 7d / 30d (default) / 90d buttons in header.

**Summary Cards:**
- Today's views (count + unique sessions), with % change vs yesterday
- This week's views (count + unique sessions), with % change vs last week

**14-Day Sparkline:** Bar chart showing daily page views. Today's bar highlighted black, others gray.

**Conversion Funnel:** Bar visualization showing:
- Total visitors (unique sessions)
- Item views (count)
- Inquiries (count with conversion %)

**Inquiries Card:** Total inquiry count for the selected range.

**Most Viewed Items:** Top 10 items by view count, showing thumbnail, title, view count, and inquiry count.

**Popular Categories:** Horizontal bar chart of category popularity by item view count.

**Traffic Sources:** Horizontal bar chart. Sources detected from utm_source parameter, referrer hostname, or "Direct".

**Devices:** Mobile vs Desktop split (detected from user agent).

**Pull-to-refresh** supported on touch devices.

### 5.8 Marketing Dashboard

Accessible from hamburger menu. Two sections:

**Email Subscribers:**
- Table showing email, source, and date
- Total subscriber count
- "Export CSV" button generates downloadable CSV file
- Data from Supabase `emails` table

**Discount Codes:**
- Create form: code input (with "Random" button for 8-char alphanumeric), type (% off / $ off), value, max uses
- List of existing codes showing: code, discount label, usage count
- Active/inactive toggle for each code
- Filters out gift certificates (shown separately)
- Data from Supabase `discount_codes` table (where `is_gift_certificate` is false)

### 5.9 Gift Certificates (Top-Level Menu)

Gift certificates have their own top-level menu item in the admin (gift box icon), not nested under Marketing.

**Admin route:** `#giftcerts` / `view-giftcerts`

**Create Form:**
- Dollar amount (required)
- Purchaser name (optional)
- Recipient name (optional)
- Recipient email (optional) -- if provided, automatically sends an email with the gift code via the worker's `/send-gift-email` endpoint
- Auto-generates `GIFT-XXXX-XXXX` code (charset: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` -- no ambiguous chars like 0/O/1/I)
- Stores `purchaser_email` on the discount code record

**List View:**
- Shows: code, amount, purchaser -> recipient names, purchaser email, date, status badge
- Status badges: Active (green), Redeemed (gray), Voided (red)
- "Void" button to deactivate unredeemed certificates
- Data from Supabase `discount_codes` table (where `is_gift_certificate` is true)

**Redemption Flow:**
- Gift certificates are standard discount codes with `is_gift_certificate: true`, `type: fixed`, `max_uses: 1`
- Customers enter the `GIFT-XXXX-XXXX` code in the discount input on any product detail page
- The existing discount validation applies the dollar amount as a fixed discount
- After checkout, `used_count` is incremented to 1, making the code invalid for future use
- In the admin list, status changes from "Active" to "Redeemed"

**Two Creation Paths:**
1. **Customer-purchased:** Via the `/gift/` page -- customer pays via Square, code created automatically by the `/gift-checkout` worker endpoint, confirmation email sent via Resend
2. **Admin-created:** Via the admin panel -- no payment required, optionally sends email to recipient via `/send-gift-email` worker endpoint

Gift certificates never expire.

### 5.10 Service Worker

`admin/sw.js` provides offline caching for the PWA:
- Cache name: `ol-admin-v48`
- Caches shell files: `/admin/`, `/admin/style.css`, `/admin/app.js`, `/OL_logo.svg`
- Strategy: network-first with cache fallback (online-first for fresh data, offline fallback for cached shell)
- Cache versioning: old caches deleted on activation
- skipWaiting + clients.claim for immediate activation

### 5.11 PWA Manifest

```json
{
  "name": "Object Lesson Admin",
  "short_name": "OL Admin",
  "start_url": "/admin/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff"
}
```

Apple-specific meta tags for home screen installation.

---

## 6. Cloudflare Worker

**File:** `worker/square-checkout.js`
**Deployed to:** `https://ol-checkout.objectlesson.workers.dev`

### 6.1 Endpoints

**POST /checkout** -- Creates a Square payment link

Request body:
```json
{
  "title": "Calder Print",
  "price": 695,
  "itemId": "000001",
  "discountCode": "WELCOME10"  // optional
}
```

Process:
1. Input validation (price > 0 and <= 100,000, itemId is 1-8 digits, title 1-200 chars)
2. If discount code provided, validates against Supabase `discount_codes` table
3. Creates Square order with line item, 10.25% CA sales tax, and optional discount
4. Creates payment link via Square Online Checkout API (`/v2/online-checkout/payment-links`)
5. Validates returned checkout URL starts with `https://square.link/` or `https://checkout.square.site/`
6. If discount was applied, increments `used_count` in Supabase
7. Returns `{ "url": "https://square.link/..." }`

Response on error:
```json
{ "error": "Error message" }
```

**POST /gift-checkout** -- Creates a Square payment link for a gift certificate purchase

Request body:
```json
{
  "amount": 50,
  "email": "buyer@example.com",
  "purchaserName": "Jane Doe",
  "recipientName": "John Smith"
}
```
- `amount` and `email` are required
- `purchaserName` and `recipientName` are optional

Process:
1. Input validation (amount > 0 and <= 10,000, email required)
2. Generates `GIFT-XXXX-XXXX` code (charset: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`)
3. Creates Square order with line item name `Gift Certificate - $XX` -- **no sales tax** (gift certificates are not taxable), **no shipping address**
4. Creates payment link via Square Online Checkout API with `pre_populated_data.buyer_email` set
5. Inserts gift certificate into Supabase `discount_codes` table with `is_gift_certificate: true`, `type: fixed`, `value: amount`, `max_uses: 1`, `purchaser_email: email`
6. Captures email in Supabase `emails` table (source: `gift_certificate`)
7. **Sends confirmation email** via Resend API from `gift@objectlesson.la` with styled HTML containing the gift code, amount, names, and usage instructions
8. Payment note format: `Object Lesson | Gift Certificate (GIFT-XXXX-XXXX)`
9. Redirect URL: `https://objectlesson.la/gift/?purchased=1&code={CODE}`
10. Returns `{ "url": "https://square.link/...", "code": "GIFT-XXXX-XXXX" }`

**POST /send-gift-email** -- Sends a gift certificate email (used by admin panel)

Request body:
```json
{
  "code": "GIFT-XXXX-XXXX",
  "amount": 50,
  "email": "recipient@example.com",
  "purchaserName": "Jane Doe",
  "recipientName": "John Smith"
}
```
- `code`, `amount`, and `email` are required
- `purchaserName` and `recipientName` are optional

Process:
1. Validates required fields
2. Sends styled HTML email via Resend API (same template as gift-checkout)
3. Returns `{ "success": true }`

This endpoint exists so admin-created gift certificates can trigger emails without going through Square checkout.

**POST /webhook** -- Handles Square payment webhooks

Process:
1. Validates HMAC-SHA256 webhook signature (if key configured). Logs warning on mismatch but does not reject.
2. On `payment.updated` event with `status: COMPLETED`:
   - Extracts item info from payment note (format: "Object Lesson | {title} ({itemId})")
   - **Auto-marks item as sold** in inventory.json via GitHub API -- **skipped for gift certificate payments** (detected by "Gift Certificate" in payment note)
   - **Captures buyer email** from Square payment to Supabase `emails` table (source: "purchase")

### 6.2 CORS

Allowed origins: `https://objectlesson.la`, `https://www.objectlesson.la`, `https://elikagan.github.io`

### 6.3 Email Sending (Resend)

Gift certificate confirmation emails are sent via the Resend API.

- **From address:** `Object Lesson <gift@objectlesson.la>`
- **Domain:** `objectlesson.la` verified in Resend with DKIM, SPF, and DMARC records on Porkbun DNS
- **DNS records added to Porkbun:**
  - TXT `resend._domainkey` -- DKIM public key
  - MX `send` -- `feedback-smtp.us-east-1.amazonses.com` (priority 10)
  - TXT `send` -- `v=spf1 include:amazonses.com ~all`
  - TXT `_dmarc` -- `v=DMARC1; p=none;` (optional)
- **Email template:** Styled HTML matching site aesthetic (Helvetica Neue, minimal, centered layout)
- **Triggered by:** `/gift-checkout` (customer purchases) and `/send-gift-email` (admin creates)

### 6.4 Sale Notifications

Sale notifications are handled natively by Square (Settings -> Notifications), not by the worker. Twilio was previously used but has been removed due to 10DLC carrier requirements.

### 6.5 Environment Variables

| Variable | Purpose |
|----------|---------|
| `SQUARE_ACCESS_TOKEN` | Square API token |
| `SQUARE_LOCATION_ID` | Square location for orders |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Webhook HMAC validation |
| `GITHUB_TOKEN` | GitHub API token for auto-sold |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `RESEND_API_KEY` | Resend API key for sending emails |

---

## 7. Inventory Schema

Each item in `inventory.json` is a JSON object:

```json
{
  "id": "000015",
  "title": "Vollard Litho",
  "description": "Graphic print on paper, published by Ambroise Vollard...",
  "price": 1800,
  "size": "",
  "category": "wall-art",
  "dealerCode": "14EK",
  "isNew": false,
  "isHold": false,
  "isSold": false,
  "images": [
    "images/products/000015/0.jpg",
    "images/products/000015/1.jpg"
  ],
  "heroImage": "images/products/000015/0.jpg",
  "order": 0,
  "createdAt": "2026-02-27T01:29:34.448Z"
}
```

**Field Reference:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique ID. Sequential 6-digit zero-padded (e.g., "000015") or legacy alphanumeric (e.g., "mm3pl1ta") |
| `title` | string | Yes | Product name, title case |
| `description` | string | No | Single sentence description |
| `price` | number | Yes | Price in USD (integer or decimal) |
| `size` | string | No | Dimensions (e.g., '24" x 18"') |
| `category` | string | Yes | One of: wall-art, object, ceramic, furniture, light, sculpture, misc |
| `dealerCode` | string | No | Dealer identification code (e.g., "14EK") |
| `isNew` | boolean | No | Shows "New" badge. Auto-cleared when sold. |
| `isHold` | boolean | No | Shows "On Hold" badge, hides Buy Now. Auto-cleared when sold. |
| `isSold` | boolean | No | Shows "Sold" badge, hides all purchase actions |
| `images` | string[] | No | Array of image paths relative to repo root |
| `heroImage` | string | No | Path to the primary display image (usually first in images array) |
| `order` | number | No | Sort order (lower = first). Default 0. |
| `createdAt` | string | No | ISO 8601 timestamp of creation |

**ID Format:** Displayed to users as "A" + 6-digit zero-padded number (e.g., A000015). The `formatId()` function handles this conversion. Legacy IDs (alphanumeric) are displayed as "A" + the raw ID.

---

## 8. Deployment

### 8.1 Hosting

The site is hosted on **GitHub Pages** from the repository `elikagan/objectlesson-site` on the `main` branch.

- **Custom domain:** `objectlesson.la` (configured via `CNAME` file)
- **Repository:** https://github.com/elikagan/objectlesson-site

### 8.2 How to Deploy

Changes pushed to the `main` branch are automatically deployed via GitHub Pages. No build step is required.

For the **storefront**: just push changes to `index.html`, `app.js`, `style.css`, or `inventory.json`.

For the **admin**: push changes to `admin/index.html`, `admin/app.js`, `admin/style.css`. Bump the service worker cache version in `admin/sw.js` (e.g., `ol-admin-v24` to `v25`) to ensure phones pick up the new version.

For the **Cloudflare Worker**: Deploy `worker/square-checkout.js` to Cloudflare Workers via the Cloudflare dashboard or `wrangler` CLI. The worker URL is `https://ol-checkout.objectlesson.workers.dev`.

### 8.3 Build Script

`build.sh` provides optional minification for production:

```bash
#!/bin/bash
npx terser app.js -o app.min.js -c -m --mangle-props=false
npx terser admin/app.js -o admin/app.min.js -c -m --mangle-props=false
npx csso style.css -o style.min.css
npx csso admin/style.css -o admin/style.min.css
```

Prerequisites: `npm install -g terser csso-cli`

Note: The HTML files currently reference the unminified versions. After running the build script, update `index.html` and `admin/index.html` to reference `.min.js` and `.min.css` files.

### 8.4 Inventory Updates from Admin

When the admin panel saves an item or reorders inventory:
1. It writes `inventory.json` to the GitHub repo via the GitHub Contents API
2. Product images are uploaded to `images/products/{id}/` via the same API
3. The storefront fetches from `raw.githubusercontent.com` with a cache-busting timestamp, so changes appear instantly without waiting for GitHub Pages to rebuild

### 8.5 Development Server

`.claude/launch.json` configures a local Ruby HTTP server:

```json
{
  "name": "objectlesson",
  "runtimeExecutable": "ruby",
  "runtimeArgs": ["-run", "-e", "httpd", ".", "-p", "8090"],
  "port": 8090
}
```

---

## 9. External Services

### 9.1 Supabase

- **URL:** `https://gjlwoibtdgxlhtfswdkk.supabase.co`
- **Anon Key:** Used in storefront for public writes (events, emails, discount code reads)
- **Service Key:** Used in admin for full access (reads on emails, discount_codes; writes for discount code creation/updates)

**Tables:**

| Table | Fields | Purpose |
|-------|--------|---------|
| `events` | event, item_id, session_id, referrer, utm_source, ua_mobile, path, created_at | Analytics tracking |
| `emails` | email, source, discount_code, created_at | Email subscriber collection |
| `discount_codes` | id, code, type, value, is_active, max_uses, used_count, is_gift_certificate, purchaser_name, recipient_name, purchaser_email, created_at | Discount codes and gift certificates |

**RLS Policies on `discount_codes`:**
- Anon key can INSERT rows where `is_gift_certificate = true` (allows the public gift checkout to create gift certs)
- Anon key can SELECT and PATCH (for incrementing `used_count` on redemption)
- Full access via service key (admin panel)

**`emails` table `source` values:**
| Source | When |
|--------|------|
| `newsletter` | Email bar signup (WELCOME10) |
| `purchase` | Email gate before checkout, or buyer email from Square webhook |
| `gift_certificate` | Gift certificate purchase on `/gift/` page |
| `abandoned_cart` | Email gate where user didn't complete purchase |

### 9.2 Square

- **API Version:** 2024-12-18
- **Used for:** Creating payment links via Online Checkout API
- **Webhook:** `payment.updated` event (signature validated with HMAC-SHA256)
- **Redirect:** Returns to `https://objectlesson.la/?purchased=1#{itemId}` after payment

### 9.3 GitHub (as CMS)

- **Repository:** `elikagan/objectlesson-site`
- **API:** Used by admin panel and Cloudflare Worker for reading/writing inventory and images
- **Raw content:** Used by storefront for fetching fresh inventory (`raw.githubusercontent.com`)

### 9.4 Resend (Email)

- **Used by:** Cloudflare Worker for sending gift certificate confirmation emails
- **API:** `https://api.resend.com/emails`
- **From address:** `Object Lesson <gift@objectlesson.la>`
- **Domain:** `objectlesson.la` -- verified with DKIM/SPF/DMARC DNS records on Porkbun
- **DNS provider:** Porkbun (porkbun.com)
- **Resend dashboard:** resend.com (logged in as eli.kagan@gmail.com)
- **API key env var:** `RESEND_API_KEY` in Cloudflare Worker

### 9.5 Twilio (REMOVED)

Twilio was previously used for SMS sale alerts. Account deleted due to 10DLC carrier registration requirements blocking messages. Sale notifications now handled natively by Square (Settings -> Notifications).

### 9.6 Google Gemini

- Used by admin panel for AI-powered image processing
- **Models:**
  - `gemini-2.5-flash` -- Text analysis (price tag detection, OCR, item suggestion)
  - `gemini-2.5-flash-image` -- Image generation (background removal/replacement)
- Images resized before sending: 512px for tag detection, 1024px for OCR, 1536px for background removal, 768px for suggestions

---

## 10. Styling and Design System

### 10.1 CSS Variables (Storefront)

```css
:root {
  --black: #1a1a1a;
  --gray: #888;
  --light: #888;
  --border: #bbb;
  --bg: #fff;
  --font: "Helvetica Neue", Helvetica, Arial, sans-serif;
}
```

### 10.2 CSS Variables (Admin)

```css
:root {
  --black: #1a1a1a;
  --text: #888;
  --light: #bbb;
  --border: #e8e8e8;
  --bg: #fff;
  --bg2: #f7f7f7;
  --font: "Helvetica Neue", Helvetica, Arial, sans-serif;
  --radius: 10px;
  --safe-b: env(safe-area-inset-bottom, 0px);
}
```

### 10.3 Typography

- **Font family:** Helvetica Neue, Helvetica, Arial, sans-serif (system font stack)
- **Font smoothing:** `-webkit-font-smoothing: antialiased`
- **Text size adjust:** `-webkit-text-size-adjust: 100%`

### 10.4 Color Palette

| Usage | Color |
|-------|-------|
| Primary text | #1a1a1a (near-black) |
| Secondary text | #888 (gray) |
| Borders | #bbb (storefront) / #e8e8e8 (admin) |
| Background | #fff (white) |
| Secondary background | #f7f7f7 / #f5f5f5 |
| New badge | black text, white bg |
| Sold badge | gray text, white bg |
| Hold badge | #b8860b (dark goldenrod) |
| Discount applied | #2d7d46 (green) on #e2f0e5 (light green) |
| Email bar | #1a1a1a (black background) |
| Error/delete | #d33 (red) |
| Analytics up | #22863a (green) |
| Analytics down | #cb2431 (red) |

### 10.5 Responsive Breakpoints

| Breakpoint | Target |
|------------|--------|
| <= 559px | Mobile |
| 560px - 959px | Tablet |
| >= 960px | Desktop |

**Mobile adjustments:**
- Logo: 120px (from 160px)
- Header padding reduced
- Mosaic: 2 columns, no side padding
- Grid: 2 columns, tighter gaps
- Detail gallery: negative margins (full-bleed)
- Smaller font sizes across the board

### 10.6 Design Patterns

- **Pill buttons:** Rounded capsule shape (border-radius: 100px)
- **Cards:** 1:1 aspect ratio images, subtle hover zoom
- **Sticky headers:** Semi-transparent white with blur backdrop
- **Animations:** fadeUp for cards, slide transitions for views, 3D flip for mosaic
- **Shadows:** Minimal -- only on dropdowns and FAB
- **iOS safe areas:** Admin uses `env(safe-area-inset-bottom)` for FAB and padding

### 10.7 Security Headers

Content Security Policy defined in index.html:
```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' https://raw.githubusercontent.com data:;
connect-src 'self' https://*.supabase.co https://ol-checkout.objectlesson.workers.dev https://raw.githubusercontent.com
```

Also includes `X-Frame-Options: DENY` to prevent framing.

---

## 11. Git History Summary

**Total commits:** 224 (as of February 27, 2026)

### Phase 1: Foundation (Commit 1-10)

- **Initial commit** (`87668f0`): Website and admin PWA scaffolding
- Added PIN lock screen to admin
- Fixed mobile keyboard issues for PIN input
- Implemented service worker caching
- Enabled photo library selection (removed camera-only capture)

### Phase 2: Admin Core (Commits 11-30)

- Overhauled admin storage and login flow (cookies to IndexedDB)
- Added Gemini API integration for AI image processing
- Implemented drag-to-reorder photos with auto-detect price tags
- Image resize before Gemini API calls for speed
- Added per-image AI toggle
- Sequential ID system, filter and footer refinements
- Swipe-to-delete on inventory list

### Phase 3: Product Detail and Content (Commits 31-80)

- Major update: product detail page with sliding image carousel
- Fetching inventory from GitHub raw for instant updates
- Added logo with tagline, size field to inventory
- Header layout iterations (centering logo, IG pill placement, filter positioning)
- Added animated mosaic hero with 3D flip tiles
- Multiple product additions: Calder Print, Cicely Debeers, Studio Pot, Burlwood Box, Joel Stearns, Minoru Ohira, Cleo Baldon Chairs, etc.

### Phase 4: Analytics and Marketing (Commits 81-120)

- Added Supabase analytics system
- Hamburger menu and share button
- Enhanced analytics: sparkline, conversion funnel, date ranges, pull-to-refresh
- OG tags, About page, Sold toggle, loading state, dead link handling
- Under $400 price filter

### Phase 5: E-Commerce (Commits 121-160)

- Square Checkout "Buy Now" integration via Cloudflare Worker
- Hold toggle, archive section, auto-sold on payment
- Post-purchase thank-you page with pickup info and SMS link
- Webhook processing for payment notifications
- 10.25% CA sales tax added to checkout
- SMS sale alerts via Twilio

### Phase 6: Marketing and Polish (Commits 161-224)

- Email capture bar (10% off WELCOME10)
- Discount codes (Supabase-backed, server-side validation)
- Security hardening (CSP headers, input validation, rate limiting)
- Email gate before checkout (required for first purchase)
- Multiple inventory updates and product additions (Vollard Litho, Cusco Painting, Marcelo Bonevardi, Lurelle Guild Bowl)
- Ongoing UI refinements: darkened UI elements, footer adjustments, animation timing

---

## 12. Known Issues and Future Work

### Known Issues

1. **ItemId validation in worker is restrictive:** The Cloudflare Worker validates itemId with `/^\d{1,8}$/`, which rejects legacy alphanumeric IDs like "mm3pl1ta". Items with these IDs cannot be purchased via Square Checkout.

2. **No server-side inventory check before checkout:** The Worker trusts the client-supplied price. A user could theoretically submit a lower price. Server-side price verification against inventory.json would be more secure.

3. **Webhook signature validation is soft:** The Worker logs a warning on signature mismatch but still processes the webhook. This should be hardened to reject invalid signatures in production.

4. **Discount code used_count race condition:** If two checkouts use the same discount code simultaneously, both could pass the max_uses check before either increments the counter. An atomic increment or database constraint would be safer.

5. **Sold items in "All" view:** Sold items appear at the bottom of the grid in "All" mode, which could be confusing as inventory grows. A separate "Sold" filter or removal from the main grid may be cleaner.

6. **Image cleanup on item delete:** When deleting items via the admin, images are deleted one-by-one via the GitHub API. If the process fails partway through, orphaned images remain in the repo.

7. **Service worker cache version is manual:** The admin SW cache version (`ol-admin-v24`) must be manually incremented to push updates to installed PWAs. An automated versioning system would reduce friction.

### Potential Future Work

1. **Search functionality** -- Text search across titles and descriptions
2. **Multiple image upload progress** -- Show progress bar for each image upload during save
3. **Inventory import/export** -- Bulk operations for inventory management
4. **Wishlist/favorites** -- Let visitors save items they are interested in
5. **Related items** -- Show similar items on the detail page
6. **Price history** -- Track price changes over time
7. **Automated backups** -- Regular backup of inventory and Supabase data
8. **Push notifications** -- Notify subscribers when new items are added
9. **Multi-currency support** -- For international buyers
10. **Image CDN** -- Use a CDN instead of GitHub raw for faster image loading
11. **Server-side rendering** -- For better SEO and social media previews of individual items
12. **Build/deploy pipeline** -- Automated minification and cache busting on push
