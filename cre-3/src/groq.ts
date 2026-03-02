import { ConfidentialHTTPClient, text, type Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config'
import type { MarketInfo, ResolutionData, ResolutionResult, AiResolution } from './types'
import { CATEGORY_EVENT, CATEGORY_SOCIAL } from './config'
import { fetchNewsContext } from './external'

export const buildResolutionPrompt = (
    category: number,
    question: string,
    resolutionCriteria: string,
    dataSources: string,
    externalContext: string,
): string => {
    const categoryLabel = ['CRYPTO', 'EVENT', 'SOCIAL', 'OTHER'][category] ?? 'OTHER'

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

export const callGroqForResolution = (
    runtime: Runtime<Config>,
    prompt: string,
): AiResolution => {
    const client = new ConfidentialHTTPClient()

    const requestBody = JSON.stringify({
        model: runtime.config.groqModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
    })

    const response = client
        .sendRequest(runtime, {
            vaultDonSecrets: [{ key: 'GROQ_API_KEY' }],
            request: {
                url: 'https://api.groq.com/openai/v1/chat/completions',
                method: 'POST',
                bodyString: requestBody,
                multiHeaders: {
                    'Content-Type': { values: ['application/json'] },
                    'Authorization': { values: ['Bearer {{.GROQ_API_KEY}}'] },
                },
            },
        })
        .result()

    if (response.statusCode !== 200) {
        throw new Error(`Groq API error ${response.statusCode}: ${text(response)}`)
    }

    const groqResp = JSON.parse(text(response)) as {
        choices?: Array<{ message?: { content?: string } }>
    }

    const rawContent = groqResp.choices?.[0]?.message?.content
    if (!rawContent) {
        throw new Error('Groq response missing choices[0].message.content')
    }

    const parsed = JSON.parse(rawContent) as AiResolution
    parsed.confidence = Math.min(100, Math.max(0, Math.round(parsed.confidence)))
    return parsed
}

export const resolveWithAI = (
    runtime: Runtime<Config>,
    category: number,
    market: MarketInfo,
    resolution: ResolutionData,
): ResolutionResult => {
    // Determine search query based on category
    const newsQuery = category === CATEGORY_EVENT
        ? `event news ${market.question.slice(0, 80)}`
        : category === CATEGORY_SOCIAL
            ? `social viral trending ${market.question.slice(0, 80)}`
            : market.question.slice(0, 100)

    // Fetch news evidence
    const newsContext = fetchNewsContext(runtime, newsQuery)
    runtime.log(`News context fetched for AI resolution`)

    // Build prompt and call Groq
    const prompt = buildResolutionPrompt(
        category,
        market.question,
        resolution.resolutionCriteria,
        resolution.dataSources,
        newsContext,
    )

    const analysis = callGroqForResolution(runtime, prompt)

    runtime.log(
        `AI resolution: outcome=${analysis.outcome} confidence=${analysis.confidence}% reason="${analysis.reason}"`,
    )

    return {
        outcome: analysis.outcome,
        confidence: analysis.confidence,
        reason: analysis.reason,
    }
}
