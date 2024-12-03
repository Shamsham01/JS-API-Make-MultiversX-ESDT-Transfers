const { Address, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, TransactionWatcher } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { getTokenDecimals, convertAmountToBlockchainValue } = require('./tokens');

// Constants
const API_BASE_URL = "https://api.multiversx.com";
const CHAIN_ID = process.env.CHAIN_ID || "1";
const DEFAULT_GAS_LIMIT = 500_000; // Default gas limit for transactions
const BATCH_SIZE = 4;
const BATCH_DELAY_MS = 1000;
const provider = new ProxyNetworkProvider(`${API_BASE_URL}`, { clientName: "MultiversX Transfers API for Make.com" });

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
        throw new Error(`Transaction failed: ${txHash}`);
    }
};

/**
 * Send EGLD Transaction using the updated v13 SDK
 */
const sendEgld = async (pemContent, recipient, amount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForNativeTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            nativeAmount: BigInt(amount), // Ensure amount is in BigInt
        });

        // Sign and send the transaction
        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Watch the transaction status
        const watcher = new TransactionWatcher(provider);
        const status = await watcher.awaitCompleted(txHash.toString());

        return status.isSuccessful()
            ? { status: "success", txHash: txHash.toString() }
            : { status: "fail", txHash: txHash.toString() };
    } catch (error) {
        console.error('Error in sendEgld:', error.message);
        throw new Error(`Failed to send EGLD transaction: ${error.message}`);
    }
};

/**
 * Send ESDT Tokens
 */
const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const decimals = await getTokenDecimals(tokenTicker);
        const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);

        const tokenTransfer = TokenTransfer.fungibleFromAmount(tokenTicker, adjustedAmount, decimals);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [tokenTransfer],
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        return await watchTransactionStatus(txHash.toString());
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
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const tokenTransfer = TokenTransfer.nftFromAmount(tokenIdentifier, 1n, tokenNonce);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [tokenTransfer],
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        return await watchTransactionStatus(txHash.toString());
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
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        // Amount should be in BigInt for SFT transfers
        const adjustedAmount = BigInt(amount);

        // Create a MetaESDT token transfer
        const tokenTransfer = TokenTransfer.metaEsdtFromAmount(tokenTicker, adjustedAmount, tokenNonce);

        // Calculate gas limit dynamically based on the SFT transfer amount
        const dynamicGasLimit = BigInt(1_000_000) + adjustedAmount * BigInt(10_000);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [tokenTransfer],
            gasLimit: dynamicGasLimit,
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        return await watchTransactionStatus(txHash.toString());
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
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        // Convert receiver and quantity to hexadecimal for the smart contract call
        const receiverHex = new Address(receiver).hex();
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

        const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
        const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

        const tx = transferFactory.createTransactionForSmartContractCall({
            sender: senderAddress,
            receiver: new Address(scAddress),
            gasLimit: BigInt(15_000_000), // Use high gas limit for minting
            data: new TransactionPayload(dataField),
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        return await watchTransactionStatus(txHash.toString());
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

                const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
                const transferFactory = new TransferTransactionsFactory({ config: factoryConfig });

                const tx = transferFactory.createTransactionForESDTTokenTransfer({
                    sender: senderAddress,
                    receiver: new Address(owner.owner),
                    tokenTransfers: [tokenTransfer],
                });

                await signer.sign(tx);
                const txHash = await provider.sendTransaction(tx);
                return await watchTransactionStatus(txHash.toString());
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);

            if (i + BATCH_SIZE < uniqueOwnerStats.length) {
                await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
            }
        }
        return results;
    } catch (error) {
        console.error('Error in distributeRewardsToNftOwners:', error.message);
        throw new Error(`Failed to distribute rewards: ${error.message}`);
    }
};

module.exports = {
    sendEgld,                         // Send EGLD
    sendEsdtToken,                    // Send ESDT Tokens
    sendNftToken,                     // Transfer NFTs
    sendSftToken,                     // Transfer SFTs
    executeFreeNftMintAirdrop,        // Mint and airdrop free NFTs
    distributeRewardsToNftOwners,     // Distribute rewards in batch
    watchTransactionStatus,           // Transaction status watcher
};
