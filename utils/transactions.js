const fetch = require('node-fetch');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const { getTokenDecimals, convertAmountToBlockchainValue } = require('./tokens');

// Constants
const API_BASE_URL = "https://api.multiversx.com";
const CHAIN_ID = "1"; // Mainnet chain ID
const DEFAULT_GAS_LIMIT = BigInt(500000); // Default gas limit for basic transactions
const provider = new ProxyNetworkProvider(`${API_BASE_URL}`, { clientName: "javascript-api" });

// Helper function to check transaction status
const checkTransactionStatus = async (txHash, retries = 20, delay = 4000) => {
    const txStatusUrl = `${API_BASE_URL}/transactions/${txHash}`;
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

// Function to send EGLD
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
        gasLimit: DEFAULT_GAS_LIMIT,
        data: new TransactionPayload(""),
        chainID: CHAIN_ID,
    });

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

// Function to send ESDT tokens
const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const decimals = await getTokenDecimals(tokenTicker);
    const adjustedAmount = convertAmountToBlockchainValue(amount, decimals);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
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
    tx.gasLimit = DEFAULT_GAS_LIMIT;

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

// Function to send NFT tokens
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
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

// Function to send SFT tokens
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, tokenNonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const adjustedAmount = BigInt(amount);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: CHAIN_ID });
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
    tx.gasLimit = BigInt(DEFAULT_GAS_LIMIT + amount * 500000); // Dynamic gas based on quantity

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

// Export functions
module.exports = {
    sendEgld,
    sendEsdtToken,
    sendNftToken,
    sendSftToken,
    checkTransactionStatus,
};
