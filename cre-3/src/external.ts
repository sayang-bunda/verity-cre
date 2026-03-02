import { ConfidentialHTTPClient, text, type Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config'

// ─── Shared helper to call NewsAPI ───────────────────────────────────────────

const fetchFromNewsAPI = (
    runtime: Runtime<Config>,
    query: string,
    pageSize = 5,
): Array<{ title?: string; description?: string; publishedAt?: string; source?: { name?: string }; url?: string }> => {
    const client = new ConfidentialHTTPClient()
    const encoded = encodeURIComponent(query.slice(0, 100))

    const response = client
        .sendRequest(runtime, {
            vaultDonSecrets: [{ key: 'NEWS_API_KEY' }],
            request: {
                url: `https://newsapi.org/v2/everything?q=${encoded}&sortBy=publishedAt&pageSize=${pageSize}&language=en`,
                method: 'GET',
                multiHeaders: {
                    'X-Api-Key': { values: ['{{.NEWS_API_KEY}}'] },
                },
            },
        })
        .result()

    if (response.statusCode !== 200) {
        runtime.log(`NewsAPI ${response.statusCode} — no context available`)
        return []
    }

    const body = JSON.parse(text(response)) as {
        articles?: Array<{ title?: string; description?: string; publishedAt?: string; source?: { name?: string }; url?: string }>
    }

    return body.articles ?? []
}

/**
 * Step 3 (EVENT) — Fetch recent news articles for event resolution
 * Returns formatted text + article URLs for on-chain evidence.
 */
export const fetchNewsContext = (runtime: Runtime<Config>, query: string): { text: string; urls: string[] } => {
    try {
        const articles = fetchFromNewsAPI(runtime, query, 5)

        if (articles.length === 0) {
            return { text: '- No recent news found', urls: [] }
        }

        const urls = articles.map(a => a.url ?? '').filter(Boolean)
        const headlines = articles
            .map((a, i) => `  ${i + 1}. [${a.source?.name ?? 'Unknown'}] ${a.title} (${a.publishedAt?.slice(0, 10) ?? 'n/a'})\n     ${a.description?.slice(0, 120) ?? ''}\n     URL: ${a.url ?? 'n/a'}`)
            .join('\n')

        return { text: `Recent news from ${articles.length} source(s):\n${headlines}`, urls }
    } catch (err) {
        runtime.log(`News fetch failed: ${err}`)
        return { text: '- News fetch unavailable', urls: [] }
    }
}

/**
 * Step 3 (SOCIAL) — Fetch social/viral context for social market resolution
 * Returns formatted text + article URLs for on-chain evidence.
 */
export const fetchSocialMetrics = (runtime: Runtime<Config>, query: string): { text: string; urls: string[] } => {
    try {
        const socialQuery = `${query.slice(0, 60)} viral trending social`
        const articles = fetchFromNewsAPI(runtime, socialQuery, 5)

        if (articles.length === 0) {
            return { text: '- No social/viral signals found', urls: [] }
        }

        const urls = articles.map(a => a.url ?? '').filter(Boolean)
        const signals = articles
            .map((a, i) => `  ${i + 1}. [${a.source?.name ?? 'Unknown'}] ${a.title} (${a.publishedAt?.slice(0, 10) ?? 'n/a'})\n     ${a.description?.slice(0, 120) ?? ''}\n     URL: ${a.url ?? 'n/a'}`)
            .join('\n')

        return { text: `Social/viral signals from ${articles.length} source(s):\n${signals}`, urls }
    } catch (err) {
        runtime.log(`Social metrics fetch failed: ${err}`)
        return { text: '- Social metrics fetch unavailable', urls: [] }
    }
}
