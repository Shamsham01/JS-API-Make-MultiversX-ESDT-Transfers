const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const {
    Address,
    Token,
    TokenTransfer,
    TransferTransactionsFactory,
    TransactionsFactoryConfig,
    Transaction,
    TransactionPayload,
} = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const BigNumber = require('bignumber.js');

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn";
const USAGE_FEE = 100;
const TOKEN_TICKER = "REWARD-cf6eac";

const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

app.use(bodyParser.json());

// Middleware to check authorization token
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Helper: Get PEM content from request
const getPemContent = (req) => {
    const pemContent = req.body.walletPem;
    if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Invalid PEM content');
    }
    return pemContent;
};

// Helper: Calculate gas limit for ESDT transfers
const calculateEsdtGasLimit = () => BigInt(500000);

// Helper: Fetch token decimals
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`Failed to fetch token info: ${response.statusText}`);
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

// Helper: Convert amounts to blockchain value
const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

// Helper: Fetch user token balances
const fetchUserTokenBalances = async (address) => {
    const apiUrl = `https://api.multiversx.com/accounts/${address}/tokens`;
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`Failed to fetch token balances: ${response.statusText}`);
    return await response.json();
};

// Helper: Check if user has enough REWARD tokens
const hasEnoughRewardTokens = async (address) => {
    const balances = await fetchUserTokenBalances(address);
    const rewardToken = balances.find((token) => token.identifier === TOKEN_TICKER);
    if (!rewardToken || new BigNumber(rewardToken.balance).isLessThan(USAGE_FEE * Math.pow(10, rewardToken.decimals))) {
        return false;
    }
    return true;
};

// Helper: Send usage fee
const sendUsageFee = async (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(TREASURY_WALLET);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const decimals = await getTokenDecimals(TOKEN_TICKER);
    const convertedAmount = convertAmountToBlockchainValue(USAGE_FEE, decimals);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: TOKEN_TICKER }),
                amount: BigInt(convertedAmount),
            }),
        ],
    });

    tx.nonce = nonce;
    tx.gasLimit = calculateEsdtGasLimit();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return txHash.toString();
};

// Middleware: Handle usage fee
const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = UserSigner.fromPem(pemContent).getAddress().toString();

        if (!(await hasEnoughRewardTokens(walletAddress))) {
            return res.status(400).json({ error: 'Insufficient REWARD tokens. You need at least 100 REWARD tokens to use this module.' });
        }

        const usageFeeHash = await sendUsageFee(pemContent);
        req.usageFeeHash = usageFeeHash;
        next();
    } catch (error) {
        console.error('Error handling usage fee:', error.message);
        res.status(500).json({ error: error.message });
    }
};

// Transaction confirmation logic (polling)
const checkTransactionStatus = async (txHash, retries = 20, delay = 4000) => {
    const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(txStatusUrl);
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            const txStatus = await response.json();
            if (txStatus.status === "success") return { status: "success", txHash };
            if (txStatus.status === "fail") return { status: "fail", txHash };
        } catch (error) {
            console.error(`Error checking transaction ${txHash}: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw new Error(`Transaction ${txHash} status could not be determined after ${retries} retries.`);
};

// ------------------- Endpoints ------------------- //
// Authorization endpoint
app.post('/execute/authorize', checkToken, (req, res) => {
    try {
        const pemContent = getPemContent(req);
        res.json({ message: "Authorization Successful" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// EGLD Transfer endpoint
app.post('/execute/egldTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = getPemContent(req);

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const amountInWEI = new BigNumber(amount).multipliedBy(10 ** 18).toFixed(0);

        const tx = new Transaction({
            nonce: senderNonce,
            receiver: receiverAddress,
            sender: senderAddress,
            value: amountInWEI,
            gasLimit: BigInt(50000),
            chainID: "1",
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        const result = await checkTransactionStatus(txHash.toString());

        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing EGLD transfer:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- NFT Transfer Logic --------------- //
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const senderNonce = accountOnNetwork.nonce;

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: tokenIdentifier, nonce: BigInt(tokenNonce) }),
                amount: BigInt(1), // Always transfer 1 NFT
            }),
        ],
    });

    tx.nonce = senderNonce;
    tx.gasLimit = calculateEsdtGasLimit();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

app.post('/execute/nftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);
        res.json({
            result,
            usageFeeHash: req.usageFeeHash,
        });
    } catch (error) {
        console.error('Error executing NFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- SFT Transfer Logic --------------- //
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, nonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const accountNonce = accountOnNetwork.nonce;

    const adjustedAmount = BigInt(amount);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: tokenTicker, nonce: BigInt(nonce) }),
                amount: adjustedAmount,
            }),
        ],
    });

    tx.nonce = accountNonce;
    tx.gasLimit = calculateEsdtGasLimit();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

app.post('/execute/sftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
        res.json({
            result,
            usageFeeHash: req.usageFeeHash,
        });
    } catch (error) {
        console.error('Error executing SFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- Rewards Distribution to NFT Owners --------------- //
app.post('/execute/distributeRewardsToNftOwners', checkToken, handleUsageFee, async (req, res) => {
    try {
        const pemContent = getPemContent(req);
        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply } = req.body;

        if (!uniqueOwnerStats || !Array.isArray(uniqueOwnerStats)) {
            return res.status(400).json({ error: 'Invalid owner stats provided.' });
        }
        if (!tokenTicker || !baseAmount) {
            return res.status(400).json({ error: 'Token ticker and base amount are required.' });
        }

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const accountOnNetwork = await provider.getAccount(senderAddress);
        let currentNonce = accountOnNetwork.nonce;

        const decimals = await getTokenDecimals(tokenTicker);
        const multiplierEnabled = multiply === "yes";

        const txHashes = [];

        const createTransaction = (owner, tokensCount, nonce) => {
            const adjustedAmount = multiplierEnabled
                ? convertAmountToBlockchainValue(baseAmount * tokensCount, decimals)
                : convertAmountToBlockchainValue(baseAmount, decimals);

            const receiverAddress = new Address(owner);
            const tokenTransfer = new TokenTransfer({
                token: new Token({ identifier: tokenTicker }),
                amount: BigInt(adjustedAmount),
            });

            const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
            const factory = new TransferTransactionsFactory({ config: factoryConfig });

            const tx = factory.createTransactionForESDTTokenTransfer({
                sender: senderAddress,
                receiver: receiverAddress,
                tokenTransfers: [tokenTransfer],
            });

            tx.nonce = nonce;
            tx.gasLimit = calculateEsdtGasLimit();

            return tx;
        };

        for (let i = 0; i < uniqueOwnerStats.length; i += 3) {
            const batch = uniqueOwnerStats.slice(i, i + 3);
            const batchPromises = batch.map((ownerData, index) => {
                const tx = createTransaction(
                    ownerData.owner,
                    ownerData.tokensCount,
                    currentNonce + index,
                );

                return signer.sign(tx).then(async () => {
                    const txHash = await provider.sendTransaction(tx);
                    return { owner: ownerData.owner, txHash: txHash.toString() };
                }).catch(error => ({
                    owner: ownerData.owner,
                    error: error.message,
                    status: "failed",
                }));
            });

            const batchResults = await Promise.all(batchPromises);
            txHashes.push(...batchResults);

            if (i + 3 < uniqueOwnerStats.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const statusPromises = txHashes.map(({ owner, txHash }) =>
            checkTransactionStatus(txHash)
                .then(status => ({ owner, txHash, status: status.status }))
                .catch(error => ({ owner, txHash, error: error.message, status: 'failed' }))
        );

        const statusResults = await Promise.all(statusPromises);

        res.json({
            message: 'Rewards distribution completed.',
            usageFeeHash: req.usageFeeHash,
            results: statusResults,
        });
    } catch (error) {
        console.error('Error during rewards distribution:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// --------------- NFT Free Mint Airdrop --------------- //
const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();

    const receiverAddress = new Address(receiver);
    const dataField = `${endpoint}@${receiverAddress.hex()}@${toHex(qty)}`;

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const senderNonce = accountOnNetwork.nonce;

    const tx = new Transaction({
        nonce: senderNonce,
        receiver: new Address(scAddress),
        sender: senderAddress,
        value: '0',
        gasLimit: BigInt(10000000),
        data: new TransactionPayload(dataField),
        chainID: '1',
    });

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

app.post('/execute/freeNftMintAirdrop', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = getPemContent(req);

        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
