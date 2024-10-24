const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const BigNumber = require('bignumber.js');

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;  // Secure Token for authorization

// Set up the network provider for MultiversX (mainnet or devnet)
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

app.use(bodyParser.json());  // Support JSON-encoded bodies

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

// --------------- Transaction Confirmation Logic --------------- //
const checkTransactionStatus = async (txHash, retries = 10, delay = 5000) => {
    for (let i = 0; i < retries; i++) {
        const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;
        const response = await fetch(txStatusUrl);
        const txStatus = await response.json();

        if (txStatus.status === 'success') {
            return true;
        } else if (txStatus.status === 'fail') {
            throw new Error(`Transaction ${txHash} failed.`);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(`Transaction ${txHash} not confirmed after ${retries} retries.`);
};

// --------------- Helper function for dynamic gas calculation based on documentation --------------- //
const calculateDynamicGasLimit = (transactionType, numberOfItems = 1, payloadSize = 0) => {
    const MIN_GAS_LIMIT = 50000n; // Minimum gas limit for any transaction
    const GAS_PER_DATA_BYTE = 1500n; // Gas cost per byte of data
    const ESDT_TRANSFER_FUNCTION_COST = 200000n; // Cost for smart contract function
    const GAS_PRICE_MODIFIER = 0.01; // Gas price modifier for smart contracts

    let baseGas = MIN_GAS_LIMIT; // Base gas cost for the transaction
    let multiplier = BigInt(numberOfItems); // Multiplier for NFTs, SFTs
    let payloadCost = BigInt(payloadSize) * GAS_PER_DATA_BYTE; // Payload size increases gas cost

    switch (transactionType) {
        case 'EGLD':
            return baseGas + payloadCost; // EGLD transfers add data size cost
        case 'ESDT':
            return baseGas + (500000n * multiplier) + payloadCost; // ESDT requires more gas depending on the number of items
        case 'NFT':
            return baseGas + (5000000n * multiplier) + payloadCost; // Assume 5M gas per NFT
        case 'SFT':
            return baseGas + (5000000n * multiplier) + payloadCost; // Assume 5M gas per SFT
        case 'SC_CALL':
            return baseGas + (BigInt(ESDT_TRANSFER_FUNCTION_COST) * multiplier) + payloadCost + (2000n * multiplier); // Smart contract call with a base multiplier and payload
        default:
            throw new Error("Unknown transaction type");
    }
};

// --------------- Authorization Endpoint --------------- //
app.post('/execute/authorize', checkToken, (req, res) => {
    try {
        const pemContent = getPemContent(req);
        res.json({ message: "Authorization Successful" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Function to convert EGLD to WEI (1 EGLD = 10^18 WEI)
const convertEGLDToWEI = (amount) => {
    return new BigNumber(amount).multipliedBy(new BigNumber(10).pow(18)).toFixed(0);
};

// --------------- EGLD Transfer Logic --------------- //
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

        // Dynamically calculate the gas limit
        tx.gasLimit = calculateDynamicGasLimit('EGLD', 1, 0);

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation
        await checkTransactionStatus(txHash.toString());

        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error sending EGLD transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for EGLD transfers
app.post('/execute/egldTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount } = req.body;
        const pemContent = getPemContent(req);
        const result = await sendEgld(pemContent, recipient, amount);
        res.json({ result });
    } catch (error) {
        console.error('Error executing EGLD transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- NFT Transfer Logic --------------- //
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce, amount) => {
    try {
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
                    amount: BigInt(amount)  // Typically amount is 1 for NFTs, but supporting dynamic amount
                })
            ]
        });

        tx.nonce = senderNonce;

        // Dynamically calculate gas limit for NFTs based on the number of items and payload size
        tx.gasLimit = calculateDynamicGasLimit('NFT', amount, 54);  // Assuming payload is 54 bytes per NFT

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        await checkTransactionStatus(txHash.toString());

        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error sending NFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for NFT transfers
app.post('/execute/nftTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce, amount } = req.body;
        const pemContent = getPemContent(req);
        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce, amount);
        res.json({ result });
    } catch (error) {
        console.error('Error executing NFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- Smart Contract Call Logic --------------- //
const executeScCall = async (pemContent, scAddress, endpoint, receiver, qty, numberOfItems) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        // Log the number of NFTs/items
        console.log(`Number of NFTs being sent: ${numberOfItems}`);

        // Convert receiver address from Bech32 to hex using MultiversX SDK's Address class
        const receiverAddress = new Address(receiver);
        const receiverHex = receiverAddress.hex();

        // Create the payload for the smart contract interaction (data field)
        const dataField = `${endpoint}@${receiverHex}@${qty.toString(16).padStart(2, '0')}`;

        // Fetch account details from the network to get the nonce
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        // Dynamically calculate gas based on the number of NFTs and payload size
        const gasLimit = calculateDynamicGasLimit('SC_CALL', numberOfItems, dataField.length);

        // Log the calculated gas limit
        console.log(`Calculated Gas Limit: ${gasLimit.toString()}`);

        // Create a transaction object
        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(scAddress),
            sender: senderAddress,
            value: '0',  // Sending 0 EGLD
            gasLimit: gasLimit, // Use dynamic gas limit
            data: new TransactionPayload(dataField),
            chainID: '1',
        });

        // Sign the transaction
        await signer.sign(tx);

        // Send the transaction
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation
        await checkTransactionStatus(txHash.toString());

        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error executing smart contract call:', error);
        throw new Error('Smart contract call failed');
    }
};

// Route for smart contract call
app.post('/execute/scCall', checkToken, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty, numberOfItems } = req.body;
        const pemContent = getPemContent(req);
        const result = await executeScCall(pemContent, scAddress, endpoint, receiver, qty, numberOfItems);
        res.json({ result });
    } catch (error) {
        console.error('Error executing smart contract call:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
