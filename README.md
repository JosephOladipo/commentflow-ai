# CommentFlow AI

Standalone local Node/Express and plain JavaScript dashboard. LinkedIn discovery uses Apify; Facebook, Instagram and X use pasted text and direct links only. All publishing is manual.

## Run

Use Node 22 or later. Existing dependencies: Express, dotenv and the OpenAI SDK.

- `npm start`: start the server.
- `npm run dev`: start with Node file watching.
- `npm test`: run offline tests with mocked clients.

Keep the existing `.env` and its `PORT=3002` setting. Add `OPENAI_API_KEY` locally if absent; optionally add `OPENAI_MODEL=gpt-4.1-mini`. Never put keys in browser code. `.env.example` is a template only and does not overwrite configuration. New installations default to port 3001.

The default [GPT-4.1 mini model](https://developers.openai.com/api/docs/models/gpt-4.1-mini) supports structured outputs. The installed SDK's `chat.completions.parse` consumes a strict JSON schema; the server independently checks IDs, fields and draft limits. Model access still depends on the operator's account.

## Workflow

1. Expand Brand & comment settings and enter the account's expertise, audience, tone and style. Settings save in this browser; changes make no API calls.
2. For LinkedIn, select a niche and search options. Find Posts uses the existing discovery endpoint; the enabled AI checkbox then makes at most one comment batch request for uncommented posts.
3. Generate Comments uses posts already displayed. LinkedIn text comes from the server's unexpired six-hour search cache, addressed by search identity and post IDs. It never calls Apify. A missing or expired cache returns an explicit error.
4. For Facebook, Instagram, X, or optional LinkedIn manual mode, paste 20–15,000 characters and an expanded HTTPS post link. Generate Comment uses only that text and does not fetch the URL.
5. Review and edit the draft, copy it, open the source, and paste/publish yourself. Only Mark as Commented changes commented status; reviewed status is separate. Show commented posts lets you undo that status.
6. Generate Alternative explicitly requests a fresh single-post draft and includes the previous draft. Ordinary generation preserves user edits; alternatives replace them.

Local browser storage preserves niches, settings, drafts, edits, commented status and the last displayed posts. A refresh restores the workspace without any paid call. Use the same browser and origin (for example, consistently `http://127.0.0.1:3002`) to retain those preferences.

## Usage safeguards

- Discovery remains fixed to `apimaestro/linkedin-posts-search-scraper-no-cookies`, 5 or 10 results, one active search, persistent cooldown and six-hour cache.
- Actual fields supplied as verified in Prompt 2: `post_url`, `text`, `author.name`, `posted_at.timestamp` (milliseconds), `posted_at.display_text`, `stats.total_reactions`, `stats.comments`. Existing legacy field support is preserved.
- Server filtering rejects missing timestamps, invalid URLs and duplicates; three-day requests use the provider's week filter and a server cutoff.
- Comments: at most 10 posts, one SDK call per generation, zero retries, 45-second timeout, at most 4,000 output tokens. Alternatives are single-post only. No SDK tools, URL fetching, social connections or automatic posting.
- Generated drafts are cached in `data/comment-cache.json` by post identity/content, settings and model (last 500 combinations). Discovery cache remains in `data/search-cache.json`. The data directory is not publicly served and is Git-ignored.
- AI failures leave posts and drafts available. Retry Comments does not repeat discovery. Relevance screening is not fact-checking.
- Only `public/` is served. Health exposes configuration booleans, never keys. Both paid endpoints reject cross-site browser requests and require bounded JSON bodies.
- Run one local app instance. Deployment and final production hardening are reserved for Prompt 3.

## Controlled OpenAI-only test

After adding your OpenAI key locally, stop the current server with Ctrl+C and run `npm start` from this directory. Open `http://127.0.0.1:3002`. Select a manual platform, paste one real post's text and matching expanded link, then click **Generate Comment once**. This makes at most one OpenAI request and no Apify request. Check the draft, edit it and copy; do not publish until you have reviewed it.

## Implementation map

- `server.js`, `src/config/index.js`: local startup and server-only configuration.
- `src/routes/app.js`: health, discovery and independent comment endpoints.
- `src/services/apify.js`, `discovery.js`: provider adapter and persistent search protections.
- `src/services/comments.js`, `src/utils/comments.js`: strict generation, manual validation and comment cache.
- `src/utils/posts.js`: existing validated source normalization and time filtering.
- `public/index.html`, `styles.css`, `app.js`, `comments.js`: existing dashboard plus manual draft workflow.
- `tests/discovery.test.js`, `tests/comments.test.js`: offline verification; synthetic fixtures never appear in the live dashboard.
