const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const axios = require('axios');
const {
  Address,
  TokenTransfer,
  TransferTransactionsFactory,
  TransactionsFactoryConfig,
  GasEstimator,
} = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const BigNumber = require('bignumber.js');

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN; // Secure Token for authorization

// Set up the network provider for MultiversX (mainnet or devnet)
const provider = new ProxyNetworkProvider('https://gateway.multiversx.com', { clientName: 'javascript-api' });

app.use(bodyParser.json()); // Support JSON-encoded bodies

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

  // Check if the content is already properly formatted and skip reformatting
  if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error('Invalid PEM content');
  }

  // If the content already has "\n", skip reformatting
  if (pemContent.includes('\n')) {
    return pemContent;
  }

  // Reformat the PEM content by inserting new lines
  const formattedPem = pemContent.replace(/\\n/g, '\n');
  return formattedPem;
};

// --------------- Authorization Endpoint --------------- //
// Handles /authorize endpoint to validate authorization and PEM content
app.post('/execute/authorize', checkToken, (req, res) => {
  try {
    const pemContent = getPemContent(req); // Validate PEM content
    res.json({ message: 'Authorization Successful' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --------------- ESDT Transfer Logic --------------- //
// Function to get token decimals for ESDT transfers
const getTokenDecimals = async (tokenTicker) => {
  const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch token info: ${response.statusText}`);
  }
  const tokenInfo = await response.json();
  return tokenInfo.decimals || 0; // Default to 0 if decimals not found
};

// Function to convert token amount for ESDT based on decimals
const convertAmountToBlockchainValue = (amount, decimals) => {
  const factor = new BigNumber(10).pow(decimals); // Factor = 10^decimals
  return new BigNumber(amount).multipliedBy(factor).toFixed(0); // Convert to integer string
};

// Function to send ESDT tokens
const sendEsdtToken = async (pemContent, recipient, amount, tokenTicker) => {
  try {
    const signer = UserSigner.fromPem(pemContent); // Use PEM content from request
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    // Fetch account details from network to get the nonce
    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    // Fetch token decimals and convert amount
    const decimals = await getTokenDecimals(tokenTicker);
    const convertedAmount = convertAmountToBlockchainValue(amount, decimals);

    // Create a factory for ESDT token transfer transactions
    const factoryConfig = new TransactionsFactoryConfig({ chainID: '1' });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
      sender: senderAddress,
      receiver: receiverAddress,
      tokenTransfers: [
        new TokenTransfer({
          token: new Token({ identifier: tokenTicker }),
          amount: BigInt(convertedAmount), // Handle token amount as BigInt
        }),
      ],
    });

    tx.nonce = nonce; // Set transaction nonce
    tx.gasLimit = 500000n; // Set gas limit as BigInt

    await signer.sign(tx); // Sign the transaction
    const txHash = await provider.sendTransaction(tx); // Send the transaction to the network
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
    const pemContent = getPemContent(req); // Get the PEM content from the request body
    const result = await sendEsdtToken(pemContent, recipient, amount, tokenTicker);
    res.json({ result });
  } catch (error) {
    console.error('Error executing ESDT transaction:', error);
    res.status(500).json({ error: error.message });
  }
});

// --------------- NFT Transfer Logic --------------- //
// Function to send NFT tokens
const sendNftToken = async (pemContent, recipient, tokenId) => {
  try {
    console.log(`Sending NFT: tokenId=${tokenId}, recipient=${recipient}`);

    // Step 1: Fetch NFT details (nonce and ticker)
    const nftOnNetwork = await axios.get(`https://api.multiversx.com/nfts/${tokenId.trim()}`, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    const nonce = nftOnNetwork?.data?.nonce;
    const collectionTicker = nftOnNetwork?.data?.ticker;

    if (nonce === undefined || collectionTicker === undefined) {
      throw new Error('Unable to retrieve NFT data. Check tokenId or network configuration.');
    }

    console.log(`Fetched NFT data: Ticker=${collectionTicker}, Nonce=${nonce}`);

    // Step 2: Create Token Transfer object
    const transfer = TokenTransfer.nonFungible(collectionTicker, nonce);

    // Step 3: Create transaction using TransferTransactionsFactory
    const factory = new TransferTransactionsFactory(new GasEstimator());

    const signer = UserSigner.fromPem(pemContent); // Use PEM content from request
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient.trim());

    const tx = factory.createESDTNFTTransfer({
      tokenTransfer: transfer,
      nonce,
      sender: senderAddress,
      destination: receiverAddress,
      chainID: '1', // Mainnet chain ID
    });

    // Step 4: Sign and send the transaction
    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    console.log('Transaction sent, txHash:', txHash.toString());

    return { txHash: txHash.toString() };
  } catch (error) {
    console.error('Error sending NFT transaction:', error);
    throw new Error('Transaction failed');
  }
};

// Route for NFT transfers
app.post('/execute/nftTransfer', checkToken, async (req, res) => {
  try {
    const { recipient, tokenId } = req.body;
    const pemContent = getPemContent(req); // Get the PEM content from the request body
    const result = await sendNftToken(pemContent, recipient, tokenId);
    res.json({ result });
  } catch (error) {
    console.error('Error executing NFT transaction:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
