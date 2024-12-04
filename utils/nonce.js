const { ProxyNetworkProvider } = require('@multiversx/sdk-network-providers');
const provider = new ProxyNetworkProvider(process.env.API_BASE_URL || "https://api.multiversx.com");

let currentNonceCache = {};

/**
 * Fetches the current nonce from the blockchain or the local cache.
 * @param {string} address - The sender's wallet address.
 * @param {boolean} refresh - If true, fetches the latest nonce from the chain.
 * @returns {number} - The nonce to use.
 */
const getNonce = async (address, refresh = false) => {
    if (refresh || !currentNonceCache[address]) {
        const account = await provider.getAccount(address);
        currentNonceCache[address] = account.nonce;
    }
    return currentNonceCache[address];
};

/**
 * Increment and lock the nonce for the address.
 * @param {string} address - The sender's wallet address.
 * @returns {number} - The incremented nonce.
 */
const incrementNonce = (address) => {
    if (!currentNonceCache[address]) {
        throw new Error(`Nonce for address ${address} is not initialized.`);
    }
    return ++currentNonceCache[address];
};

module.exports = {
    getNonce,
    incrementNonce,
};
