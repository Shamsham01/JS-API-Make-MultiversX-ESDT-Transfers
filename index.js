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
    
    // Check if the PEM content is in the expected format
    if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Invalid PEM content');
    }

    // The pemContent is passed directly without any modification
    return pemContent;
};

// --------------- Authorization Endpoint --------------- //
app.post('/execute/authorize', checkToken, (req, res) => {
    try {
        const pemContent = getPemContent(req);  // Validate PEM content
        res.json({ message: "Authorization Successful" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// Function to convert EGLD to WEI (1 EGLD = 10^18 WEI)
const convertEGLDToWEI = (amount) => {
    return new BigNumber(amount).multipliedBy(new BigNumber(10).pow(18)).toFixed(0);  // Convert to string in WEI
};

// Function to send EGLD (native token)
const sendEgld = async (pemContent, recipient, amount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);  // Use PEM content from request
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

// --------------- Dynamic Gas Calculation Functions --------------- //

// Function to calculate total gas limit for NFTs (5,000,000 gas per asset)
const calculateNftGasLimit = (nftCount) => {
    const nftBaseGas = 5000000;  // Base gas per NFT/scCall
    return nftBaseGas * nftCount;
};

// Function to calculate total gas limit for SFTs (500,000 gas per asset)
const calculateSftGasLimit = (sftCount) => {
    const sftBaseGas = 500000;   // Base gas per SFT
    return sftBaseGas * sftCount;
};

// --------------- NFT Transfer Logic --------------- //

// Function to send NFT tokens with dynamic gas limit
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce, amount, nftCount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Calculate total gas limit based on the number of NFTs
        const gasLimit = BigInt(calculateNftGasLimit(nftCount));

        // Create the NFT transfer transaction
        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenIdentifier, nonce: BigInt(tokenNonce) }),  // NFT requires nonce to identify the specific token
                    amount: BigInt(amount)  // Typically amount is 1 for NFTs, but supporting dynamic amount
                })
            ]
        });

        tx.nonce = senderNonce;
        tx.gasLimit = gasLimit;  // Set dynamic gas limit

        await signer.sign(tx);  // Sign the transaction
        const txHash = await provider.sendTransaction(tx);  // Send the transaction to the network
        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error sending NFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for NFT transfers with dynamic gas calculation
app.post('/execute/nftTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce, amount, nftCount } = req.body;
        const pemContent = getPemContent(req);
        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce, amount, nftCount);
        res.json({ result });
    } catch (error) {
        console.error('Error executing NFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- SFT Transfer Logic --------------- //

// Function to send SFT tokens with dynamic gas limit
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, nonce, sftCount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const accountNonce = accountOnNetwork.nonce;

        const decimals = await getTokenDecimalsSFT();
        const adjustedAmount = BigInt(amount) * BigInt(10 ** decimals);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        // Calculate total gas limit based on the number of SFTs
        const gasLimit = BigInt(calculateSftGasLimit(sftCount));

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
        tx.gasLimit = gasLimit;  // Set dynamic gas limit

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error sending SFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for SFT transfers with dynamic gas calculation
app.post('/execute/sftTransfer', checkToken, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce, sftCount } = req.body;
        const pemContent = getPemContent(req);
        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce, sftCount);
        res.json({ result });
    } catch (error) {
        console.error('Error executing SFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- Smart Contract Call Logic with Dynamic Gas --------------- //

// Function to execute a smart contract call with dynamic gas
const executeScCall = async (pemContent, scAddress, endpoint, receiver, qty, scAssetCount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);  // Use PEM content from request
        const senderAddress = signer.getAddress();

        // Convert receiver address from Bech32 to hex using MultiversX SDK's Address class
        const receiverAddress = new Address(receiver);
        const receiverHex = receiverAddress.hex();

        // Validate qty to ensure it's a number
        if (isNaN(qty) || qty <= 0) {
            throw new Error('Invalid quantity provided for smart contract call.');
        }

        // Convert qty to hexadecimal string (padded)
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');

        // Validate scAssetCount before calculating gas limit
        if (isNaN(scAssetCount) || scAssetCount <= 0) {
            throw new Error('Invalid asset count for gas limit calculation.');
        }

        // Calculate total gas limit based on the number of assets
        const gasLimit = BigInt(calculateNftGasLimit(scAssetCount));

        // Fetch account details from the network to get the nonce
        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        // Create the payload for the smart contract interaction (data field)
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

        // Create a transaction object
        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(scAddress),
            sender: senderAddress,
            value: '0',  // Sending 0 EGLD
            gasLimit: gasLimit,  // Set dynamic gas limit
            data: new TransactionPayload(dataField),  // Payload with the endpoint and parameters
            chainID: '1',  // Mainnet chain ID
        });

        // Sign the transaction
        await signer.sign(tx);

        // Send the transaction
        const txHash = await provider.sendTransaction(tx);
        return { txHash: txHash.toString() };
    } catch (error) {
        console.error('Error executing smart contract call:', error);
        throw new Error('Smart contract call failed: ' + error.message);
    }
};

// Route for smart contract call with dynamic gas calculation
app.post('/execute/scCall', checkToken, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty, scAssetCount } = req.body;
        const pemContent = getPemContent(req);  // Get the PEM content from the request body
        const result = await executeScCall(pemContent, scAddress, endpoint, receiver, qty, scAssetCount);
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
