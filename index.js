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

// --------------- Helper function for dynamic gas calculation --------------- //
const calculateDynamicGasLimit = (transactionType, numberOfItems = 1, payloadSize = 0) => {
    let baseGas = 1000000n; // Base gas for smart contract calls (1M)
    let multiplier = BigInt(numberOfItems); // Multiplier for NFTs, SFTs
    let payloadCost = BigInt(payloadSize) * 1500n; // Payload size increases gas

    switch (transactionType) {
        case 'EGLD':
            return baseGas; // EGLD transfers are relatively cheap
        case 'ESDT':
            return baseGas + (500000n * multiplier); // ESDT requires more gas depending on the number of items
        case 'NFT':
            return baseGas + (5000000n * multiplier); // Each NFT requires 5M gas
        case 'SFT':
            return baseGas + (5000000n * multiplier); // SFT transfers similar to NFTs
        case 'SC_CALL':
            return baseGas + (5000000n * multiplier) + payloadCost; // Smart contract calls, assume 5M per item
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
        tx.gasLimit = calculateDynamicGasLimit('EGLD');

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

// --------------- ESDT Transfer Logic --------------- //
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

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker }),
                    amount: BigInt(convertedAmount)
                })
            ]
        });

        tx.nonce = nonce;

        // Dynamically calculate gas limit for ESDT based on amount
        tx.gasLimit = calculateDynamicGasLimit('ESDT', amount);

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        await checkTransactionStatus(txHash.toString());

        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error sending ESDT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for ESDT transfers
app.post('/execute/esdtTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker } = req.body;
        const pemContent = getPemContent(req);
        const result = await sendEsdtToken(pemContent, recipient, amount, tokenTicker);
        res.json({ result });
    } catch (error) {
        console.error('Error executing ESDT transaction:', error);
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

        // Dynamically calculate gas limit for NFTs based on the amount
        tx.gasLimit = calculateDynamicGasLimit('NFT', amount);

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
