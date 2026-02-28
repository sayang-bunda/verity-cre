// ABI for Verity Core contract (CRE-facing functions)
// Contract address (Base Sepolia): 0x44BA2833fcaAee071CE852DC75caA47538dCd220
//
// NOTE: CRE writeReport calls onReport(bytes metadata, bytes report) on the contract.
// The `report` payload must be abi.encode(uint8 action, ...params) — NOT encodeFunctionData.
// Action routing: ACTION_CREATE_MARKET=1, ACTION_REPORT_MANIPULATION=2, ACTION_RESOLVE_MARKET=3


export const VerityCore = [
    // ─── CRE-callable functions ────────────────────────────────────────────────
    {
        inputs: [
            { internalType: 'address', name: 'creator', type: 'address' },
            { internalType: 'uint64', name: 'deadline', type: 'uint64' },
            { internalType: 'uint16', name: 'feeBps', type: 'uint16' },
            { internalType: 'uint8', name: 'category', type: 'uint8' },
            { internalType: 'string', name: 'question', type: 'string' },
            { internalType: 'string', name: 'resolutionCriteria', type: 'string' },
            { internalType: 'string', name: 'dataSources', type: 'string' },
            { internalType: 'int256', name: 'targetValue', type: 'int256' },
            { internalType: 'address', name: 'priceFeedAddress', type: 'address' },
        ],
        name: 'createMarketFromCre',
        outputs: [{ internalType: 'uint256', name: 'marketId', type: 'uint256' }],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [
            { internalType: 'uint256', name: 'marketId', type: 'uint256' },
            { internalType: 'uint8', name: 'score', type: 'uint8' },
            { internalType: 'string', name: 'reason', type: 'string' },
        ],
        name: 'reportManipulation',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [
            { internalType: 'uint256', name: 'marketId', type: 'uint256' },
            { internalType: 'uint8', name: 'outcome', type: 'uint8' },
            { internalType: 'uint8', name: 'confidence', type: 'uint8' },
        ],
        name: 'resolveMarketFromCre',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    // ─── onReport (IReceiver interface — must be implemented on contract) ───────
    {
        inputs: [
            { internalType: 'bytes', name: 'metadata', type: 'bytes' },
            { internalType: 'bytes', name: 'report', type: 'bytes' },
        ],
        name: 'onReport',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    // ─── View functions ────────────────────────────────────────────────────────
    {
        inputs: [{ internalType: 'uint256', name: 'marketId', type: 'uint256' }],
        name: 'getMarket',
        outputs: [
            {
                components: [
                    { internalType: 'address', name: 'creator', type: 'address' },
                    { internalType: 'uint64', name: 'deadline', type: 'uint64' },
                    { internalType: 'uint16', name: 'feeBps', type: 'uint16' },
                    { internalType: 'uint8', name: 'status', type: 'uint8' },
                    { internalType: 'uint8', name: 'outcome', type: 'uint8' },
                    { internalType: 'uint128', name: 'poolYes', type: 'uint128' },
                    { internalType: 'uint128', name: 'poolNo', type: 'uint128' },
                    { internalType: 'uint8', name: 'category', type: 'uint8' },
                    { internalType: 'uint8', name: 'manipulationScore', type: 'uint8' },
                    { internalType: 'uint256', name: 'totalVolume', type: 'uint256' },
                ],
                internalType: 'struct DataTypes.Market',
                name: '',
                type: 'tuple',
            },
        ],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [],
        name: 'marketCount',
        outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [{ internalType: 'uint256', name: 'marketId', type: 'uint256' }],
        name: 'getMarketQuestion',
        outputs: [{ internalType: 'string', name: '', type: 'string' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [{ internalType: 'uint256', name: 'marketId', type: 'uint256' }],
        name: 'getBettorCount',
        outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        // Returns: resolutionCriteria, dataSources, targetValue (scaled 1e8), priceFeedAddress
        inputs: [{ internalType: 'uint256', name: 'marketId', type: 'uint256' }],
        name: 'getResolutionData',
        outputs: [
            { internalType: 'string', name: 'resolutionCriteria', type: 'string' },
            { internalType: 'string', name: 'dataSources', type: 'string' },
            { internalType: 'int256', name: 'targetValue', type: 'int256' },
            { internalType: 'address', name: 'priceFeedAddress', type: 'address' },
        ],
        stateMutability: 'view',
        type: 'function',
    },
    // ─── Events ────────────────────────────────────────────────────────────────
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'uint256', name: 'marketId', type: 'uint256' },
            { indexed: true, internalType: 'address', name: 'creator', type: 'address' },
            { indexed: false, internalType: 'uint8', name: 'category', type: 'uint8' },
            { indexed: false, internalType: 'uint64', name: 'deadline', type: 'uint64' },
            { indexed: false, internalType: 'uint16', name: 'feeBps', type: 'uint16' },
            { indexed: false, internalType: 'string', name: 'question', type: 'string' },
            { indexed: false, internalType: 'string', name: 'resolutionCriteria', type: 'string' },
            { indexed: false, internalType: 'string', name: 'dataSources', type: 'string' },
        ],
        name: 'MarketCreated',
        type: 'event',
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'uint256', name: 'marketId', type: 'uint256' },
            { indexed: false, internalType: 'uint8', name: 'score', type: 'uint8' },
            { indexed: false, internalType: 'string', name: 'reason', type: 'string' },
        ],
        name: 'ManipulationDetected',
        type: 'event',
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'uint256', name: 'marketId', type: 'uint256' },
            { indexed: true, internalType: 'address', name: 'user', type: 'address' },
            { indexed: false, internalType: 'bool', name: 'isYes', type: 'bool' },
            { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
            { indexed: false, internalType: 'uint256', name: 'shares', type: 'uint256' },
            { indexed: false, internalType: 'uint256', name: 'feeAmount', type: 'uint256' },
        ],
        name: 'BetPlaced',
        type: 'event',
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'uint256', name: 'marketId', type: 'uint256' },
            { indexed: true, internalType: 'address', name: 'requester', type: 'address' },
        ],
        name: 'SettlementRequested',
        type: 'event',
    },
] as const


