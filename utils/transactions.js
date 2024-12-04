const { Address, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, TransactionPayload, TransactionWatcher } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { getTokenDecimals, convertAmountToBlockchainValue } = require('./tokens');
const axios = require('axios'); // Add this line

// Constants
const API_BASE_URL = "https://api.multiversx.com";
const CHAIN_ID = process.env.CHAIN_ID || "1";
const DEFAULT_GAS_LIMIT = 500_000;
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 1000;
const REWARD_TOKEN = process.env.REWARD_TOKEN || "REWARD-cf6eac";

// Create an axios instance with a timeout of 20 seconds
const axiosInstance = axios.create({
    baseURL: API_BASE_URL,
    timeout: 20000, // 20 seconds timeout
    headers: { 'Content-Type': 'application/json' }, // Optional headers
});

// Log axios configuration to ensure it's set correctly
console.log('Axios Configuration:', axiosInstance.defaults);

// Initialize ProxyNetworkProvider with the custom axios instance
const provider = new ProxyNetworkProvider(API_BASE_URL, {
    clientName: "MultiversX Transfers API for Make.com",
    axiosInstance: axiosInstance,
});

const TREASURY_WALLET = process.env.TREASURY_WALLET || "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn";

const safeStringify = (obj) => {
    return JSON.stringify(obj, (key, value) =>
        typeof value === "bigint" ? value.toString() : value
    );
};

/**
 * Watch Transaction Status
 */
const watchTransactionStatus = async (txHash) => {
    try {
        const watcher = new TransactionWatcher(provider);
        const status = await watcher.awaitCompleted(txHash);
        return status.isSuccessful() ? { status: "success", txHash } : { status: "fail", txHash };
    } catch (error) {
        console.error(`Error watching transaction ${txHash}:`, error.message);
        throw new Error(`Transaction failed. Hash: ${txHash}`);
    }
};

const { getNonce, incrementNonce } = require('./utils/nonce');

const handleUsageFee = async (req, res, next) => {
    try {
        const { walletPem } = req.body;

        const signer = UserSigner.fromPem(walletPem);
        const senderAddress = signer.getAddress();
        console.log(`Sender Address: ${senderAddress.toString()}`);

        const amount = BigInt(100); // Usage fee
        const decimals = await getTokenDecimals(REWARD_TOKEN);

        const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);
        console.log(`Adjusted usage fee amount: ${adjustedAmount.toString()}`);

        // Fetch and lock the nonce
        const nonce = await getNonce(senderAddress);
        console.log(`Fetched sender's nonce: ${nonce}`);

        const tokenTransfer = TokenTransfer.fungibleFromAmount(REWARD_TOKEN, adjustedAmount, decimals);
        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: new Address(TREASURY_WALLET),
            tokenTransfers: [tokenTransfer],
            nonce, // Use locked nonce
            gasLimit: BigInt(50_000),
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        console.log(`Usage fee transaction sent. Hash: ${txHash.toString()}`);

        // Increment nonce after successful transaction
        incrementNonce(senderAddress);

        req.nextNonce = nonce + 1;
        req.usageFeeHash = txHash.toString();
        next();
    } catch (error) {
        console.error("Error in handleUsageFee:", error.message);
        res.status(400).json({ error: error.message });
    }
};

/**
 * Send ESDT Tokens
 */
const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker, senderNonce) => {
    try {
        console.log(`Starting sendEsdtToken with recipient: ${recipient}, amount: ${amount}, token: ${tokenTicker}`);

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        console.log(`Sender Address: ${senderAddress.toString()}, Receiver Address: ${receiverAddress.toString()}`);

        const decimals = await getTokenDecimals(tokenTicker);
        console.log(`Decimals for token ${tokenTicker}: ${decimals}`);

        const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);
        console.log(`Adjusted amount for blockchain: ${adjustedAmount.toString()}`); // Ensure safe serialization

        const tokenTransfer = TokenTransfer.fungibleFromAmount(tokenTicker, adjustedAmount, decimals);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [tokenTransfer],
            nonce: senderNonce, // Explicitly pass nonce
        });

        console.log(`Prepared transaction: ${JSON.stringify(tx, (key, value) =>
            typeof value === "bigint" ? value.toString() : value
        )}`);

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        console.log(`Transaction sent. Hash: ${txHash.toString()}`);

        const status = await watchTransactionStatus(txHash.toString());
        console.log(`Transaction status: ${status.status}`);

        return status;
    } catch (error) {
        console.error('Error in sendEsdtToken:', error.message);
        throw new Error(`Failed to send ESDT token: ${error.message}`);
    }
};

/**
 * Send NFT Transaction
 */
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
    try {
        console.log(`Starting sendNftToken with recipient: ${recipient}, tokenIdentifier: ${tokenIdentifier}, tokenNonce: ${tokenNonce}`);

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        console.log(`Sender Address: ${senderAddress.toString()}, Receiver Address: ${receiverAddress.toString()}`);

        // Create token transfer object for NFT
        const tokenTransfer = TokenTransfer.nftFromAmount(tokenIdentifier, 1n, tokenNonce);
        console.log(`Token transfer object: ${JSON.stringify(tokenTransfer)}`);

        // Configure transaction factory
        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        // Build transaction
        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [tokenTransfer],
        });
        console.log(`Prepared transaction: ${JSON.stringify(tx)}`);

        // Sign and send the transaction
        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        console.log(`Transaction sent. Hash: ${txHash.toString()}`);

        // Watch transaction status
        const status = await watchTransactionStatus(txHash.toString());
        console.log(`Transaction status: ${status.status}`);

        return status;
    } catch (error) {
        console.error('Error in sendNftToken:', error.message);
        throw new Error(`Failed to send NFT token: ${error.message}`);
    }
};

/**
 * Send SFT Transaction
 */
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, tokenNonce) => {
    try {
        console.log(`Starting sendSftToken with recipient: ${recipient}, amount: ${amount}, token: ${tokenTicker}, nonce: ${tokenNonce}`);

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        console.log(`Sender Address: ${senderAddress.toString()}, Receiver Address: ${receiverAddress.toString()}`);

        // Convert amount to BigInt
        const adjustedAmount = BigInt(amount);
        console.log(`Adjusted amount for transfer: ${adjustedAmount}`);

        // Create a MetaESDT token transfer
        const tokenTransfer = TokenTransfer.metaEsdtFromAmount(tokenTicker, adjustedAmount, tokenNonce);
        console.log(`Token transfer object: ${JSON.stringify(tokenTransfer)}`);

        // Calculate gas limit dynamically
        const maxGasLimit = BigInt(20_000_000); // Maximum cap for gas
        const dynamicGasLimit = BigInt(1_000_000) + adjustedAmount * BigInt(10_000);
        const finalGasLimit = dynamicGasLimit > maxGasLimit ? maxGasLimit : dynamicGasLimit;
        console.log(`Dynamic gas limit: ${dynamicGasLimit}, Final gas limit: ${finalGasLimit}`);

        // Configure transaction factory
        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        // Build transaction
        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [tokenTransfer],
            gasLimit: finalGasLimit,
        });
        console.log(`Prepared transaction: ${JSON.stringify(tx)}`);

        // Sign and send the transaction
        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        console.log(`Transaction sent. Hash: ${txHash.toString()}`);

        // Watch transaction status
        const status = await watchTransactionStatus(txHash.toString());
        console.log(`Transaction status: ${status.status}`);

        return status;
    } catch (error) {
        console.error('Error in sendSftToken:', error.message);
        throw new Error(`Failed to send SFT token: ${error.message}`);
    }
};

/**
 * Free NFT Mint Airdrop
 */
const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    try {
        console.log(`Starting executeFreeNftMintAirdrop with smart contract: ${scAddress}, endpoint: ${endpoint}, receiver: ${receiver}, quantity: ${qty}`);

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        console.log(`Sender Address: ${senderAddress.toString()}, Smart Contract Address: ${scAddress}`);

        // Convert receiver and quantity to hexadecimal
        const receiverHex = new Address(receiver).hex();
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;
        console.log(`Prepared data field for smart contract call: ${dataField}`);

        // Configure transaction factory
        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        // Build transaction
        const tx = transferFactory.createTransactionForSmartContractCall({
            sender: senderAddress,
            receiver: new Address(scAddress),
            gasLimit: BigInt(15_000_000), // Use high gas limit for minting
            data: new TransactionPayload(dataField),
        });
        console.log(`Prepared transaction: ${JSON.stringify(tx)}`);

        // Sign and send the transaction
        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        console.log(`Transaction sent. Hash: ${txHash.toString()}`);

        // Watch transaction status
        const status = await watchTransactionStatus(txHash.toString());
        console.log(`Transaction status: ${status.status}`);

        return status;
    } catch (error) {
        console.error('Error in executeFreeNftMintAirdrop:', error.message);
        throw new Error(`Failed to execute free NFT mint airdrop: ${error.message}`);
    }
};

/**
 * Distribute Rewards to NFT Owners
 */
const distributeRewardsToNftOwners = async (pemContent, uniqueOwnerStats, tokenTicker, baseAmount, multiply) => {
    try {
        console.log(`Starting distributeRewardsToNftOwners with token: ${tokenTicker}, baseAmount: ${baseAmount}, multiply: ${multiply}`);
        console.log(`Number of owners to process: ${uniqueOwnerStats.length}`);

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        console.log(`Sender Address: ${senderAddress.toString()}`);

        const decimals = await getTokenDecimals(tokenTicker);
        console.log(`Decimals for token ${tokenTicker}: ${decimals}`);

        let results = [];
        for (let i = 0; i < uniqueOwnerStats.length; i += BATCH_SIZE) {
            console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of rewards distribution.`);

            const batch = uniqueOwnerStats.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (owner) => {
                const amount = multiply === "yes" ? baseAmount * owner.tokensCount : baseAmount;
                const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);
                console.log(`Adjusted amount for owner ${owner.owner}: ${adjustedAmount}`);

                const tokenTransfer = TokenTransfer.fungibleFromAmount(tokenTicker, adjustedAmount, decimals);
                console.log(`Token transfer object for owner ${owner.owner}: ${JSON.stringify(tokenTransfer)}`);

                const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
                const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

                const tx = transferFactory.createTransactionForESDTTokenTransfer({
                    sender: senderAddress,
                    receiver: new Address(owner.owner),
                    tokenTransfers: [tokenTransfer],
                });
                console.log(`Prepared transaction for owner ${owner.owner}: ${JSON.stringify(tx)}`);

                await signer.sign(tx);
                const txHash = await provider.sendTransaction(tx);
                console.log(`Transaction sent for owner ${owner.owner}. Hash: ${txHash.toString()}`);

                return await watchTransactionStatus(txHash.toString());
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);

            console.log(`Completed batch ${Math.floor(i / BATCH_SIZE) + 1}.`);

            // Delay between batches to avoid network overload
            if (i + BATCH_SIZE < uniqueOwnerStats.length) {
                console.log(`Waiting ${BATCH_DELAY_MS}ms before processing next batch...`);
                await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }

        console.log(`Finished processing all batches. Total results: ${results.length}`);
        return results;
    } catch (error) {
        console.error('Error in distributeRewardsToNftOwners:', error.message);
        throw new Error(`Failed to distribute rewards: ${error.message}`);
    }
};

module.exports = {
    handleUsageFee,
    sendEgld,
    sendEsdtToken,
    sendNftToken,
    sendSftToken,
    executeFreeNftMintAirdrop,
    distributeRewardsToNftOwners,
};
