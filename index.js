const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload, UserSigner } = require('@multiversx/sdk-core');
const { ApiNetworkProvider } = require('@multiversx/sdk-network-providers'); // Corrected import
const BigNumber = require('bignumber.js');

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;  // Secure Token for authorization
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;  // Admin Token for whitelist management
const USAGE_FEE = 100; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const WEBHOOK_WHITELIST_URL = "https://hook.eu2.make.com/mvi4kvg6arzxrxd5462f6nh2yqq1p5ot"; // Your Make webhook URL

// Updated SDK provider for v13
const provider = new ApiNetworkProvider("https://gateway.multiversx.com", { clientName: "multiversx-app" });

const whitelistFilePath = path.join(__dirname, 'whitelist.json');

// Middleware to check admin authorization token
const checkAdminToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${ADMIN_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Invalid Admin Token' });
    }
};

// Load the whitelist file
const loadWhitelist = () => {
    if (!fs.existsSync(whitelistFilePath)) {
        fs.writeFileSync(whitelistFilePath, JSON.stringify([], null, 2));
    }
    const data = fs.readFileSync(whitelistFilePath);
    return JSON.parse(data);
};

// Check if a wallet is whitelisted
const isWhitelisted = (walletAddress) => {
    const whitelist = loadWhitelist();
    return whitelist.some(entry => entry.walletAddress === walletAddress);
};

const saveWhitelist = (whitelist) => {
    fs.writeFileSync(whitelistFilePath, JSON.stringify(whitelist, null, 2));
};

// Middleware to check authorization token
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Function to validate and return the PEM content from the request body
const getPemContent = (req) => {
    const pemContent = req.body.walletPem;
    if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Invalid PEM content');
    }
    return pemContent;
};

// Helper to derive wallet address from PEM
const deriveWalletAddressFromPem = (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    return signer.getAddress().bech32(); // Use bech32 representation
};

// Function to send webhook updates for whitelist changes
const sendWebhookUpdate = async (whitelist) => {
    try {
        const encodedContent = Buffer.from(JSON.stringify(whitelist)).toString('base64');
        const response = await fetch(WEBHOOK_WHITELIST_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: "Updated whitelist via API",
                content: encodedContent
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to send webhook update');
        }

        console.log('Webhook update sent successfully');
        return true;
    } catch (error) {
        console.error('Error sending webhook update:', error.message);
        throw error;
    }
};

// Route to add a wallet address to the whitelist
app.post('/admin/addToWhitelist', checkAdminToken, async (req, res) => {
    try {
        const { walletAddress, label, whitelistStart } = req.body;

        if (!walletAddress || !label || !whitelistStart) {
            return res.status(400).json({ error: 'Invalid data. walletAddress, label, and whitelistStart are required.' });
        }

        const whitelist = loadWhitelist();
        const existingWallet = whitelist.find(entry => entry.walletAddress === walletAddress);

        if (existingWallet) {
            return res.status(400).json({ error: 'Wallet address is already whitelisted.' });
        }

        // Add new entry to whitelist
        const newEntry = { walletAddress, label, whitelistStart };
        whitelist.push(newEntry);
        saveWhitelist(whitelist);

        // Trigger webhook with updated whitelist
        await sendWebhookUpdate(whitelist);

        res.json({ message: 'Wallet added to whitelist and webhook triggered successfully.' });
    } catch (error) {
        console.error('Error adding to whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Route to remove a wallet address from the whitelist
app.delete('/admin/removeFromWhitelist', checkAdminToken, async (req, res) => {
    try {
        const { walletAddress } = req.body;

        if (!walletAddress) {
            return res.status(400).json({ error: 'walletAddress is required.' });
        }

        const whitelist = loadWhitelist();
        const updatedWhitelist = whitelist.filter(entry => entry.walletAddress !== walletAddress);

        if (whitelist.length === updatedWhitelist.length) {
            return res.status(404).json({ error: 'Wallet address not found in whitelist.' });
        }

        saveWhitelist(updatedWhitelist);

        // Trigger webhook with updated whitelist
        await sendWebhookUpdate(updatedWhitelist);

        res.json({ message: 'Wallet removed from whitelist and webhook triggered successfully.' });
    } catch (error) {
        console.error('Error removing from whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Route to fetch the current whitelist
app.get('/admin/getWhitelist', checkAdminToken, (req, res) => {
    try {
        const whitelist = loadWhitelist();
        res.json({ whitelist });
    } catch (error) {
        console.error('Error fetching whitelist:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// File path for storing user activity logs
const usersFilePath = path.join(__dirname, 'users.json');

// Helper to log user activity
const logUserActivity = (walletAddress) => {
    const currentDate = new Date().toISOString();

    // Load existing users
    let usersData = [];
    if (fs.existsSync(usersFilePath)) {
        const rawData = fs.readFileSync(usersFilePath);
        usersData = JSON.parse(rawData);
    }

    // Append the new activity
    usersData.push({
        walletAddress: walletAddress,
        authorizedAt: currentDate,
    });

    // Save back to file
    fs.writeFileSync(usersFilePath, JSON.stringify(usersData, null, 2));
    console.log(`User activity logged: ${walletAddress} at ${currentDate}`);
};

// Route for wallet authorization
app.post('/execute/authorize', checkToken, (req, res) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Log the user activity
        logUserActivity(walletAddress);

        // Respond with a success message
        res.json({ message: "Authorization Successful", walletAddress });
    } catch (error) {
        console.error('Error in authorization:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// --------------- Transaction Confirmation Logic (Polling) --------------- //
const checkTransactionStatus = async (txHash, retries = 20, delay = 4000) => {
    const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(txStatusUrl);

            if (!response.ok) {
                console.warn(`Non-200 response for ${txHash}: ${response.status}`);
                throw new Error(`HTTP error ${response.status}`);
            }

            const txStatus = await response.json();

            if (txStatus.status === "success") {
                return { status: "success", txHash };
            } else if (txStatus.status === "fail") {
                return { status: "fail", txHash };
            }

            console.log(`Transaction ${txHash} still pending, retrying...`);
        } catch (error) {
            console.error(`Error fetching transaction ${txHash}: ${error.message}`);
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(
        `Transaction ${txHash} status could not be determined after ${retries} retries.`
    );
};

// --------------- Gas Calculation Functions --------------- //

// Function to calculate total gas limit for NFTs/scCalls (15,000,000 gas per asset)
const calculateNftGasLimit = (qty) => {
    return 15000000 * qty;
};

// Function to calculate total gas limit for SFTs (500,000 gas per asset)
const calculateSftGasLimit = (qty) => {
    return 500000 * qty;
};

// Function to calculate gas limit for ESDT transfers
const calculateEsdtGasLimit = () => {
    return BigInt(500000); // Base gas per ESDT transaction
};

// Function to send usage fee in REWARD tokens
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
            TokenTransfer.fungibleFromBigInt(REWARD_TOKEN, BigInt(convertedAmount))
        ]
    });

    tx.nonce = nonce;
    tx.gasLimit = calculateEsdtGasLimit();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);

    // Poll for transaction confirmation
    const status = await checkTransactionStatus(txHash.toString());
    if (status.status !== "success") {
        throw new Error('UsageFee transaction failed. Ensure sufficient REWARD tokens are available.');
    }
    return txHash.toString();
};

// Middleware to handle the usage fee
const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Check if the wallet is whitelisted
        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next(); // Skip the usage fee and proceed
            return;
        }

        const txHash = await sendUsageFee(pemContent);
        req.usageFeeHash = txHash; // Attach transaction hash to the request
        next();
    } catch (error) {
        console.error('Error processing UsageFee:', error.message);
        res.status(400).json({ error: error.message });
    }
};

// Utility function to convert EGLD to WEI (1 EGLD = 10^18 WEI)
const convertEGLDToWEI = (amount) => {
    return new BigNumber(amount).multipliedBy(new BigNumber(10).pow(18)).toFixed(0);
};

// Utility function to fetch token decimals
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

// Utility function to convert amounts to blockchain values
const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

// Function to send EGLD
const sendEgld = async (pemContent, recipient, amount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const amountInWEI = convertEGLDToWEI(amount);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = factory.createTransactionForNativeTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            nativeAmount: BigInt(amountInWEI)
        });

        tx.nonce = senderNonce;
        tx.gasLimit = 50000n;

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending EGLD transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for EGLD transfers
app.post('/execute/egldTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendEgld(pemContent, recipient, amount);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing EGLD transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// Middleware to validate and sanitize request body
const validateEsdtTransferRequest = (req, res, next) => {
    const body = req.body;

    // Validate if the request body exists
    if (!body) {
        return res.status(400).json({ error: "Request body is missing or malformed." });
    }

    const { recipient, amount, tokenTicker } = body;

    // Validate required fields
    if (!recipient || !amount || !tokenTicker) {
        return res.status(400).json({
            error: "Invalid request. Required fields: recipient, amount, tokenTicker."
        });
    }

    // Validate amount is a positive number
    if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount. Must be a positive number." });
    }

    next();
};

// Helper function to fetch token decimals
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

// Helper function to convert amounts to blockchain values
const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

// Helper function to calculate gas limit for ESDT transactions
const calculateEsdtGasLimit = () => {
    return BigInt(500000); // Base gas limit for ESDT transfer
};

// Function to send ESDT token
const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const nonce = accountOnNetwork.nonce;

        const decimals = await getTokenDecimals(tokenTicker);
        const convertedAmount = convertAmountToBlockchainValue(amount, decimals);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const tokenTransfer = TokenTransfer.fungibleFromBigInt(tokenTicker, BigInt(convertedAmount));

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [tokenTransfer],
        });

        tx.nonce = nonce;
        tx.gasLimit = calculateEsdtGasLimit();

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending ESDT transaction:', error);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Route for ESDT transfers
app.post('/execute/esdtTransfer', checkToken, validateEsdtTransferRequest, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendEsdtToken(pemContent, recipient, amount, tokenTicker);
        res.json({ message: "ESDT transfer executed successfully.", result });
    } catch (error) {
        console.error('Error executing ESDT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});


// Route for NFT transfers
app.post('/execute/nftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing NFT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Function to send SFT tokens with dynamic gas limit
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, tokenNonce) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        // Convert amount to BigInt (SFTs typically have 0 decimals)
        const adjustedAmount = BigInt(amount);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Create transaction for SFT transfer
        const tx = factory.createTransactionForESDTNFTTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            token: new Token({
                identifier: tokenTicker,
                nonce: BigInt(tokenNonce),
            }),
            amount: adjustedAmount
        });

        tx.nonce = senderNonce;
        tx.gasLimit = BigInt(calculateSftGasLimit(amount)); // Calculate gas limit dynamically

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll for transaction confirmation
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending SFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for SFT transfers
app.post('/execute/sftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing SFT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Function to execute a free NFT mint airdrop
const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const receiverAddress = new Address(receiver);
        const receiverHex = receiverAddress.hex();
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

        const gasLimit = BigInt(17000000); // Default gas limit for interactions
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(scAddress),
            sender: senderAddress,
            value: '0', // No EGLD value for mint
            gasLimit: gasLimit,
            data: new TransactionPayload(dataField),
            chainID: '1',
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Route for Free Mint Airdrop
app.post('/execute/freeNftMintAirdrop', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = getPemContent(req);

        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Route for distributing rewards to NFT owners
app.post('/execute/distributeRewardsToNftOwners', checkToken, handleUsageFee, async (req, res) => {
    try {
        const pemContent = getPemContent(req);
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
            const tokenTransfer = TokenTransfer.fungibleFromBigInt(tokenTicker, BigInt(adjustedAmount));

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

        // Return transaction results with usage fee hash
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

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
