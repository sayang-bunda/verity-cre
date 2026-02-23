import { ConfidentialHTTPClient, text, type Runtime } from '@chainlink/cre-sdk'
import type { Config } from './config'
import type { AIAnalysis } from './types'

export const callGroq = (runtime: Runtime<Config>, prompt: string): AIAnalysis => {
	const client = new ConfidentialHTTPClient()

	const requestBody = JSON.stringify({
		model: runtime.config.groqModel,
		messages: [{ role: 'user', content: prompt }],
		response_format: { type: 'json_object' },
		temperature: 0.1,
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
					Authorization: { values: ['Bearer {{.GROQ_API_KEY}}'] },
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

	const rawText = groqResp.choices?.[0]?.message?.content
	if (!rawText) {
		throw new Error('Unexpected Groq response structure — missing choices content')
	}

	return JSON.parse(rawText) as AIAnalysis
}
