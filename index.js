const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Address, Token, TokenTransfer, TransferTransactionsFactory, TransactionsFactoryConfig, Transaction, TransactionPayload } = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const BigNumber = require('bignumber.js');
const WebSocket = require('ws'); // Add WebSocket library
const axios = require('axios'); // Add axios for webhook calls

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;  // Secure Token for authorization
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;  // Admin Token for whitelist management
const USAGE_FEE = 100; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const WEBHOOK_WHITELIST_URL = "https://hook.eu2.make.com/mvi4kvg6arzxrxd5462f6nh2yqq1p5ot"; // Your Make webhook URL for whitelist
const MAKE_WEBHOOK_URL = "https://hook.make.com/your-webhook-url"; // Replace with your make.com webhook URL for events
const adminRoutes = require('./admin');

// Set up the network provider for MultiversX (mainnet)
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });
// Helper function to wait for a specified time
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fs = require('fs');
const path = require('path');

const whitelistFilePath = path.join(__dirname, 'whitelist.json');
const usersFilePath = path.join(__dirname, 'users.json');

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

// Helper to derive wallet address from PEM
const deriveWalletAddressFromPem = (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    return signer.getAddress().toString();
};

// Helper: Check transaction status with consistent retry logic
async function checkTransactionStatus(txHash, maxRetries = 20, retryInterval = 3000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Checking transaction ${txHash} status (attempt ${i + 1}/${maxRetries})...`);
      
      const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;
      const response = await fetch(txStatusUrl);
      
      if (!response.ok) {
        if (response.status === 404) {
          // Transaction not yet visible, retry after interval
          await new Promise(resolve => setTimeout(resolve, retryInterval));
          continue;
        }
        throw new Error(`HTTP error ${response.status}`);
      }
      
      const txStatus = await response.json();
      
      if (txStatus.status === "success") {
        console.log(`Transaction ${txHash} completed successfully.`);
        return { status: "success", txHash };
      } else if (txStatus.status === "fail" || txStatus.status === "invalid") {
        console.log(`Transaction ${txHash} failed with status: ${txStatus.status}`);
        return { 
          status: "fail", 
          txHash, 
          details: txStatus.error || txStatus.receipt?.data || 'No error details provided' 
        };
      }
      
      // Transaction still pending, retry after interval
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    } catch (error) {
      console.error(`Error checking transaction ${txHash}: ${error.message}`);
      // Continue retrying even after fetch errors
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
  }
  
  // Max retries reached without definitive status
  console.log(`Transaction ${txHash} status undetermined after ${maxRetries} retries`);
  return { status: "pending", txHash };
}

// Helper: Calculate dynamic usage fee based on REWARD price
const calculateDynamicUsageFee = async () => {
  const rewardPrice = await getRewardPrice();
  
  if (rewardPrice <= 0) {
    throw new Error('Invalid REWARD token price');
  }

  const rewardAmount = new BigNumber(FIXED_USD_FEE).dividedBy(rewardPrice);
  const decimals = await getTokenDecimals(REWARD_TOKEN);
  
  // Ensure the amount is not too small or too large
  if (!rewardAmount.isFinite() || rewardAmount.isZero()) {
    throw new Error('Invalid usage fee calculation');
  }

  return convertAmountToBlockchainValue(rewardAmount, decimals);
};

// Helper: Send usage fee transaction
const sendUsageFee = async (pemContent) => {
  const signer = UserSigner.fromPem(pemContent);
  const senderAddress = signer.getAddress();
  const receiverAddress = new Address(TREASURY_WALLET);

  const accountOnNetwork = await provider.getAccount(senderAddress);
  const nonce = accountOnNetwork.nonce;

  // Calculate dynamic fee
  const dynamicFeeAmount = await calculateDynamicUsageFee();

  const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
  const factory = new TransferTransactionsFactory({ config: factoryConfig });

  const tx = factory.createTransactionForESDTTokenTransfer({
    sender: senderAddress,
    receiver: receiverAddress,
    tokenTransfers: [
      new TokenTransfer({
        token: new Token({ identifier: REWARD_TOKEN }),
        amount: BigInt(dynamicFeeAmount),
      }),
    ],
  });

  tx.nonce = nonce;
  tx.gasLimit = BigInt(500000);

  await signer.sign(tx);
  const txHash = await provider.sendTransaction(tx);

  // Check transaction status with retries
  const status = await checkTransactionStatus(txHash.toString());
  if (status.status !== "success") {
    throw new Error(`Usage fee transaction failed: ${status.details || 'Unknown reason'}`);
  }
  return txHash.toString();
};

// Middleware: Handle usage fee
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
    req.usageFeeHash = txHash;
    next();
  } catch (error) {
    console.error('Error processing UsageFee:', error.message);
    res.status(400).json({ error: error.message });
  }
};

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
        tx.gasLimit = 50000n;

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll transaction status
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
        tx.gasLimit = calculateEsdtGasLimit();

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        // Poll transaction status
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

        const walletAddress = deriveWalletAddressFromPem(pemContent);
        console.log(`Derived wallet address: ${walletAddress}`);

        const result = await sendEsdtToken(pemContent, recipient, amount, tokenTicker);
        res.json({
            message: "ESDT transfer executed successfully.",
            walletAddress: walletAddress,
            result: result,
        });
    } catch (error) {
        console.error('Error executing ESDT transaction:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Function to handle Meta-ESDT transfers
const sendMetaEsdt = async (pemContent, recipient, tokenIdentifier, nonce, amount) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const dataField = `ESDTNFTTransfer@${Buffer.from(tokenIdentifier).toString('hex')}@${toHex(nonce)}@${toHex(amount)}`;

        const tx = new Transaction({
            nonce: senderNonce,
            receiver: receiverAddress,
            sender: senderAddress,
            value: '0',
            gasLimit: BigInt(5000000),
            data: new TransactionPayload(dataField),
            chainID: '1',
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending Meta-ESDT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route to handle Meta-ESDT transfers
app.post('/execute/metaEsdtTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, nonce, amount } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendMetaEsdt(pemContent, recipient, tokenIdentifier, nonce, amount);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing Meta-ESDT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- NFT Transfer Logic --------------- //
const validateNumberInput = (value, fieldName) => {
    const numValue = Number(value);
    if (isNaN(numValue) || numValue <= 0) {
        throw new Error(`Invalid ${fieldName} provided. It must be a positive number.`);
    }
    return numValue;
};

const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const amount = BigInt(1);
        const gasLimit = BigInt(calculateNftGasLimit(1));

        const tx = factory.createTransactionForESDTTokenTransfer({
            sender: senderAddress,
            receiver: receiverAddress,
            tokenTransfers: [
                new TokenTransfer({
                    token: new Token({ identifier: tokenIdentifier, nonce: BigInt(tokenNonce) }),
                    amount: amount
                })
            ]
        });

        tx.nonce = senderNonce;
        tx.gasLimit = gasLimit;

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error sending NFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for NFT transfers
app.post('/execute/nftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing NFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- SFT Transfer Logic --------------- //
const validateAmountInput = (value, fieldName) => {
    console.log(`Validating ${fieldName}:`, value);
    const numValue = Number(value);
    if (isNaN(numValue) || numValue <= 0) {
        throw new Error(`Invalid ${fieldName} provided. It must be a positive number.`);
    }
    return numValue;
};

const sendSftToken = async (pemContent, recipient, amount, tokenTicker, nonce) => {
    try {
        const validAmount = validateAmountInput(amount, 'amount');

        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();
        const receiverAddress = new Address(recipient);

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const accountNonce = accountOnNetwork.nonce;

        const adjustedAmount = BigInt(validAmount);

        const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
        const factory = new TransferTransactionsFactory({ config: factoryConfig });

        const gasLimit = BigInt(calculateSftGasLimit(validAmount));

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
        tx.gasLimit = gasLimit;

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);

        const finalStatus = await checkTransactionStatus(txHash.toString());
        return { txHash: txHash.toString(), status: finalStatus };
    } catch (error) {
        console.error('Error sending SFT transaction:', error);
        throw new Error('Transaction failed');
    }
};

// Route for SFT transfers with dynamic gas calculation
app.post('/execute/sftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing SFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// Function for free NFT mint airdrop
const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const receiverAddress = new Address(receiver);
        const receiverHex = receiverAddress.hex();
        const qtyHex = BigInt(qty).toString(16).padStart(2, '0');
        const dataField = `${endpoint}@${receiverHex}@${qtyHex}`;

        const baseGas = BigInt(17000000);
        const additionalGasPerMint = BigInt(8000000);
        const gasLimit = baseGas + BigInt(qty - 1) * additionalGasPerMint;

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

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

        const finalStatus = await checkTransactionStatus(txHash.toString());
        return finalStatus;
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        throw new Error('Transaction failed: ' + error.message);
    }
};

// Function for free NFT mint airdrop
app.post('/execute/freeNftMintAirdrop', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        if (!scAddress || !endpoint || !receiver || !qty || qty <= 0) {
            return res.status(400).json({ error: 'Invalid input parameters' });
        }

        const pemContent = getPemContent(req);
        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint for distributing rewards to NFT owners
app.post('/execute/distributeRewardsToNftOwners', checkToken, handleUsageFee, async (req, res) => {
    try {
        const pemContent = getPemContent(req);
        const { uniqueOwnerStats, tokenTicker, baseAmount, multiply } = req.body;

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

        const createTransaction = (owner, tokensCount, nonce) => {
            const adjustedAmount = multiplierEnabled
                ? convertAmountToBlockchainValue(baseAmount * tokensCount, decimals)
                : convertAmountToBlockchainValue(baseAmount, decimals);

            const receiverAddress = new Address(owner);
            const tokenTransfer = new TokenTransfer({
                token: new Token({ identifier: tokenTicker }),
                amount: BigInt(adjustedAmount),
            });

            const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
            const factory = new TransferTransactionsFactory({ config: factoryConfig });

            const tx = factory.createTransactionForESDTTokenTransfer({
                sender: senderAddress,
                receiver: receiverAddress,
                tokenTransfers: [tokenTransfer],
            });

            tx.nonce = nonce;
            tx.gasLimit = BigInt(500000);

            return tx;
        };

        for (let i = 0; i < uniqueOwnerStats.length; i += 3) {
            const batch = uniqueOwnerStats.slice(i, i + 3);
            const batchPromises = batch.map((ownerData, index) => {
                const tx = createTransaction(
                    ownerData.owner,
                    ownerData.tokensCount,
                    currentNonce + index
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

            const batchResults = await Promise.all(batchPromises);
            txHashes.push(...batchResults);

            if (i + 3 < uniqueOwnerStats.length) {
                await wait(1000);
            }

            currentNonce += batch.length;
        }

        const statusResults = await pollTransactionStatuses(txHashes);

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

// --------------- WebSocket Listener for MultiversX Events --------------- //

// Store user-defined filters (from make.com)
let eventFilters = {};

// API endpoint to receive event filters from make.com
app.post('/subscribe/events', checkToken, (req, res) => {
    try {
        eventFilters = req.body; // e.g., { address: "erd1...", direction: "from", function_type: "ESDTTransfer", asset_identifier: "WEED-123", threshold: 1000 }
        console.log('Event filters updated:', eventFilters);
        res.status(200).json({ message: 'Subscribed to MultiversX events' });
    } catch (error) {
        console.error('Error subscribing to events:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// Initialize WebSocket connection to MultiversX
const ws = new WebSocket('wss://gateway.multiversx.com/ws');

ws.on('open', () => {
    console.log('Connected to MultiversX WebSocket');
    ws.send(JSON.stringify({ method: 'subscribe', topic: 'transaction' })); // Subscribe to all transactions
});

ws.on('message', async (data) => {
    try {
        const event = JSON.parse(data);
        const tx = event.data?.transaction;
        if (!tx || !eventFilters || Object.keys(eventFilters).length === 0) return;

        // Decode transaction data (Base64) to check function type and asset identifier
        const dataStr = tx.data ? Buffer.from(tx.data, 'base64').toString() : '';
        const sender = tx.sender;
        const receiver = tx.receiver;

        // Match address (wallet or smart contract)
        const matchesAddress = !eventFilters.address || 
            [sender, receiver].includes(eventFilters.address) ||
            (tx.smartContractResults?.address === eventFilters.address);

        // Match direction
        let matchesDirection = true;
        if (eventFilters.direction === 'from' && sender !== eventFilters.address) matchesDirection = false;
        if (eventFilters.direction === 'to' && receiver !== eventFilters.address) matchesDirection = false;
        if (eventFilters.direction === 'both' && !([sender, receiver].includes(eventFilters.address))) matchesDirection = false;

        // Match function type
        const matchesFunction = !eventFilters.function_type || 
            dataStr.includes(eventFilters.function_type);

        // Match asset identifier
        const matchesAsset = !eventFilters.asset_identifier || 
            (dataStr.includes(eventFilters.asset_identifier) || 
             (tx.value && eventFilters.asset_identifier === 'EGLD'));

        // Match threshold (for amounts)
        let matchesThreshold = true;
        if (eventFilters.threshold) {
            const amount = tx.value ? parseInt(tx.value) : // EGLD
                (dataStr.match(/@(\d+)/) ? parseInt(dataStr.match(/@(\d+)/)[1]) : 0); // ESDT/NFT amount
            matchesThreshold = amount >= eventFilters.threshold;
        }

        // If all filters match, send event to make.com webhook
        if (matchesAddress && matchesDirection && matchesFunction && matchesAsset && matchesThreshold) {
            console.log('Event matched:', tx);
            await axios.post(MAKE_WEBHOOK_URL, {
                event: tx,
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('Error processing WebSocket event:', error.message);
    }
});

ws.on('error', (err) => console.error('WebSocket error:', err));

ws.on('close', () => {
    console.log('WebSocket connection closed. Attempting to reconnect...');
    setTimeout(() => {
        ws.reconnect(); // Attempt to reconnect (you may need to implement reconnection logic)
    }, 5000);
});

// Helper function to convert number to hex (used in Meta-ESDT)
const toHex = (num) => {
    return BigInt(num).toString(16).padStart(2, '0');
};

// Admin routes
app.use('/admin', adminRoutes);

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
