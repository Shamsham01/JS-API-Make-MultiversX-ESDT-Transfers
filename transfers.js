const express = require('express');
const { Address, Transaction, TransactionPayload } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { isWhitelisted } = require('./utils/whitelist');
const { getTokenDecimals, convertAmountToBlockchainValue } = require('./utils/tokens');
const { checkTransactionStatus, createEsdtTransferPayload, calculateEsdtGasLimit } = require('./utils/transactions');

const router = express.Router();

// Constants
const USAGE_FEE = process.env.USAGE_FEE || 100; // Fee in REWARD tokens
const REWARD_TOKEN = process.env.REWARD_TOKEN || "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = process.env.TREASURY_WALLET || "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const provider = new ProxyNetworkProvider(process.env.GATEWAY_URL || "https://gateway.multiversx.com", { clientName: "javascript-api" });
const BATCH_SIZE = process.env.BATCH_SIZE || 3; // Transactions per batch
const BATCH_DELAY_MS = process.env.BATCH_DELAY_MS || 1000; // Delay between batches
const CHAIN_ID = process.env.CHAIN_ID || "1"; // Retrieve from environment variables, default to Mainnet

// Middleware to handle the usage fee
const sendUsageFee = async (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(TREASURY_WALLET);
    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;
    const decimals = await getTokenDecimals(REWARD_TOKEN);
    const convertedAmount = convertAmountToBlockchainValue(USAGE_FEE, decimals);

    const payload = createEsdtTransferPayload(REWARD_TOKEN, convertedAmount);

    const tx = new Transaction({
        nonce,
        sender: senderAddress,
        receiver: receiverAddress,
        value: '0',
        gasLimit: BigInt(500000),
        data: new TransactionPayload(payload),
        chainID: CHAIN_ID,
    });

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
router.post('/egldTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = req.body.walletPem;

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
            chainID: CHAIN_ID,
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const result = await checkTransactionStatus(txHash.toString());

        res.json({ message: "EGLD transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing EGLD transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});


// 2. ESDT Transfer
router.post('/esdtTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !amount || !tokenTicker) {
            return res.status(400).json({ error: 'Missing required parameters: recipient, amount, tokenTicker.' });
        }

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const decimals = await getTokenDecimals(tokenTicker);
        const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        const payload = createEsdtTransferPayload(tokenTicker, adjustedAmount);

        const tx = new Transaction({
            nonce,
            sender: senderAddress,
            receiver: receiverAddress,
            value: '0',
            gasLimit: calculateEsdtGasLimit(),
            data: new TransactionPayload(payload),
            chainID: CHAIN_ID,
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const result = await checkTransactionStatus(txHash.toString());

        res.json({ message: "ESDT transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing ESDT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 3. NFT Transfer
router.post('/nftTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !tokenIdentifier || tokenNonce === undefined) {
            return res.status(400).json({ error: 'Missing required parameters: recipient, tokenIdentifier, tokenNonce.' });
        }

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        const payload = createEsdtTransferPayload(tokenIdentifier, "1");

        const tx = new Transaction({
            nonce,
            sender: senderAddress,
            receiver: receiverAddress,
            value: '0',
            gasLimit: calculateEsdtGasLimit(),
            data: new TransactionPayload(payload),
            chainID: CHAIN_ID,
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const result = await checkTransactionStatus(txHash.toString());

        res.json({ message: "NFT transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing NFT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. SFT Transfer
router.post('/sftTransfer', handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = req.body.walletPem;

        if (!recipient || !amount || !tokenTicker || tokenNonce === undefined) {
            return res.status(400).json({ error: 'Missing required parameters: recipient, amount, tokenTicker, tokenNonce.' });
        }

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        const payload = createEsdtTransferPayload(tokenTicker, amount);

        const tx = new Transaction({
            nonce,
            sender: senderAddress,
            receiver: receiverAddress,
            value: '0',
            gasLimit: calculateEsdtGasLimit(),
            data: new TransactionPayload(payload),
            chainID: CHAIN_ID,
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const result = await checkTransactionStatus(txHash.toString());

        res.json({ message: "SFT transfer executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing SFT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 5. Free NFT Mint Airdrop
router.post('/freeNftMintAirdrop', handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = req.body.walletPem;

        if (!scAddress || !endpoint || !receiver || qty === undefined) {
            return res.status(400).json({ error: 'Missing required parameters: scAddress, endpoint, receiver, qty.' });
        }

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const receiverHex = new Address(receiver).hex();
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        const tx = new Transaction({
            nonce,
            sender: senderAddress,
            receiver: new Address(scAddress),
            value: '0',
            gasLimit: BigInt(10000000),
            data: new TransactionPayload(dataField),
            chainID: CHAIN_ID,
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const result = await checkTransactionStatus(txHash.toString());

        res.json({ message: "Free NFT mint airdrop executed successfully.", usageFeeHash: req.usageFeeHash, result });
    } catch (error) {
        console.error('Error executing Free NFT Mint Airdrop transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 6. ESDT Airdrop to NFT Owners
router.post('/distributeRewardsToNftOwners', async (req, res) => {
    try {
        const pemContent = req.body.walletPem;
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

        for (let i = 0; i < uniqueOwnerStats.length; i += BATCH_SIZE) {
            const batch = uniqueOwnerStats.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (ownerData, index) => {
                try {
                    const tokensCount = ownerData.tokensCount;
                    const adjustedAmount = multiplierEnabled
                        ? convertAmountToBlockchainValue(baseAmount * tokensCount, decimals)
                        : convertAmountToBlockchainValue(baseAmount, decimals);

                    const receiverAddress = new Address(ownerData.owner);
                    const payload = createEsdtTransferPayload(tokenTicker, adjustedAmount);

                    const tx = new Transaction({
                        nonce: currentNonce + index,
                        sender: senderAddress,
                        receiver: receiverAddress,
                        value: '0',
                        gasLimit: calculateEsdtGasLimit(),
                        data: new TransactionPayload(payload),
                        chainID: CHAIN_ID,
                    });

                    await signer.sign(tx);
                    const txHash = await provider.sendTransaction(tx);
                    return { owner: ownerData.owner, txHash: txHash.toString() };
                } catch (error) {
                    console.error(`Error processing transaction for ${ownerData.owner}:`, error.message);
                    return { owner: ownerData.owner, error: error.message, status: 'failed' };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            txHashes.push(...batchResults);

            if (i + BATCH_SIZE < uniqueOwnerStats.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
            }
            currentNonce += batch.length;
        }

        const statusResults = await Promise.all(
            txHashes.map(({ owner, txHash }) =>
                checkTransactionStatus(txHash)
                    .then(status => ({ owner, txHash, status: status.status }))
                    .catch(error => ({ owner, txHash, error: error.message, status: 'failed' }))
            )
        );

        res.json({
            message: 'Rewards distribution completed.',
            results: statusResults,
        });
    } catch (error) {
        console.error('Error during rewards distribution:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
