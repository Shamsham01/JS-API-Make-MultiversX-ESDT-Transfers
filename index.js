const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const axios = require('axios');
const {
  Address,
  Token,
  TokenTransfer,
  TransferTransactionsFactory,
  TransactionsFactoryConfig,
  Transaction,
  TransactionPayload,
} = require('@multiversx/sdk-core');
const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const { UserSigner } = require('@multiversx/sdk-wallet');
const BigNumber = require('bignumber.js');
const { bech32 } = require('bech32');

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;

const publicApi = {
  mainnet: 'https://api.multiversx.com',
  devnet: 'https://devnet-api.multiversx.com',
};
const chain = process.env.CHAIN || 'mainnet';
const provider = new ProxyNetworkProvider(publicApi[chain], { clientName: 'javascript-api' });

app.use(bodyParser.json());

// Middleware to check authorization token
const checkToken = (req, res, next) => {
  const token = req.headers.authorization;
  if (token === `Bearer ${SECURE_TOKEN}`) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// Get PEM content from request
const getPemContent = (req) => {
  const pemContent = req.body.walletPem;
  if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error('Invalid PEM content');
  }
  return pemContent;
};

// Transaction polling to check status
const checkTransactionStatus = async (txHash, retries = 20, delay = 7000) => {
  for (let i = 0; i < retries; i++) {
    const txStatusUrl = `${publicApi[chain]}/transactions/${txHash}`;
    const response = await fetch(txStatusUrl);
    const txStatus = await response.json();

    if (txStatus.status === 'success') {
      return { status: 'success', txHash };
    } else if (txStatus.status === 'fail') {
      throw new Error(`Transaction ${txHash} failed.`);
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`Transaction ${txHash} not confirmed after ${retries} retries.`);
};

// Utility for gas calculations
const calculateEsdtGasLimit = () => BigInt(500000);
const calculateNftGasLimit = (qty) => 15000000 * qty;
const calculateSftGasLimit = (qty) => 500000 * qty;
const toHex = (number) => BigInt(number).toString(16).padStart(2, '0');

// Convert EGLD to WEI
const convertEGLDToWEI = (amount) => new BigNumber(amount).multipliedBy(new BigNumber(10).pow(18)).toFixed(0);

// Convert Bech32 address to Hex
const convertBech32ToHex = (bech32Address) => {
  const decoded = bech32.decode(bech32Address);
  return Buffer.from(bech32.fromWords(decoded.words)).toString('hex');
};

// String to Hex conversion
const stringToHex = (str) => Buffer.from(str, 'utf8').toString('hex');

// EGLD Transfer
app.post('/execute/egldTransfer', checkToken, async (req, res) => {
  try {
    const { recipient, amount } = req.body;
    const pemContent = getPemContent(req);
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const senderNonce = accountOnNetwork.nonce;

    const amountInWEI = convertEGLDToWEI(amount);
    const factoryConfig = new TransactionsFactoryConfig({ chainID: chain === 'mainnet' ? '1' : 'D' });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForNativeTokenTransfer({
      sender: senderAddress,
      receiver: receiverAddress,
      nativeAmount: BigInt(amountInWEI),
    });

    tx.nonce = senderNonce;
    tx.gasLimit = 50000n;

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    const finalStatus = await checkTransactionStatus(txHash.toString());
    res.json({ result: finalStatus });
  } catch (error) {
    console.error('Error executing EGLD transaction:', error);
    res.status(500).json({ error: error.message });
  }
});

// ESDT Transfer
app.post('/execute/esdtTransfer', checkToken, async (req, res) => {
  try {
    const { recipient, amount, tokenTicker } = req.body;
    const pemContent = getPemContent(req);
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const response = await fetch(`${publicApi[chain]}/tokens/${tokenTicker}`);
    if (!response.ok) throw new Error(`Failed to fetch token info: ${response.statusText}`);
    const tokenInfo = await response.json();
    const decimals = tokenInfo.decimals || 0;

    const convertedAmount = new BigNumber(amount).multipliedBy(new BigNumber(10).pow(decimals)).toFixed(0);
    const factoryConfig = new TransactionsFactoryConfig({ chainID: chain === 'mainnet' ? '1' : 'D' });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
      sender: senderAddress,
      receiver: receiverAddress,
      tokenTransfers: [
        new TokenTransfer({
          token: new Token({ identifier: tokenTicker }),
          amount: BigInt(convertedAmount),
        }),
      ],
    });

    tx.nonce = nonce;
    tx.gasLimit = calculateEsdtGasLimit();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    const finalStatus = await checkTransactionStatus(txHash.toString());
    res.json({ result: finalStatus });
  } catch (error) {
    console.error('Error executing ESDT transaction:', error);
    res.status(500).json({ error: error.message });
  }
});

// NFT Transfer
app.post('/execute/nftTransfer', checkToken, async (req, res) => {
  try {
    const { recipient, tokenIdentifier, tokenNonce } = req.body;
    const pemContent = getPemContent(req);
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const senderNonce = accountOnNetwork.nonce;

    const factoryConfig = new TransactionsFactoryConfig({ chainID: chain === 'mainnet' ? '1' : 'D' });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
      sender: senderAddress,
      receiver: receiverAddress,
      tokenTransfers: [
        new TokenTransfer({
          token: new Token({ identifier: tokenIdentifier, nonce: BigInt(tokenNonce) }),
          amount: BigInt(1),
        }),
      ],
    });

    tx.nonce = senderNonce;
    tx.gasLimit = BigInt(calculateNftGasLimit(1));

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    const finalStatus = await checkTransactionStatus(txHash.toString());
    res.json({ result: finalStatus });
  } catch (error) {
    console.error('Error executing NFT transaction:', error);
    res.status(500).json({ error: error.message });
  }
});

// SFT Transfer
app.post('/execute/sftTransfer', checkToken, async (req, res) => {
  try {
    const { recipient, amount, tokenTicker, tokenNonce } = req.body;
    const pemContent = getPemContent(req);
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const senderNonce = accountOnNetwork.nonce;

    const factoryConfig = new TransactionsFactoryConfig({ chainID: chain === 'mainnet' ? '1' : 'D' });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
      sender: senderAddress,
      receiver: receiverAddress,
      tokenTransfers: [
        new TokenTransfer({
          token: new Token({ identifier: tokenTicker, nonce: BigInt(tokenNonce) }),
          amount: BigInt(amount),
        }),
      ],
    });

    tx.nonce = senderNonce;
    tx.gasLimit = BigInt(calculateSftGasLimit(amount));

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    const finalStatus = await checkTransactionStatus(txHash.toString());
    res.json({ result: finalStatus });
  } catch (error) {
    console.error('Error executing SFT transaction:', error);
    res.status(500).json({ error: error.message });
  }
});

// SC Call
app.post('/execute/scCall', checkToken, async (req, res) => {
  try {
    const { scAddress, actionType, endpoint, receiver, tokenTicker, qty } = req.body;
    const pemContent = getPemContent(req);

    const dataField = await constructProposeAsyncCallPayload(scAddress, receiver, tokenTicker, qty);
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const senderNonce = accountOnNetwork.nonce;

    const tx = new Transaction({
      nonce: senderNonce,
      receiver: new Address(scAddress),
      sender: senderAddress,
      value: '0',
      gasLimit: 10000000n,
      data: new TransactionPayload(dataField),
      chainID: chain === 'mainnet' ? '1' : 'D',
    });

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    const finalStatus = await checkTransactionStatus(txHash.toString());
    res.json({ result: finalStatus });
  } catch (error) {
    console.error('Error executing SC call:', error);
    res.status(500).json({ error: error.message });
  }
});

// Multi-Token Transfer
app.post('/execute/multiTokenTransfer', checkToken, async (req, res) => {
  try {
    const { walletPem, recipient, tokens } = req.body;

    if (!walletPem || !recipient || !tokens || !Array.isArray(tokens)) {
      return res.status(400).json({ error: 'Invalid request payload' });
    }

    const signer = UserSigner.fromPem(walletPem);
    const senderAddress = signer.getAddress();

    const tokenTransfers = await Promise.all(
  tokens.map(async (token) => {
    const tokenIdSegmentsLength = token.id.split('-').length;

    let tokenData;
    if (tokenIdSegmentsLength === 2) {
      // Fungible Token (ESDT)
      const { data } = await axios.get(`${publicApi[chain]}/tokens/${token.id}`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      tokenData = data;
    } else if (tokenIdSegmentsLength === 3) {
      // Non-Fungible or Semi-Fungible Token (NFT or SFT)
      const { data } = await axios.get(`${publicApi[chain]}/nfts/${token.id}`, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      tokenData = data;
    } else {
      throw new Error(`Invalid token ID format: ${token.id}`);
    }

    const { nonce, decimals, ticker, type } = tokenData;

    if (type === 'FungibleESDT') {
      return TokenTransfer.fungibleFromAmount(token.id, token.amount, decimals);
    }

    if (type === 'NonFungibleESDT') {
      return TokenTransfer.nonFungible(ticker, nonce);
    }

    if (type === 'SemiFungibleESDT') {
      return TokenTransfer.semiFungible(ticker, nonce, token.amount);
    }

    if (type === 'MetaESDT') {
      return TokenTransfer.metaEsdtFromAmount(ticker, nonce, token.amount, decimals);
    }

    throw new Error(`Unsupported token type: ${type}`);
  })
);

    const factory = new TransferTransactionsFactory(new TransactionsFactoryConfig({ chainID: chain === 'mainnet' ? '1' : 'D' }));
    const tx = factory.createMultiESDTNFTTransfer({
      tokenTransfers,
      sender: senderAddress,
      destination: new Address(recipient),
    });

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    res.json({ message: 'Transaction submitted', txHash: txHash.toString() });
  } catch (error) {
    console.error('Error during multi-token transfer:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
