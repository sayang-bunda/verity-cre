import { ConfidentialHTTPClient, text, type Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config'
import { CATEGORY_POLITICAL, CATEGORY_SPORTS } from './config'
import type { AiResolution, MarketInfo, ResolutionData, ResolutionResult } from './types'


const CATEGORY_LABELS = ['CRYPTO_PRICE', 'POLITICAL', 'SPORTS', 'OTHER'] as const


/**
 * Fetch recent news from NewsAPI as evidence for AI resolution
 */
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
                    multiHeaders: { 'X-Api-Key': { values: ['{{.NEWS_API_KEY}}'] } },
                },
            })
            .result()

        if (response.statusCode !== 200) {
            runtime.log(`NewsAPI ${response.statusCode} — no news context available`)
            return '- No recent news found'
        }

        const body = JSON.parse(text(response)) as {
            articles?: Array<{ title?: string; publishedAt?: string }>
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


/**
 * Build the resolution prompt for Gemini
 */
export const buildResolutionPrompt = (
    category: number,
    question: string,
    resolutionCriteria: string,
    dataSources: string,
    externalContext: string,
): string => {
    const categoryLabel = CATEGORY_LABELS[category] ?? 'OTHER'

    return `\
You are a prediction market resolution expert.
Your task is to determine whether a prediction market question resolved YES or NO.


MARKET QUESTION:
"${question}"


CATEGORY: ${categoryLabel}


RESOLUTION CRITERIA:
${resolutionCriteria || '(no criteria specified — use your best judgment)'}


DATA SOURCES CONFIGURED:
${dataSources || '(none specified)'}


EXTERNAL EVIDENCE GATHERED:
${externalContext}


INSTRUCTIONS:
1. Analyze the evidence against the resolution criteria
2. Determine: did the event/condition described happen? (YES=1 / NO=2)
3. Assign a confidence score 0–100 based on how certain the evidence is:
   - 90–100: Very clear evidence, multiple sources agree
   - 70–89 : Evidence suggests one direction but not conclusive
   - 50–69 : Mixed signals, unclear
   - 0–49  : Insufficient evidence


IMPORTANT: If evidence is insufficient or conflicting, return low confidence (<90).
The system will ESCALATE instead of auto-resolving if confidence < 90.


Respond ONLY with valid JSON (no markdown, no extra text):
{
  "outcome": 1,
  "confidence": 85,
  "reason": "Clear explanation of why YES or NO based on the evidence",
  "evidence": ["key fact 1", "key fact 2"]
}`
}


/**
 * Call Gemini AI for resolution analysis
 */
export const callGeminiForResolution = (runtime: Runtime<Config>, prompt: string): AiResolution => {
    const client = new ConfidentialHTTPClient()

    const requestBody = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
        },
    })

    const response = client
        .sendRequest(runtime, {
            vaultDonSecrets: [{ key: 'GEMINI_API_KEY' }],
            request: {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${runtime.config.geminiModel}:generateContent?key={{.GEMINI_API_KEY}}`,
                method: 'POST',
                bodyString: requestBody,
                multiHeaders: { 'Content-Type': { values: ['application/json'] } },
            },
        })
        .result()

    if (response.statusCode !== 200) {
        throw new Error(`Gemini API error ${response.statusCode}: ${text(response)}`)
    }

    const geminiResp = JSON.parse(text(response)) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }

    const rawText = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text
    if (!rawText) {
        throw new Error('Gemini response missing candidates content')
    }

    const parsed = JSON.parse(rawText) as AiResolution
    parsed.confidence = Math.min(100, Math.max(0, Math.round(parsed.confidence)))
    return parsed
}


/**
 * Step 3b/3c — AI-powered resolution for POLITICAL, SPORTS, OTHER categories
 */
export const resolveWithAI = (
    runtime: Runtime<Config>,
    category: number,
    market: MarketInfo,
    resolution: ResolutionData,
): ResolutionResult => {
    const newsQuery = category === CATEGORY_POLITICAL
        ? `politics election ${market.question.slice(0, 80)}`
        : category === CATEGORY_SPORTS
            ? `sports ${market.question.slice(0, 80)}`
            : market.question.slice(0, 100)

    const newsContext = fetchNewsContext(runtime, newsQuery)
    runtime.log('News context fetched for AI resolution')

    const prompt = buildResolutionPrompt(
        category,
        market.question,
        resolution.resolutionCriteria,
        resolution.dataSources,
        newsContext,
    )

    const analysis = callGeminiForResolution(runtime, prompt)
    runtime.log(
        `AI resolution: outcome=${analysis.outcome} confidence=${analysis.confidence}% reason="${analysis.reason}"`,
    )

    return {
        outcome: analysis.outcome,
        confidence: analysis.confidence,
        reason: analysis.reason,
    }
}
