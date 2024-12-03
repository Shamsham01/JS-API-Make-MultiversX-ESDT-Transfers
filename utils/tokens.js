const axios = require('axios');
const BigNumber = require('bignumber.js');
const NodeCache = require('node-cache');

// Constants
const API_BASE_URL = process.env.API_PROVIDER || "https://api.multiversx.com";
const tokenCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 }); // Cache for 1 hour

/**
 * Fetch token decimals
 * @param {string} tokenTicker - The token ticker (e.g., "REWARD-cf6eac")
 * @returns {Promise<number>} - The number of decimals for the token
 */
const getTokenDecimals = async (tokenTicker) => {
    try {
        if (!tokenTicker) throw new Error("Token ticker is required");

        // Check if decimals are cached
        const cachedDecimals = tokenCache.get(tokenTicker);
        if (cachedDecimals) {
            return cachedDecimals;
        }

        const apiUrl = `${API_BASE_URL}/tokens/${tokenTicker}`;
        const response = await axios.get(apiUrl);

        if (!response.data || typeof response.data.decimals !== "number") {
            throw new Error(`Invalid token data received for ${tokenTicker}`);
        }

        const decimals = response.data.decimals;

        // Cache the decimals
        tokenCache.set(tokenTicker, decimals);

        return decimals;
    } catch (error) {
        console.error(`Error fetching decimals for token ${tokenTicker}:`, error.message);
        throw new Error('Unable to retrieve token decimals. Please try again later.');
    }
};

/**
 * Convert human-readable amount to blockchain value
 * @param {string|number} amount - The human-readable amount
 * @param {number} decimals - The number of decimals for the token
 * @returns {string} - The blockchain value as a string
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
 * @returns {string} - The human-readable amount as a string
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
