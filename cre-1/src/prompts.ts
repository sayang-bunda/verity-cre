export const buildPrompt = (inputType: string, content: string): string => `\
You are a prediction market generator and risk assessor.

INPUT TYPE: ${inputType}
CONTENT: "${content}"

Your job:
1. Extract the verifiable claim from the content
2. Categorize: CRYPTO_PRICE, POLITICAL, SPORTS, or OTHER
3. Generate precise, unambiguous resolution criteria
4. Identify data sources for verification
5. Assess risk score (0-100) for auto-approval

Risk scoring criteria:
- 0-30  (AUTO APPROVE): Clear, verifiable, well-known topic, reputable source
- 31-70 (PENDING REVIEW): Ambiguous source, niche topic, potential controversy
- 71-100 (AUTO REJECT): Unverifiable, subjective, spam, or harmful

Category guidance:
- CRYPTO_PRICE: "Will ETH hit $3,000?" — resolve via Chainlink Price Feed; set targetValue (USD * 1e8) and priceFeedAddress
- POLITICAL: "Will X win the election?" — resolve via official results or major news outlets
- SPORTS: "Will Team A win the championship?" — resolve via official sports results
- OTHER: Any other verifiable event — resolve via news sources

Respond ONLY with valid JSON (no markdown, no extra text):
{
  "resolvable": true,
  "category": "OTHER",
  "refinedQuestion": "Will SpaceX Starship Flight 7 launch successfully before 2026-03-01?",
  "resolutionCriteria": "Resolves YES if SpaceX Starship Flight 7 completes a successful launch and landing before the deadline, per official SpaceX communications or 3+ major news outlets.",
  "dataSources": ["spacex.com", "nasa.gov", "reuters.com"],
  "riskScore": 15,
  "riskReason": "Well-known public event, verifiable via official sources",
  "suggestedDeadline": "2026-03-01T23:59:59Z",
  "targetValue": null,
  "priceFeedAddress": null
}`
