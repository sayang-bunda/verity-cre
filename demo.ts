import { createWalletClient, createPublicClient, http, parseAbi, parseUnits, decodeEventLog } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { writeFileSync } from 'fs'

const PRIVATE_KEY             = '0x322ba80cd878d0a923045fc0ae2a3c8a07dfc19b7685912647ee16b0038182bf'
const VERITY_CORE             = '0x357E246B17bEF83BE4eA3321cBCA1BB642D17150'
const MOCK_USDC               = '0x9643419d69363278Bf74aA1494c3394aBF9E25da'
const MOCK_KEYSTONE_FORWARDER = '0x4aa01B2E8900EAfF69f761e0D9a2b58570F242F3'
const QUESTION                = 'Will ETH price reach $5000 before end of the month?'

const account      = privateKeyToAccount(PRIVATE_KEY)
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http('https://sepolia.base.org') })
const publicClient = createPublicClient({ chain: baseSepolia, transport: http('https://sepolia.base.org') })

// Ensure MockKeystoneForwarder points to the current Verity address
console.log('[0/2] Syncing MockKeystoneForwarder → Verity...')
const currentVerity = await publicClient.readContract({
    address: MOCK_KEYSTONE_FORWARDER,
    abi: parseAbi(['function verity() view returns (address)']),
    functionName: 'verity',
}) as `0x${string}`
if (currentVerity.toLowerCase() !== VERITY_CORE.toLowerCase()) {
    const setVerityTx = await walletClient.writeContract({
        address: MOCK_KEYSTONE_FORWARDER,
        abi: parseAbi(['function setVerity(address)']),
        functionName: 'setVerity',
        args: [VERITY_CORE],
    })
    await publicClient.waitForTransactionReceipt({ hash: setVerityTx })
    console.log(`      setVerity done — ${setVerityTx}`)
} else {
    console.log('      Already pointing to correct Verity, skip.')
}

console.log('\n[1/2] Approving 5 USDC...')
const approveTx = await walletClient.writeContract({
    address: MOCK_USDC,
    abi: parseAbi(['function approve(address,uint256) returns (bool)']),
    functionName: 'approve',
    args: [VERITY_CORE, parseUnits('5', 6)],
})
await publicClient.waitForTransactionReceipt({ hash: approveTx })
console.log(`      OK — ${approveTx}`)

console.log('\n[2/2] Proposing market...')
const proposeTx = await walletClient.writeContract({
    address: VERITY_CORE,
    abi: parseAbi(['function proposeMarket(string) returns (uint256)']),
    functionName: 'proposeMarket',
    args: [JSON.stringify({ question: QUESTION })],
})
const rec = await publicClient.waitForTransactionReceipt({ hash: proposeTx })
console.log(`      OK — ${proposeTx}`)

const logsAbi = parseAbi(['event MarketProposed(uint256 indexed proposalId, address indexed creator, string payloadJSON)'])
let proposalId: string | null = null
for (const log of rec.logs) {
    try {
        const parsed = decodeEventLog({ abi: logsAbi, data: log.data, topics: log.topics })
        if (parsed.eventName === 'MarketProposed') {
            proposalId = (parsed.args as any).proposalId.toString()
            break
        }
    } catch (_) {}
}
if (!proposalId) { console.error('Could not parse MarketProposed event'); process.exit(1) }

const payload = { creator: account.address, proposalId, inputType: 'manual', question: QUESTION }
writeFileSync('./payload.json', JSON.stringify(payload, null, 4))

console.log(`\nproposalId: ${proposalId}`)
console.log('\nSekarang jalankan CRE:')
console.log('  cre workflow simulate ./cre-1 -T staging-settings --broadcast')
console.log('\nKetika muncul prompt, paste ini:')
console.log(`  ${JSON.stringify(payload)}`)
