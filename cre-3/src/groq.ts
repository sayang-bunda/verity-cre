import { ConfidentialHTTPClient, text, type Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config'
import type { MarketInfo, ResolutionData, ResolutionResult, AiResolution } from './types'
import { CATEGORY_SOCIAL } from './config'
import { fetchNewsContext, fetchSocialMetrics } from './external'

// ─── Prompt Builders ─────────────────────────────────────────────────────────────────────

/**
 * EVENT prompt — focuses on news cross-check, multi-source agreement, event occurrence.
 * Used for category=1 (EVENT) and category=3 (OTHER).
 */
export const buildEventPrompt = (
    question: string,
    resolutionCriteria: string,
    dataSources: string,
    newsContext: string,
): string => `\
You are a prediction market resolution expert specializing in real-world events.
Determine whether the following prediction market resolved YES or NO.

MARKET QUESTION:
"${question}"

CATEGORY: EVENT

RESOLUTION CRITERIA:
${resolutionCriteria || '(no criteria specified — use your best judgment)'}

DATA SOURCES CONFIGURED:
${dataSources || '(none specified)'}

NEWS EVIDENCE (multi-source cross-check):
${newsContext}

INSTRUCTIONS:
1. Check if the event described in the question occurred based on the news evidence
2. Cross-check: do multiple sources agree? More agreement = higher confidence
3. Determine: did the event happen? (YES=1 / NO=2)
4. Assign confidence 0–100:
   - 95–100: Multiple reputable sources explicitly confirm/deny the event
   - 80–94 : Clear evidence from 1–2 sources, no contradictions
   - 60–79 : Evidence leans one way but has gaps or ambiguity
   - 0–59  : Insufficient, conflicting, or unclear evidence

IMPORTANT: If evidence is insufficient or conflicting, return low confidence (<90).
The system will ESCALATE instead of auto-resolving if confidence < 90.

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "outcome": 1,
  "confidence": 95,
  "reason": "Clear explanation based on news evidence",
  "evidence": ["source 1 confirms X", "source 2 also reports X"]
}`

/**
 * SOCIAL prompt — focuses on engagement metrics, viral signals, social platform evidence.
 * Used for category=2 (SOCIAL).
 */
export const buildSocialPrompt = (
    question: string,
    resolutionCriteria: string,
    dataSources: string,
    socialContext: string,
): string => `\
You are a prediction market resolution expert specializing in social media and viral events.
Determine whether the following prediction market resolved YES or NO.

MARKET QUESTION:
"${question}"

CATEGORY: SOCIAL

RESOLUTION CRITERIA:
${resolutionCriteria || '(no criteria specified — use your best judgment)'}

DATA SOURCES CONFIGURED:
${dataSources || '(none specified)'}

SOCIAL/VIRAL EVIDENCE:
${socialContext}

INSTRUCTIONS:
1. Check if the social/viral metric described in the question was achieved
2. Look for: mention counts, viral spread, influencer confirmation, platform metrics
3. Determine: did the social condition resolve? (YES=1 / NO=2)
4. Assign confidence 0–100:
   - 95–100: Unambiguous evidence the metric was clearly reached or clearly not reached
   - 80–94 : Strong signals pointing one direction, minor uncertainty
   - 60–79 : Mixed signals or social evidence is indirect
   - 0–59  : Insufficient or unverifiable social evidence

IMPORTANT: Social markets are harder to verify objectively.
If evidence is insufficient or conflicting, return low confidence (<90).
The system will ESCALATE instead of auto-resolving if confidence < 90.

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "outcome": 1,
  "confidence": 85,
  "reason": "Clear explanation based on social signals",
  "evidence": ["trending signal 1", "viral metric 2"]
}`

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
    parsed.evidenceUrls = parsed.evidenceUrls ?? []
    return parsed
}

export const resolveWithAI = (
    runtime: Runtime<Config>,
    category: number,
    market: MarketInfo,
    resolution: ResolutionData,
): ResolutionResult => {
    let contextText: string
    let contextUrls: string[]
    let prompt: string

    if (category === CATEGORY_SOCIAL) {
        // SOCIAL: fetch viral/engagement signals, use social-specific prompt
        const socialQuery = market.question.slice(0, 80)
        runtime.log(`Branch: SOCIAL — fetching social/viral metrics for "${socialQuery.slice(0, 50)}..."`)
        const social = fetchSocialMetrics(runtime, socialQuery)
        contextText = social.text
        contextUrls = social.urls
        runtime.log(`Social context fetched: ${contextText.slice(0, 80)}...`)
        prompt = buildSocialPrompt(
            market.question,
            resolution.resolutionCriteria,
            resolution.dataSources,
            contextText,
        )
    } else {
        // EVENT / OTHER: fetch news, use event-specific prompt
        const newsQuery = `event news ${market.question.slice(0, 80)}`
        runtime.log(`Branch: EVENT/OTHER — fetching news context for "${newsQuery.slice(0, 50)}..."`)
        const news = fetchNewsContext(runtime, newsQuery)
        contextText = news.text
        contextUrls = news.urls
        runtime.log(`News context fetched: ${contextText.slice(0, 80)}...`)
        prompt = buildEventPrompt(
            market.question,
            resolution.resolutionCriteria,
            resolution.dataSources,
            contextText,
        )
    }

    const analysis = callGroqForResolution(runtime, prompt)

    runtime.log(
        `AI resolution: outcome=${analysis.outcome} confidence=${analysis.confidence}% urls=[${contextUrls.slice(0, 2).join(', ')}]`,
    )

    return {
        outcome: analysis.outcome,
        confidence: analysis.confidence,
        reason: analysis.reason,
        evidenceUrls: contextUrls,
    }
}
