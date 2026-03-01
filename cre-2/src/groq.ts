import { ConfidentialHTTPClient, text, type Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config'
import type { AiAnalysis, BetInfo, MarketData } from './types'

const CATEGORY_NAMES = ['CRYPTO', 'EVENT', 'SOCIAL', 'OTHER'] as const

const formatEth = (wei: bigint): string => `${(Number(wei) / 1e18).toFixed(4)} ETH`

/**
 * Step 4 — Build AI prompt for manipulation detection
 */
export const buildAnalysisPrompt = (
    bet: BetInfo,
    market: MarketData,
    newsContext: string,
    priceContext: string,
    scheduledEvents: string,
): string => {
    const totalPool = market.poolYes + market.poolNo
    const yesPrice = totalPool > 0n
        ? Number((market.poolNo * 10000n) / totalPool) / 100
        : 50

    const volumeMultiple = market.totalVolume > 0n
        ? Number((bet.amount * 100n) / market.totalVolume) / 100
        : 999

    const bettorContext = market.bettorCount <= 1n
        ? 'first time in this market'
        : `market has ${market.bettorCount} bettors`

    return `You are a prediction market manipulation detector for an on-chain prediction market protocol.

MARKET CONTEXT:
- Question: "${market.question}"
- Market ID: ${bet.marketId.toString()}
- Category: ${CATEGORY_NAMES[market.category] ?? 'OTHER'}
- Current YES price: ${yesPrice.toFixed(1)}%
- Pool sizes: YES=${formatEth(market.poolYes)} / NO=${formatEth(market.poolNo)}
- Total volume: ${formatEth(market.totalVolume)}
- Bettors: ${market.bettorCount.toString()}
- Deadline: ${new Date(Number(market.deadline) * 1000).toISOString()}
- Current manipulation score: ${market.manipulationScore}/100

THIS BET:
- Amount: ${formatEth(bet.amount)} (${volumeMultiple.toFixed(1)}x total volume)
- Direction: ${bet.isYes ? 'YES' : 'NO'}
- Bettor: ${bettorContext}

EXTERNAL CONTEXT:
${newsContext}
${market.category === 0 ? `- Current price: ${priceContext}` : ''}
${scheduledEvents}

Analyse this bet for potential manipulation. Consider:
1. Volume spike: Is this bet disproportionately large vs total volume?
2. Price impact: Does this bet drastically move the price?
3. Timing: Is this suspiciously close to deadline with no supporting evidence?
4. Information asymmetry: Is there news that would justify this bet?
5. Wash trading patterns: Is the bettor acting suspiciously?

Score 0-100:
- 0-30: Normal trading activity, no concern
- 31-80: Suspicious but not conclusive, worth monitoring
- 81-100: Highly likely manipulation, market should be paused

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "manipulationScore": 25,
  "reason": "Brief explanation of the assessment",
  "patterns_matched": ["volume_spike", "no_news_support"],
  "recommendation": "safe"
}`
}

/**
 * Step 4 — AI Analysis via Confidential HTTP (Groq)
 * Groq uses OpenAI-compatible API format
 */
export const callGroqAI = (runtime: Runtime<Config>, prompt: string): AiAnalysis => {
    const client = new ConfidentialHTTPClient()

    const requestBody = JSON.stringify({
        model: runtime.config.groqModel,
        messages: [
            {
                role: 'user',
                content: prompt,
            },
        ],
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

    return JSON.parse(rawContent) as AiAnalysis
}
