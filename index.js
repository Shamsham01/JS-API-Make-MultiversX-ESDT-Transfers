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

// --------------- Transaction Confirmation Logic (Polling Logic) --------------- //
const checkTransactionStatus = async (txHash, retries = 10, delay = 5000) => {
    for (let i = 0; i < retries; i++) {
        const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;
        const response = await fetch(txStatusUrl);
        const txStatus = await response.json();

        if (txStatus.status === 'success') {
            return { status: 'success', txHash };
        } else if (txStatus.status === 'fail') {
            throw new Error(`Transaction ${txHash} failed.`);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(`Transaction ${txHash} not confirmed after ${retries} retries.`);
};

// --------------- Gas Calculation Functions --------------- //

// Function to calculate total gas limit for NFTs/scCalls (15,000,000 gas per asset)
const calculateNftGasLimit = (qty) => {
    const nftBaseGas = 15000000;  // Base gas per NFT/scCall
    return nftBaseGas * qty;
};

// Function to calculate total gas limit for SFTs (500,000 gas per asset)
const calculateSftGasLimit = (qty) => {
    const sftBaseGas = 500000;   // Base gas per SFT
    return sftBaseGas * qty;
};

// Function to calculate gas limit for ESDT transfers
const calculateEsdtGasLimit = (amount) => {
    const baseGas = 500000;  // Base gas per ESDT transaction
    return BigInt(baseGas);  // Returning as BigInt for compatibility with the transaction
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

// Function to send EGLD (native token)
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

        // Wait for transaction confirmation using polling logic
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
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

// Fetch token decimals for the ESDT
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

// Convert token amount based on decimals
const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

// Function to send ESDT tokens (Fungible Tokens)
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
        tx.gasLimit = calculateEsdtGasLimit(amount);  // Set dynamic gas limit

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation using polling logic
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
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
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce, amount, qty) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Calculate total gas limit based on qty
        const gasLimit = BigInt(calculateNftGasLimit(qty));

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenIdentifier, nonce: BigInt(tokenNonce) }),
                    amount: BigInt(amount)
                })
            ]
        });

        tx.nonce = senderNonce;
        tx.gasLimit = gasLimit;  // Set dynamic gas limit

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation using polling logic
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending NFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for NFT transfers
app.post('/execute/nftTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce, amount, qty } = req.body;
        const pemContent = getPemContent(req);
        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce, amount, qty);
        res.json({ result });
    } catch (error) {
        console.error('Error executing NFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// Function to send SFT tokens
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, nonce) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const accountNonce = accountOnNetwork.nonce;

        // SFT tokens typically have 0 decimals, so we assume no decimals here
        const decimals = 0;
        const adjustedAmount = BigInt(amount) * BigInt(10 ** decimals);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Calculate total gas limit for SFT
        const gasLimit = BigInt(500000); // Using a fixed gas limit for SFT

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenTicker, nonce: BigInt(nonce) }),
                    amount: adjustedAmount
                })
            ]
        });

        tx.nonce = accountNonce;
        tx.gasLimit = gasLimit;  // Fixed gas limit for SFT transfer

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation using polling logic
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending SFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for SFT transfers
app.post('/execute/sftTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce, qty } = req.body;
        const pemContent = getPemContent(req);
        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce, qty);
        res.json({ result });
    } catch (error) {
        console.error('Error executing SFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- Smart Contract Call Logic --------------- //
const executeScCall = async (pemContent, scAddress, endpoint, receiver, qty) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        // Validate qty to ensure it's a number
        if (isNaN(qty) || qty <= 0) {
            throw new Error('Invalid quantity provided for smart contract call.');
        }

        // Convert qty to hexadecimal string (padded)
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');

        // Convert receiver address from Bech32 to hex using MultiversX SDK's Address class
        const receiverAddress = new Address(receiver);
        const receiverHex = receiverAddress.hex();

        // Calculate total gas limit based on qty
        const gasLimit = BigInt(calculateNftGasLimit(qty));

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        // Create the payload for the smart contract interaction (data field)
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(scAddress),
            sender: senderAddress,
            value: '0',
            gasLimit: gasLimit,
            data: new TransactionPayload(dataField),
            chainID: '1',
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Wait for transaction confirmation using polling logic
        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error executing smart contract call:', error);
        throw new Error('Smart contract call failed: ' + error.message);
    }
};

// Route for smart contract call
app.post('/execute/scCall', checkToken, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = getPemContent(req);
        const result = await executeScCall(pemContent, scAddress, endpoint, receiver, qty);
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
