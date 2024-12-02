const express = require('express');
const fetch = require('node-fetch');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const BigNumber = require('bignumber.js');
const { isWhitelisted } = require('./utils/whitelist');

const router = express.Router();

// Constants
const USAGE_FEE = 100; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

// Helper Functions
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

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
            console.error(`Error fetching transaction ${txHash}: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw new Error(`Transaction ${txHash} status could not be determined after ${retries} retries.`);
};

const sendUsageFee = async (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(TREASURY_WALLET);
    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;
    const decimals = await getTokenDecimals(REWARD_TOKEN);
    const convertedAmount = convertAmountToBlockchainValue(USAGE_FEE, decimals);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: REWARD_TOKEN }),
                amount: BigInt(convertedAmount),
            }),
        ],
    });

    tx.nonce = nonce;
    tx.gasLimit = BigInt(500000);

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    const status = await checkTransactionStatus(txHash.toString());
    if (status.status !== "success") {
        throw new Error('UsageFee transaction failed. Ensure sufficient REWARD tokens are available.');
    }
    return txHash.toString();
};

const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = req.body.walletPem;
        const signer = UserSigner.fromPem(pemContent);
        const walletAddress = signer.getAddress().toString();

        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next();
            return;
        }

        const txHash = await sendUsageFee(pemContent);
        req.usageFeeHash = txHash;
        next();
    } catch (error) {
        console.error('Error processing UsageFee:', error.message);
        res.status(400).json({ error: error.message });
    }
};

// **Endpoints**

// 1. EGLD Transfer
const sendEgld = async (pemContent, recipient, amount) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);
    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const amountInWEI = BigInt(new BigNumber(amount).multipliedBy(new BigNumber(10).pow(18)).toFixed(0));

    const tx = new Transaction({
        nonce,
        sender: senderAddress,
        receiver: receiverAddress,
        value: amountInWEI,
        gasLimit: BigInt(50000),
        data: new TransactionPayload(""),
        chainID: "1",
    });

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

router.post('/egldTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = req.body.walletPem;

        const result = await sendEgld(pemContent, recipient, amount);
        res.json({ message: "EGLD transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing EGLD transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. ESDT Transfer
router.post('/esdtTransfer', handleUsageFee, async (req, res) => {
    try {
        // Extract parameters from request body
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = req.body.walletPem;

        // Input validation
        if (!recipient || typeof recipient !== 'string') {
            return res.status(400).json({ error: 'Invalid or missing recipient address.' });
        }
        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Invalid or missing amount. It must be a positive number.' });
        }
        if (!tokenTicker || typeof tokenTicker !== 'string') {
            return res.status(400).json({ error: 'Invalid or missing token ticker.' });
        }

        // Fetch token decimals for precise amount conversion
        const decimals = await getTokenDecimals(tokenTicker);
        const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);

        // Set up sender and receiver addresses
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        // Fetch sender's account nonce from the network
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        // Create ESDT transaction
        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker }),
                    amount: BigInt(adjustedAmount),
                }),
            ],
        });

        tx.nonce = nonce;
        tx.gasLimit = BigInt(500000); // Base gas limit for ESDT transfers

        // Sign and send the transaction
        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Check transaction status
        const result = await checkTransactionStatus(txHash.toString());

        // Return successful response
        res.json({
            message: 'ESDT transfer executed successfully.',
            usageFeeHash: req.usageFeeHash,
            result,
        });
    } catch (error) {
        console.error('Error executing ESDT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 3. NFT Transfer
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: tokenIdentifier, nonce: BigInt(tokenNonce) }),
                amount: BigInt(1), // Fixed amount for NFTs
            }),
        ],
    });

    tx.nonce = nonce;
    tx.gasLimit = BigInt(15000000); // Standard gas for NFT transfers

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

router.post('/nftTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = req.body.walletPem;

        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);
        res.json({ message: "NFT transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing NFT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. SFT Transfer
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, tokenNonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const adjustedAmount = BigInt(amount);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: tokenTicker, nonce: BigInt(tokenNonce) }),
                amount: adjustedAmount,
            }),
        ],
    });

    tx.nonce = nonce;
    tx.gasLimit = BigInt(500000 + amount * 500000); // Dynamic gas based on quantity

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

router.post('/sftTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = req.body.walletPem;

        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
        res.json({ message: "SFT transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing SFT transfer:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 5. Free NFT Mint Airdrop
const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();

    const receiverAddress = new Address(receiver);
    const receiverHex = receiverAddress.hex();
    const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
    const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const tx = new Transaction({
        nonce,
        sender: senderAddress,
        receiver: new Address(scAddress),
        value: '0',
        gasLimit: BigInt(10000000), // Default gas limit for airdrop
        data: new TransactionPayload(dataField),
        chainID: "1",
    });

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

router.post('/freeNftMintAirdrop', handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = req.body.walletPem;

        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
        res.json({ message: "Free NFT mint airdrop executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 6. ESDT Airdrop to NFT Owners
router.post('/distributeRewardsToNftOwners', async (req, res) => {
    try {
        const pemContent = req.body.walletPem;
        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply } = req.body;

        // Validate inputs
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

        // Helper function to create a transaction
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

        // Step 1: Sign and send all transactions in parallel batches
        for (let i = 0; i < uniqueOwnerStats.length; i += 3) {
            const batch = uniqueOwnerStats.slice(i, i + 3);
            const batchPromises = batch.map((ownerData, index) => {
                const tx = createTransaction(
                    ownerData.owner,
                    ownerData.tokensCount,
                    currentNonce + i + index
                );

                return signer.sign(tx).then(async () => {
                    const txHash = await provider.sendTransaction(tx);
                    return { owner: ownerData.owner, txHash: txHash.toString() };
                }).catch(error => ({
                    owner: ownerData.owner,
                    error: error.message,
                    status: "failed"
                }));
            });

            // Process batch
            const batchResults = await Promise.all(batchPromises);
            txHashes.push(...batchResults);

            // Throttle to 3 transactions per second
            if (i + 3 < uniqueOwnerStats.length) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay for next batch
            }
        }

        // Step 2: Poll for transaction statuses in parallel after all transactions are sent
        const statusPromises = txHashes.map(({ owner, txHash }) =>
            checkTransactionStatus(txHash)
                .then(status => ({ owner, txHash, status: status.status }))
                .catch(error => ({ owner, txHash, error: error.message, status: 'failed' }))
        );
        const statusResults = await Promise.all(statusPromises);

        // Return transaction results with UsageFee hash
        res.json({
            message: 'Rewards distribution completed.',
            usageFeeHash: req.usageFeeHash, // Include the UsageFee transaction hash
            results: statusResults, // Existing results from the rewards distribution
        });
    } catch (error) {
        console.error('Error during rewards distribution:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
