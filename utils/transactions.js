const { Address, TransactionWatcher, TransactionBuilder, TransactionPayload, TokenTransfer } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { getTokenDecimals, convertAmountToBlockchainValue } = require('./tokens');

// Constants
const API_BASE_URL = "https://api.multiversx.com";
const CHAIN_ID = process.env.CHAIN_ID || "1";
const DEFAULT_GAS_LIMIT = 500_000; // Default gas limit for basic transactions
const BATCH_SIZE = 4; // Number of transactions per batch
const BATCH_DELAY_MS = 1000; // Delay between batches in milliseconds
const provider = new ProxyNetworkProvider(`${API_BASE_URL}`, { clientName: "MultiversX Transfers API for Make.com" });
const NFT_GAS_LIMIT = 15_000_000; // Default gas for NFT transfers
const SFT_GAS_LIMIT = 1_000_000; // Default gas for SFT transfers

/**
 * Helper: Watch Transaction Status
 */
const watchTransactionStatus = async (txHash) => {
    try {
        const watcher = new TransactionWatcher(provider);
        const status = await watcher.awaitCompleted({ hash: txHash });
        return status.isSuccessful() ? { status: "success", txHash } : { status: "fail", txHash };
    } catch (error) {
        console.error(`Error watching transaction ${txHash}:`, error.message);
        throw new Error(`Transaction failed: ${txHash}`);
    }
};

/**
 * Send EGLD Transaction
 */
const sendEgld = async (pemContent, recipient, amount) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const tx = new TransactionBuilder()
        .setSender(senderAddress)
        .setReceiver(receiverAddress)
        .setValue(BigInt(amount) * BigInt(10 ** 18)) // Convert EGLD to WEI explicitly
        .setGasLimit(DEFAULT_GAS_LIMIT)
        .setChainID(CHAIN_ID)
        .build();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await watchTransactionStatus(txHash.toString());
};

/**
 * Send ESDT Tokens
 */
const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const decimals = await getTokenDecimals(tokenTicker);
    const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);

    const tokenTransfer = TokenTransfer.fungibleFromAmount(tokenTicker, adjustedAmount, decimals);

    const tx = new TransactionBuilder()
        .setSender(senderAddress)
        .setReceiver(receiverAddress)
        .setGasLimit(DEFAULT_GAS_LIMIT)
        .setData(TransactionPayload.esdtTransfer(tokenTransfer))
        .setChainID(CHAIN_ID)
        .build();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await watchTransactionStatus(txHash.toString());
};

/**
 * Batch Processing for Rewards Distribution
 */
const distributeRewardsToNftOwners = async (pemContent, uniqueOwnerStats, tokenTicker, baseAmount, multiply) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const decimals = await getTokenDecimals(tokenTicker);

    let results = [];
    for (let i = 0; i < uniqueOwnerStats.length; i += BATCH_SIZE) {
        const batch = uniqueOwnerStats.slice(i, i + BATCH_SIZE);

        const batchPromises = batch.map(async (owner) => {
            const amount = multiply === "yes" ? baseAmount * owner.tokensCount : baseAmount;
            const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);
            const tokenTransfer = TokenTransfer.fungibleFromAmount(tokenTicker, adjustedAmount, decimals);

            const tx = new TransactionBuilder()
                .setSender(senderAddress)
                .setReceiver(new Address(owner.owner))
                .setGasLimit(DEFAULT_GAS_LIMIT)
                .setData(TransactionPayload.esdtTransfer(tokenTransfer))
                .setChainID(CHAIN_ID)
                .build();

            await signer.sign(tx);
            const txHash = await provider.sendTransaction(tx);
            return await watchTransactionStatus(txHash.toString());
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);

        // Delay between batches to avoid overwhelming the network
        if (i + BATCH_SIZE < uniqueOwnerStats.length) {
            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
    }

    return results;
};

/**
 * Send NFT Transaction
 */
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const tokenTransfer = TokenTransfer.nftFromAmount(tokenIdentifier, 1, tokenNonce);

    const tx = new TransactionBuilder()
        .setSender(senderAddress)
        .setReceiver(receiverAddress)
        .setGasLimit(NFT_GAS_LIMIT) // Use NFT-specific gas limit
        .setData(TransactionPayload.esdtNftTransfer(tokenTransfer))
        .setChainID(CHAIN_ID)
        .build();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await watchTransactionStatus(txHash.toString());
};

/**
 * Send SFT Transaction
 */
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, tokenNonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const adjustedAmount = BigInt(amount);
    const tokenTransfer = TokenTransfer.metaEsdtFromAmount(tokenTicker, adjustedAmount, tokenNonce);

    const dynamicGasLimit = BigInt(SFT_GAS_LIMIT) + adjustedAmount * BigInt(10_000); // Dynamically adjust gas

    const tx = new TransactionBuilder()
        .setSender(senderAddress)
        .setReceiver(receiverAddress)
        .setGasLimit(dynamicGasLimit)
        .setData(TransactionPayload.esdtNftTransfer(tokenTransfer))
        .setChainID(CHAIN_ID)
        .build();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await watchTransactionStatus(txHash.toString());
};

/**
 * Free NFT Mint Airdrop
 */
const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverHex = new Address(receiver).hex();
    const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
    const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

    const tx = new TransactionBuilder()
        .setSender(senderAddress)
        .setReceiver(new Address(scAddress))
        .setGasLimit(NFT_GAS_LIMIT) // Use NFT gas limit as minting is resource-intensive
        .setData(new TransactionPayload(dataField))
        .setChainID(CHAIN_ID)
        .build();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await watchTransactionStatus(txHash.toString());
};

// Export Updated Functions
module.exports = {
    sendEgld,                         // Send EGLD
    sendEsdtToken,                    // Send ESDT Tokens
    distributeRewardsToNftOwners,     // Distribute rewards in batch
    sendNftToken,                     // Transfer NFTs
    sendSftToken,                     // Transfer SFTs
    executeFreeNftMintAirdrop,        // Mint and airdrop free NFTs
    watchTransactionStatus,           // Transaction status watcher
};
