import { ConfidentialHTTPClient, text, type Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config'


const NEWS_API_PAGE_SIZE = 5
const NEWS_API_EVENTS_PAGE_SIZE = 3


/**
 * Step 3a — News API: recent news related to market topic (last 24h)
 */
export const fetchNewsContext = (runtime: Runtime<Config>, topic: string): string => {
    try {
        const client = new ConfidentialHTTPClient()
        const query = encodeURIComponent(topic)

        const response = client
            .sendRequest(runtime, {
                vaultDonSecrets: [{ key: 'NEWS_API_KEY' }],
                request: {
                    url: `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=${NEWS_API_PAGE_SIZE}&language=en`,
                    method: 'GET',
                    multiHeaders: { 'X-Api-Key': { values: ['{{.NEWS_API_KEY}}'] } },
                },
            })
            .result()

        if (response.statusCode !== 200) {
            runtime.log(`NewsAPI returned ${response.statusCode}, skipping news context`)
            return '- Recent news: [none]'
        }

        const body = JSON.parse(text(response)) as {
            articles?: Array<{ title?: string; publishedAt?: string }>
        }

        if (!body.articles || body.articles.length === 0) {
            return '- Recent news: [none]'
        }

        const headlines = body.articles
            .slice(0, 3)
            .map((a) => `  • ${a.title} (${a.publishedAt?.slice(0, 10) ?? 'unknown date'})`)
            .join('\n')

        return `- Recent news:\n${headlines}`
    } catch (err) {
        runtime.log(`News fetch failed: ${err}. Proceeding without news context.`)
        return '- Recent news: [fetch unavailable]'
    }
}


/**
 * Step 3c — Scheduled events within 48h
 */
export const fetchScheduledEvents = (runtime: Runtime<Config>, topic: string): string => {
    try {
        const client = new ConfidentialHTTPClient()
        const query = encodeURIComponent(topic)

        const response = client
            .sendRequest(runtime, {
                vaultDonSecrets: [{ key: 'NEWS_API_KEY' }],
                request: {
                    url: `https://newsapi.org/v2/everything?q=${query}+scheduled+event+upcoming&sortBy=publishedAt&pageSize=${NEWS_API_EVENTS_PAGE_SIZE}&language=en`,
                    method: 'GET',
                    multiHeaders: { 'X-Api-Key': { values: ['{{.NEWS_API_KEY}}'] } },
                },
            })
            .result()

        if (response.statusCode !== 200) {
            return '- Scheduled events: [none in 48h]'
        }

        const body = JSON.parse(text(response)) as {
            articles?: Array<{ title?: string }>
        }

        if (!body.articles || body.articles.length === 0) {
            return '- Scheduled events: [none in 48h]'
        }

        const events = body.articles
            .slice(0, 3)
            .map((a) => `  • ${a.title}`)
            .join('\n')

        return `- Scheduled events (next 48h):\n${events}`
    } catch (err) {
        runtime.log(`Scheduled events fetch failed: ${err}`)
        return '- Scheduled events: [none in 48h]'
    }
}
