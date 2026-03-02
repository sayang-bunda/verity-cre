import { ConfidentialHTTPClient, text, type Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config'

export const fetchNewsContext = (runtime: Runtime<Config>, query: string): string => {
    try {
        const client = new ConfidentialHTTPClient()
        const encoded = encodeURIComponent(query.slice(0, 100))

        const response = client
            .sendRequest(runtime, {
                vaultDonSecrets: [{ key: 'NEWS_API_KEY' }],
                request: {
                    url: `https://newsapi.org/v2/everything?q=${encoded}&sortBy=publishedAt&pageSize=5&language=en`,
                    method: 'GET',
                    multiHeaders: {
                        'X-Api-Key': { values: ['{{.NEWS_API_KEY}}'] },
                    },
                },
            })
            .result()

        if (response.statusCode !== 200) {
            runtime.log(`NewsAPI ${response.statusCode} — no news context available`)
            return '- No recent news found'
        }

        const body = JSON.parse(text(response)) as {
            articles?: Array<{ title?: string; description?: string; publishedAt?: string }>
        }

        if (!body.articles || body.articles.length === 0) {
            return '- No recent news found'
        }

        const headlines = body.articles
            .slice(0, 5)
            .map((a, i) => `  ${i + 1}. ${a.title} (${a.publishedAt?.slice(0, 10) ?? 'n/a'})`)
            .join('\n')

        return `Recent news headlines:\n${headlines}`
    } catch (err) {
        runtime.log(`News fetch failed: ${err}`)
        return '- News fetch unavailable'
    }
}
