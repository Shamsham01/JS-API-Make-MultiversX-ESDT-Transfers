const { ApiNetworkProvider } = require('@multiversx/sdk-network-providers');
const BigNumber = require('bignumber.js');

// Constants
const API_BASE_URL = "https://api.multiversx.com";
const provider = new ApiNetworkProvider(API_BASE_URL); // Replacing manual fetch calls with SDK provider
const tokenDecimalsCache = {}; // In-memory cache for token decimals

/**
 * Fetch token decimals
 * @param {string} tokenTicker - The token identifier (e.g., "REWARD-cf6eac")
 * @returns {Promise<number>} - Token decimals
 */
const getTokenDecimals = async (tokenTicker) => {
    try {
        // Check if decimals are cached
        if (tokenDecimalsCache[tokenTicker]) {
            return tokenDecimalsCache[tokenTicker];
        }

        // Fetch token information using MultiversX SDK
        const tokenInfo = await provider.getToken(tokenTicker);
        const decimals = tokenInfo.decimals || 0;

        // Cache the decimals
        tokenDecimalsCache[tokenTicker] = decimals;

        return decimals;
    } catch (error) {
        console.error(`Error fetching decimals for token ${tokenTicker}:`, error.message);
        throw new Error('Unable to retrieve token decimals. Please try again later.');
    }
};

/**
 * Convert human-readable amount to blockchain value
 * @param {number|string} amount - The human-readable amount
 * @param {number} decimals - The number of decimals for the token
 * @returns {string} - Blockchain value as a string
 */
const convertAmountToBlockchainValue = (amount, decimals) => {
    try {
        const factor = new BigNumber(10).pow(decimals);
        return new BigNumber(amount).multipliedBy(factor).toFixed(0);
    } catch (error) {
        console.error('Error converting amount to blockchain value:', error.message);
        throw new Error('Invalid amount or decimals provided for conversion.');
    }
};

/**
 * Convert blockchain value to human-readable amount
 * @param {string|number} value - The blockchain value
 * @param {number} decimals - The number of decimals for the token
 * @returns {string} - Human-readable amount
 */
const convertBlockchainValueToAmount = (value, decimals) => {
    try {
        const factor = new BigNumber(10).pow(decimals);
        return new BigNumber(value).dividedBy(factor).toFixed(decimals);
    } catch (error) {
        console.error('Error converting blockchain value to amount:', error.message);
        throw new Error('Invalid value or decimals provided for conversion.');
    }
};

module.exports = {
    getTokenDecimals,
    convertAmountToBlockchainValue,
    convertBlockchainValueToAmount,
};
