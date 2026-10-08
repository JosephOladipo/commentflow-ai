const { AppError, validateSearch } = require('../utils/posts');

const ACTOR = 'apimaestro~linkedin-posts-search-scraper-no-cookies';

// FEATURE/FUNCTION: Provider interface.
// PURPOSE: Search LinkedIn using one fixed actor with validated inputs.
function createProvider({ token, actor = ACTOR, fetchImpl = fetch }) {
  const apiToken = typeof token === 'string' ? token.trim() : '';

  return {
    async searchPosts(search) {
      const {
        keywords,
        timeRange,
        limit,
        sortBy,
      } = validateSearch(search);

      if (!apiToken) {
        throw new AppError(
          503,
          'APIFY_NOT_CONFIGURED',
          'Add APIFY_API_TOKEN to your local .env file and restart the server.'
        );
      }

      // FEATURE/FUNCTION: Actor input.
      // PURPOSE: Request the selected niche and date window.
      // Three-day searches request a week and are filtered locally.
      const input = {
        keyword: search.providerKeywords || keywords,
        sort_type: sortBy === 'newest' ? 'date_posted' : 'relevance',
        page_number: 1,
        date_filter: timeRange === '24h' ? 'past-24h' : 'past-week',
        limit,
      };

      // FEATURE/FUNCTION: Single bounded actor run.
      // PURPOSE: Limit spending without pagination or automatic retries.
      try {
        // FEATURE/FUNCTION: Bounded depth. PURPOSE: Fetch at most two pages and 60 candidates while keeping the actor spend capped.
        const depth = limit === 30 ? 2 : 1, collected = [];
        for (let page = 1; page <= depth && collected.length < limit * 2; page++) {
          const url = new URL('https://api.apify.com/v2/acts/' + actor + '/run-sync-get-dataset-items');
          url.searchParams.set('timeout', '120'); url.searchParams.set('restartOnError', 'false');
          url.searchParams.set('limit', String(limit)); url.searchParams.set('maxItems', String(limit)); url.searchParams.set('maxTotalChargeUsd', '0.05');
          const response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: 'Bearer ' + apiToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...input, page_number: page }),
          signal: AbortSignal.timeout(140000),
        });

        // FEATURE/FUNCTION: Provider errors.
        // PURPOSE: Return useful messages without exposing credentials.
          if (!response.ok) {
          let message;

          if ([401, 403].includes(response.status)) {
            message =
              'Apify rejected access. Check your token and actor access in Apify Console.';
          } else if (response.status === 402) {
            message =
              'Apify credit or spending limit reached. Check billing in Apify Console.';
          } else if (response.status === 429) {
            message =
              'Apify is rate limiting requests. Wait before trying again.';
          } else {
            message =
              'Apify could not complete the search. Check the run in Apify Console before another search.';
          }

            throw new AppError(
            502,
            'APIFY_REQUEST_FAILED',
            message
          );
          }

        // FEATURE/FUNCTION: Dataset parsing.
        // PURPOSE: Require an array and support the existing nested format.
          const data = await response.json();

          if (!Array.isArray(data)) {
          throw new AppError(
            502,
            'APIFY_OUTPUT_CHANGED',
            'Apify returned an unexpected dataset format. Check the actor output before another search.'
          );
          }

          const items = data.flatMap(item =>
          Array.isArray(item?.data?.posts)
            ? item.data.posts
            : [item]
          );

        // FEATURE/FUNCTION: Output validation.
        // PURPOSE: Recognise actual post_url fields and legacy url fields.
          const hasRecognisablePost = items.some(item =>
          item &&
          typeof item === 'object' &&
          typeof (item.post_url || item.url) === 'string' &&
          typeof item.text === 'string'
          );

          if (items.length > 0 && !hasRecognisablePost) {
          throw new AppError(
            502,
            'APIFY_OUTPUT_CHANGED',
            'The actor output has no recognisable post URL and text fields. Inspect this run in Apify Console; no retry was made.'
          );
          }

          collected.push(...items);
          if (items.length < limit) break;
        }
        // Detailed URL, timestamp, Boolean and duplicate checks happen after bounded collection.
        return collected.slice(0, limit);
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }

        // FEATURE/FUNCTION: Connection protection.
        // PURPOSE: Avoid starting a replacement run after uncertain failures.
        throw new AppError(
          502,
          'APIFY_CONNECTION_FAILED',
          'The Apify connection failed, timed out, or returned unreadable JSON. A run may have started. Check Apify Console before trying again; no retry was made.'
        );
      }
    },
  };
}

module.exports = { createProvider };
