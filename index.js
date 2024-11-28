// Helper function to convert numbers to Hexadecimal
const toHex = (number) => {
    return BigInt(number).toString(16).padStart(2, '0');
};

// --------------- NFT Transfer Logic --------------- //
const sendNftToken = async (pemContent, recipient, tokenIdentifier, tokenNonce) => {
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
                amount: BigInt(1), // Always transfer 1 NFT
            }),
        ],
    });

    tx.nonce = senderNonce;
    tx.gasLimit = calculateEsdtGasLimit();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

app.post('/execute/nftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, tokenIdentifier, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendNftToken(pemContent, recipient, tokenIdentifier, tokenNonce);
        res.json({
            result,
            usageFeeHash: req.usageFeeHash,
        });
    } catch (error) {
        console.error('Error executing NFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- SFT Transfer Logic --------------- //
const sendSftToken = async (pemContent, recipient, amount, tokenTicker, nonce) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(recipient);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const accountNonce = accountOnNetwork.nonce;

    const adjustedAmount = BigInt(amount);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: tokenTicker, nonce: BigInt(nonce) }),
                amount: adjustedAmount,
            }),
        ],
    });

    tx.nonce = accountNonce;
    tx.gasLimit = calculateEsdtGasLimit();

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

app.post('/execute/sftTransfer', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { recipient, amount, tokenTicker, tokenNonce } = req.body;
        const pemContent = getPemContent(req);

        const result = await sendSftToken(pemContent, recipient, amount, tokenTicker, tokenNonce);
        res.json({
            result,
            usageFeeHash: req.usageFeeHash,
        });
    } catch (error) {
        console.error('Error executing SFT transaction:', error);
        res.status(500).json({ error: error.message });
    }
});

// --------------- Rewards Distribution to NFT Owners --------------- //
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
            tx.gasLimit = calculateEsdtGasLimit();

            return tx;
        };

        for (let i = 0; i < uniqueOwnerStats.length; i += 3) {
            const batch = uniqueOwnerStats.slice(i, i + 3);
            const batchPromises = batch.map((ownerData, index) => {
                const tx = createTransaction(
                    ownerData.owner,
                    ownerData.tokensCount,
                    currentNonce + index,
                );

                return signer.sign(tx).then(async () => {
                    const txHash = await provider.sendTransaction(tx);
                    return { owner: ownerData.owner, txHash: txHash.toString() };
                }).catch(error => ({
                    owner: ownerData.owner,
                    error: error.message,
                    status: "failed",
                }));
            });

            const batchResults = await Promise.all(batchPromises);
            txHashes.push(...batchResults);

            if (i + 3 < uniqueOwnerStats.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const statusPromises = txHashes.map(({ owner, txHash }) =>
            checkTransactionStatus(txHash)
                .then(status => ({ owner, txHash, status: status.status }))
                .catch(error => ({ owner, txHash, error: error.message, status: 'failed' }))
        );

        const statusResults = await Promise.all(statusPromises);

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

// --------------- NFT Free Mint Airdrop --------------- //
const executeFreeNftMintAirdrop = async (pemContent, scAddress, endpoint, receiver, qty) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();

    const receiverAddress = new Address(receiver);
    const dataField = `${endpoint}@${receiverAddress.hex()}@${toHex(qty)}`;

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const senderNonce = accountOnNetwork.nonce;

    const tx = new Transaction({
        nonce: senderNonce,
        receiver: new Address(scAddress),
        sender: senderAddress,
        value: '0',
        gasLimit: BigInt(10000000),
        data: new TransactionPayload(dataField),
        chainID: '1',
    });

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);
    return await checkTransactionStatus(txHash.toString());
};

app.post('/execute/freeNftMintAirdrop', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { scAddress, endpoint, receiver, qty } = req.body;
        const pemContent = getPemContent(req);

        const result = await executeFreeNftMintAirdrop(pemContent, scAddress, endpoint, receiver, qty);
        res.json({ result, usageFeeHash: req.usageFeeHash });
    } catch (error) {
        console.error('Error executing free NFT mint airdrop:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
