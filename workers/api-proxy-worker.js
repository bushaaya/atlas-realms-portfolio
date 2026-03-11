/**
 * CLOUDFLARE WORKER — API Proxy + KV Catalog Cache
 *
 * What this does:
 *   1. CORS enforcement — restricts requests to your production domain only
 *   2. Flowise proxy — forwards AI pipeline requests from the frontend, injecting
 *      the Flowise API key from a Cloudflare secret (never exposed to the browser)
 *   3. KV-backed game catalog cache — serves the full game database from Cloudflare KV
 *      rather than hitting Airtable on every query. The Retriever node calls this
 *      endpoint server-to-server; the cache is refreshed every 12h via cron trigger.
 *   4. Stale-while-revalidate — if Airtable fails during a refresh, the previous
 *      cached data is served with an X-Cache: STALE header rather than returning an error.
 *
 * Environment variables (set via Cloudflare dashboard → Workers → Settings → Variables):
 *   AIRTABLE_API_KEY       Personal access token with read scope
 *   AIRTABLE_BASE_ID       Your Airtable base ID (appXXXXXXXXXXX)
 *   AIRTABLE_EX_TABLE_NAME Table name for the main game database
 *   AIRTABLE_IN_TABLE_NAME Table name for owned/inventory games
 *   FLOWISE_API_URL        Flowise pipeline URL
 *   FLOWISE_API_KEY        Flowise bearer token
 *   CACHE_SECRET           Shared secret for server-to-server catalog requests
 *                          (prevents the catalog endpoint from being scraped publicly)
 *
 * KV namespace binding (Cloudflare dashboard → Workers → Bindings):
 *   YOUR_KV_NAMESPACE      KV namespace bound to this worker
 */

// ============================================================
// CACHE CONFIG
// ============================================================

const CACHE_KEY = 'your_cache_key';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — both tables are combined into one blob, one TTL
const VIEW_NAME = 'Your Airtable View';    // Airtable view that filters to publishable records only

// Field projections — only fetch the fields each table actually needs.
// Keeps the cached payload compact; actual field names are proprietary.
// The pattern: two separate arrays share a common core, each extended with table-specific fields.
const SHARED_FIELDS = [
    'Title',
    'Players_min', 'Players_max',
    'Playtime_bucket', 'Play_min_minutes', 'Play_max_minutes',
    // ... logistics fields
    // ... taxonomy dimension fields (mechanics, categories, weight, etc.)
    // ... display fields (summary, image URL, external links)
];

const INVENTORY_FIELDS = [...SHARED_FIELDS]; // + inventory-specific fields (condition, price, etc.)
const EXTERNAL_FIELDS  = [...SHARED_FIELDS]; // + catalog-specific fields  (affiliate links, popularity, etc.)

// ============================================================
// AIRTABLE HELPERS
// ============================================================

/**
 * Paginates through all Airtable records for a given table.
 * Airtable returns max 100 records per page; this loops until exhausted.
 * Hard cap at 2,000 records to prevent runaway fetches.
 */
async function fetchAllPages(baseId, table, fields, apiKey) {
    let records = [];
    let offset = null;
    const baseUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
    const fieldParams = fields.map(f => `fields%5B%5D=${encodeURIComponent(f)}`).join('&');

    do {
        const parts = ['pageSize=100', `view=${encodeURIComponent(VIEW_NAME)}`, fieldParams];
        if (offset) parts.push(`offset=${encodeURIComponent(offset)}`);
        const url = `${baseUrl}?${parts.join('&')}`;

        const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Airtable fetch failed: ${table} ${res.status} — ${body}`);
        }

        const data = await res.json();
        if (data.records) records.push(...data.records);
        offset = data.offset || null;
    } while (offset && records.length < 2000);

    return records;
}

/**
 * Fetches both tables concurrently.
 * Using Promise.all here is safe because both fetches are read-only.
 */
async function fetchFromAirtable(env) {
    const { AIRTABLE_API_KEY: key, AIRTABLE_BASE_ID: base, AIRTABLE_EX_TABLE_NAME: extTable, AIRTABLE_IN_TABLE_NAME: invTable } = env;
    if (!key || !base || !extTable || !invTable) throw new Error('Missing Airtable env vars in Worker secrets');

    const [external, inventory] = await Promise.all([
        fetchAllPages(base, extTable, EXTERNAL_FIELDS,  key),
        fetchAllPages(base, invTable, INVENTORY_FIELDS, key),
    ]);

    return { external, inventory };
}

// ============================================================
// KV CACHE HELPERS
// ============================================================

async function getCache(env) {
    try {
        return await env.YOUR_KV_NAMESPACE.get(CACHE_KEY, 'json');
    } catch {
        return null;
    }
}

async function setCache(env, data) {
    const entry = { cached_at: Date.now(), data };
    await env.YOUR_KV_NAMESPACE.put(CACHE_KEY, JSON.stringify(entry));
}

function isCacheFresh(entry) {
    if (!entry || !entry.cached_at) return false;
    return (Date.now() - entry.cached_at) < CACHE_TTL_MS;
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

/**
 * GET /api/catalog
 * Server-to-server endpoint called by the Retriever node running on Render.
 * Protected by a shared secret header — not intended for browser access.
 *
 * Response strategy:
 *   - Cache HIT:   Return cached data immediately with X-Cache: HIT
 *   - Cache MISS:  Fetch from Airtable, populate cache, return fresh data with X-Cache: MISS
 *   - Airtable error + stale cache: Serve stale data with X-Cache: STALE rather than returning 502.
 *                                   The Retriever gets data; an error is logged for monitoring.
 *   - Airtable error + no cache:    502 with error message.
 */
async function handleCatalog(request, env) {
    const secret = request.headers.get('X-Cache-Secret');
    if (!secret || secret !== env.CACHE_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const cached = await getCache(env);
    if (isCacheFresh(cached)) {
        return new Response(JSON.stringify(cached.data), {
            headers: {
                'Content-Type': 'application/json',
                'X-Cache': 'HIT',
                'X-Cache-Age': String(Math.floor((Date.now() - cached.cached_at) / 1000)) + 's'
            }
        });
    }

    try {
        const data = await fetchFromAirtable(env);
        await setCache(env, data);
        return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' }
        });
    } catch (error) {
        // Stale-while-revalidate: serve stale data rather than failing the pipeline
        if (cached) {
            console.error('Airtable refresh failed, serving stale cache:', error.message);
            return new Response(JSON.stringify(cached.data), {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Cache': 'STALE',
                    'X-Cache-Error': error.message
                }
            });
        }
        return new Response(JSON.stringify({ error: error.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * POST /api/catalog/refresh
 * Admin endpoint to force a cache refresh — useful after editing game data in Airtable
 * without waiting for the 12h cron cycle.
 * Also protected by the shared secret.
 */
async function handleCacheRefresh(request, env) {
    const secret = request.headers.get('X-Cache-Secret');
    if (!secret || secret !== env.CACHE_SECRET) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const data = await fetchFromAirtable(env);
        await setCache(env, data);
        return new Response(JSON.stringify({
            success: true,
            external: data.external.length,
            inventory: data.inventory.length,
            cached_at: new Date().toISOString()
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * POST / (any path not matched above)
 * Flowise proxy — forwards requests from the Framer frontend to the Flowise pipeline.
 * The Flowise API key lives in a Cloudflare secret and is injected here server-side,
 * keeping it out of the browser entirely.
 */
async function handleFlowiseProxy(request, env, corsHeaders) {
    const body = await request.json();

    const flowiseResponse = await fetch(env.FLOWISE_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.FLOWISE_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const data = await flowiseResponse.json();
    return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// ============================================================
// SCHEDULED HANDLER (Cron Trigger)
// ============================================================

/**
 * Runs on a cron schedule (configured in wrangler.toml, e.g. every 12 hours).
 * Silently refreshes the KV catalog so that the first request after cache expiry
 * doesn't incur the Airtable fetch latency.
 */
async function refreshCache(env) {
    try {
        console.log('Scheduled cache refresh starting...');
        const data = await fetchFromAirtable(env);
        await setCache(env, data);
        console.log(`Cache refreshed: ${data.external.length} external, ${data.inventory.length} inventory`);
    } catch (error) {
        console.error('Scheduled cache refresh failed:', error.message);
    }
}

// ============================================================
// MAIN EXPORT
// ============================================================

export default {
    async fetch(request, env) {
        // CORS: restrict to your production domain only.
        // Update this to your actual domain.
        const ALLOWED_ORIGIN = 'https://www.yourdomain.com';
        const corsHeaders = {
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        const url = new URL(request.url);

        // CORS pre-flight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // Catalog cache endpoint — server-to-server, called by Retriever node
        if (url.pathname === '/api/catalog' && request.method === 'GET') {
            return handleCatalog(request, env);
        }

        // Force refresh endpoint — call manually after editing data
        if (url.pathname === '/api/catalog/refresh' && request.method === 'POST') {
            return handleCacheRefresh(request, env);
        }

        // Flowise proxy — called by Framer frontend
        if (request.method === 'POST') {
            try {
                return await handleFlowiseProxy(request, env, corsHeaders);
            } catch (error) {
                return new Response(JSON.stringify({ error: error.message }), {
                    status: 500,
                    headers: corsHeaders
                });
            }
        }

        return new Response('Method not allowed', { status: 405 });
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(refreshCache(env));
    }
};
